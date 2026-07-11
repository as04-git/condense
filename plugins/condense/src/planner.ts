import { collectReferencedContentIds, makeV3Object, omissionNotice, type V3OmissionObject } from "./omission";
import { pruneToolInputWithId } from "./prune";
import { sha256, type CandidateManifestItem, type PrepareDecision } from "./protocol";
import { isRecord, isToolResultRow, type JsonRecord, type TranscriptRow } from "./transcript";

export type RetentionCounts = {
  thinkingKept: number;
  thinkingDropped: number;
  externalized: { toolInputs: number; toolOutputs: number; agentResults: number; skills: number; injections: number };
  inline: { toolInputs: number; toolOutputs: number; agentResults: number; skills: number; injections: number };
};

export type AppliedRetention = {
  rows: TranscriptRow[];
  droppedRows: Set<string>;
  objects: V3OmissionObject[];
  counts: RetentionCounts;
  droppedThinkingTurns: Set<number>;
  keptThinkingTurns: Set<number>;
};

export type Projection = AppliedRetention & {
  sourceChars: number;
  projectedChars: number;
  markerText: string;
  lineageIds: string[];
};

function emptyCounts(): RetentionCounts {
  return {
    thinkingKept: 0,
    thinkingDropped: 0,
    externalized: { toolInputs: 0, toolOutputs: 0, agentResults: 0, skills: 0, injections: 0 },
    inline: { toolInputs: 0, toolOutputs: 0, agentResults: 0, skills: 0, injections: 0 },
  };
}

export function validateDecision(
  decision: Pick<PrepareDecision, "keep" | "drop">,
  candidates: CandidateManifestItem[],
): void {
  const byRef = new Map(candidates.map((candidate) => [candidate.ref, candidate]));
  const keepSet = new Set(decision.keep);
  const dropSet = new Set(decision.drop);
  for (const ref of keepSet) {
    const candidate = byRef.get(ref);
    if (!candidate) throw new Error(`Unknown keep ref ${ref}`);
    if (candidate.action !== "keep") throw new Error(`Ref ${ref} is governed by ${candidate.action}, not keep`);
  }
  for (const ref of dropSet) {
    const candidate = byRef.get(ref);
    if (!candidate) throw new Error(`Unknown drop ref ${ref}`);
    if (candidate.action !== "drop") throw new Error(`Ref ${ref} is governed by ${candidate.action}, not drop`);
    if (keepSet.has(ref)) throw new Error(`Ref ${ref} appears in both keep and drop`);
  }
}

export function shouldKeepCandidate(
  candidate: CandidateManifestItem,
  decision: Pick<PrepareDecision, "keep" | "drop">,
): boolean {
  if (candidate.action === "keep") return decision.keep.includes(candidate.ref);
  if (candidate.action === "drop") return !decision.drop.includes(candidate.ref);
  return candidate.defaultKeep;
}

function countBucket(counts: RetentionCounts, candidate: CandidateManifestItem, keep: boolean): void {
  if (candidate.class === "thinking") return;
  const target = keep ? counts.inline : counts.externalized;
  if (candidate.kind === "tool-input") target.toolInputs++;
  else if (candidate.kind === "agent-result") target.agentResults++;
  else if (candidate.kind === "skill") target.skills++;
  else if (candidate.kind === "injected") target.injections++;
  else target.toolOutputs++;
}

function stringifyContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

function toolMaps(rows: TranscriptRow[]): { names: Map<string, string>; inputs: Map<string, JsonRecord> } {
  const names = new Map<string, string>();
  const inputs = new Map<string, JsonRecord>();
  for (const row of rows) {
    if (!isRecord(row.message) || !Array.isArray(row.message["content"])) continue;
    for (const block of row.message["content"]) {
      if (!isRecord(block) || block["type"] !== "tool_use" || typeof block["id"] !== "string") continue;
      names.set(block["id"], String(block["name"] ?? "?"));
      if (isRecord(block["input"])) inputs.set(block["id"], block["input"]);
    }
  }
  return { names, inputs };
}

export function contextChars(rows: Array<JsonRecord | TranscriptRow>): number {
  return rows.reduce(
    (sum, row) => sum + (isRecord(row["message"]) ? JSON.stringify(row["message"]["content"] ?? "").length : 0),
    0,
  );
}

export function contextContentDigest(rows: Array<JsonRecord | TranscriptRow>, appendedMarker?: string): string {
  const content = rows.flatMap((row) =>
    isRecord(row["message"]) ? [{ type: row["type"], content: (row["message"] as JsonRecord)["content"] }] : [],
  );
  if (appendedMarker !== undefined) content.push({ type: "user", content: appendedMarker });
  return sha256(content);
}

export function applyRetention(args: {
  rows: TranscriptRow[];
  candidates: CandidateManifestItem[];
  decision: Pick<PrepareDecision, "keep" | "drop">;
  omissionIds: Record<string, string>;
  activeOriginalUuids: Set<string>;
  originalUuid: (row: TranscriptRow) => string;
}): AppliedRetention {
  validateDecision(args.decision, args.candidates);
  const rows = structuredClone(args.rows) as TranscriptRow[];
  const candidates = new Map(args.candidates.map((candidate) => [candidate.ref, candidate]));
  const counts = emptyCounts();
  const objects: V3OmissionObject[] = [];
  const droppedRows = new Set<string>();
  const droppedThinkingTurns = new Set<number>();
  const keptThinkingTurns = new Set<number>();
  const maps = toolMaps(rows);

  for (const row of rows) {
    const originalUuid = args.originalUuid(row);
    if (!args.activeOriginalUuids.has(originalUuid)) continue;
    if (row["condenseMarker"] === true) {
      droppedRows.add(row.uuid);
      continue;
    }
    if (!isRecord(row.message) || !Array.isArray(row.message["content"])) continue;
    const content = row.message["content"];
    if (row.type === "assistant") {
      const filtered = content.filter((block, blockIndex) => {
        if (!isRecord(block) || block["type"] !== "thinking") return true;
        const candidate = candidates.get(`t:${originalUuid}#${blockIndex}`);
        if (!candidate) return true;
        const keep = shouldKeepCandidate(candidate, args.decision);
        if (keep) {
          counts.thinkingKept++;
          keptThinkingTurns.add(candidate.turn);
        } else {
          counts.thinkingDropped++;
          droppedThinkingTurns.add(candidate.turn);
        }
        return keep;
      });
      row.message["content"] = filtered;
      for (const block of filtered) {
        if (!isRecord(block) || block["type"] !== "tool_use" || typeof block["id"] !== "string") continue;
        const candidate = candidates.get(`i:${block["id"]}`);
        if (!candidate) continue;
        const keep = shouldKeepCandidate(candidate, args.decision);
        countBucket(counts, candidate, keep);
        if (keep) continue;
        const contentId = args.omissionIds[candidate.ref];
        if (!contentId) throw new Error(`Prepared plan is missing an omission ID for ${candidate.ref}`);
        const omitted = pruneToolInputWithId(block, contentId);
        if (!omitted) throw new Error(`Prepared tool-input mutation no longer applies to ${candidate.ref}`);
        objects.push(makeV3Object(contentId, omitted.value, { kind: omitted.kind, metadata: omitted.metadata }));
      }
      if (Array.isArray(row.message["content"]) && row.message["content"].length === 0) droppedRows.add(row.uuid);
    } else if (isToolResultRow(row)) {
      for (const block of content) {
        if (!isRecord(block) || block["type"] !== "tool_result" || typeof block["tool_use_id"] !== "string") continue;
        const candidate = candidates.get(`o:${block["tool_use_id"]}`);
        if (!candidate) continue;
        const keep = shouldKeepCandidate(candidate, args.decision);
        countBucket(counts, candidate, keep);
        if (keep) continue;
        const contentId = args.omissionIds[candidate.ref];
        if (!contentId) throw new Error(`Prepared plan is missing an omission ID for ${candidate.ref}`);
        const value = block["content"];
        const input = maps.inputs.get(block["tool_use_id"]);
        objects.push(
          makeV3Object(contentId, value, {
            kind: candidate.kind === "agent-result" ? "agent-result" : "tool-output",
            metadata: {
              toolName: maps.names.get(block["tool_use_id"]) ?? "?",
              toolUseId: block["tool_use_id"],
              path: input?.["file_path"] ?? input?.["notebook_path"],
              command: typeof input?.["command"] === "string" ? input["command"].slice(0, 200) : undefined,
              isError: block["is_error"] === true,
            },
          }),
        );
        block["content"] = omissionNotice(candidate.notice, stringifyContent(value).length, contentId);
      }
    } else if (row.type === "user") {
      const candidate = candidates.get(`s:${originalUuid}`);
      if (!candidate) continue;
      const keep = shouldKeepCandidate(candidate, args.decision);
      countBucket(counts, candidate, keep);
      if (keep) continue;
      const contentId = args.omissionIds[candidate.ref];
      if (!contentId) throw new Error(`Prepared plan is missing an omission ID for ${candidate.ref}`);
      const value = row.message["content"];
      objects.push(
        makeV3Object(contentId, value, {
          kind: candidate.kind === "skill" ? "skill" : "injected",
          metadata: { rowUuid: originalUuid, label: candidate.label },
        }),
      );
      row.message["content"] = [{ type: "text", text: omissionNotice(candidate.notice, candidate.size, contentId) }];
    }
  }
  return { rows, droppedRows, objects, counts, droppedThinkingTurns, keptThinkingTurns };
}

function promptAnchor(turn: number, prompts: Map<number, string>): [number, string] {
  return [turn, prompts.get(turn) || "(no prompt)"];
}

export function markerContents(args: {
  sourceSessionId: string;
  generation: number;
  keepTurns: number;
  sourceChars: number;
  finalChars: number;
  lineageCount: number;
  counts: RetentionCounts;
  droppedThinkingTurns: Set<number>;
  prompts: Map<number, string>;
}): string {
  const dropped = [...args.droppedThinkingTurns].sort((a, b) => a - b).map((turn) => promptAnchor(turn, args.prompts));
  const reclaim = Math.round(((args.sourceChars - args.finalChars) / Math.max(1, args.sourceChars)) * 1000) / 10;
  return [
    `🗜 CONDENSE #${args.generation} | parent ${args.sourceSessionId} | lineage ${args.lineageCount} object(s) | ${args.sourceChars}→${args.finalChars} context chars (${reclaim}% reclaimed)`,
    `PROSE: all user/assistant prose verbatim | RECENT: last ${args.keepTurns} real turn(s) untouched`,
    `THINKING kept ${args.counts.thinkingKept} | dropped ${args.counts.thinkingDropped} [unrecoverable]${dropped.length ? ` ${JSON.stringify(dropped)}` : ""}`,
    `EXTERNALIZED: inputs ${args.counts.externalized.toolInputs} | outputs ${args.counts.externalized.toolOutputs} | agent results ${args.counts.externalized.agentResults} | skills ${args.counts.externalized.skills} | injections ${args.counts.externalized.injections}`,
    `INLINE: inputs ${args.counts.inline.toolInputs} | outputs ${args.counts.inline.toolOutputs} | agent results ${args.counts.inline.agentResults} | skills ${args.counts.inline.skills} | injections ${args.counts.inline.injections}`,
    "RECOVER: search_omitted_content(query[, mode]) searches current lineage; read_omitted_content(contentId[, start, length]) reads bounded exact-value renderings.",
    "Original parent remains unchanged on disk. Do not re-condense unless the user asks.",
  ].join("\n");
}

export function convergeMarker(
  args: Omit<Parameters<typeof markerContents>[0], "finalChars"> & { beforeMarkerChars: number },
): { text: string; finalChars: number } {
  for (let guess = args.beforeMarkerChars; guess < args.beforeMarkerChars + 10000; guess++) {
    const base = markerContents({ ...args, finalChars: guess });
    const baseTotal = args.beforeMarkerChars + JSON.stringify(base).length;
    if (baseTotal <= guess) {
      const text = `${base}${" ".repeat(guess - baseTotal)}`;
      if (args.beforeMarkerChars + JSON.stringify(text).length === guess) return { text, finalChars: guess };
    }
  }
  throw new Error("Marker context accounting did not converge");
}

export function projectRetention(args: {
  rows: TranscriptRow[];
  candidates: CandidateManifestItem[];
  decision: Pick<PrepareDecision, "keep" | "drop">;
  omissionIds: Record<string, string>;
  sourceSessionId: string;
  generation: number;
  keepTurns: number;
  prompts: Map<number, string>;
}): Projection {
  const sourceChars = contextChars(args.rows);
  const activeOriginalUuids = new Set(args.rows.map((row) => row.uuid));
  const applied = applyRetention({
    rows: args.rows,
    candidates: args.candidates,
    decision: args.decision,
    omissionIds: args.omissionIds,
    activeOriginalUuids,
    originalUuid: (row) => row.uuid,
  });
  const rows = applied.rows.filter((row) => !applied.droppedRows.has(row.uuid));
  const lineageIds = collectReferencedContentIds(rows);
  const beforeMarker = contextChars(rows);
  const marker = convergeMarker({
    sourceSessionId: args.sourceSessionId,
    generation: args.generation,
    keepTurns: args.keepTurns,
    sourceChars,
    beforeMarkerChars: beforeMarker,
    lineageCount: lineageIds.length,
    counts: applied.counts,
    droppedThinkingTurns: applied.droppedThinkingTurns,
    prompts: args.prompts,
  });
  return { ...applied, rows, sourceChars, projectedChars: marker.finalChars, markerText: marker.text, lineageIds };
}
