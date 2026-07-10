import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { basename } from "node:path";
import { runAnalyze } from "./analyze";
import { DEFAULT_CONFIG, type CondenseConfig, type PolicyClass, type RetentionMode } from "./config";
import { forkForCondense } from "./fork";
import {
  allocateOmission, collectReferencedContentIds, loadOmissionCache, noticeOverhead,
  outputOmissionNotice, saveManifest, saveOmissionCache, type OmissionCache,
} from "./omission";
import {
  bigInputSize, hasPrunedInput, injectedInfo, isCondenseNotice, pruneToolInput,
} from "./prune";
import {
  decodeReceipt, digestCandidates, digestSource, parseBuildDecision,
  type CandidateManifestItem,
} from "./protocol";
import {
  buildAssistantTurns, isRecord, isToolResultRow, readActiveTranscriptRows,
  validateCondenseSuffix, writeTranscriptEntries, type JsonRecord, type TranscriptRow,
} from "./transcript";

const OUTPUT_FLOOR_CHARS = 1000;

type Stats = {
  thinkingKept: number; thinkingDropped: number;
  toolInputsKept: number; toolInputsPruned: number; toolInputsPrePruned: number;
  toolOutputsKept: number; toolOutputsPruned: number; toolOutputsPrePruned: number;
  agentResultsKept: number; agentResultsPruned: number; agentResultsPrePruned: number;
  skillsKept: number; skillsPruned: number; injectionsKept: number; injectionsPruned: number;
  emptyAssistantRowsDropped: number; priorMarkersDropped: number; skillsNoted: string[];
};

function emptyStats(): Stats {
  return { thinkingKept: 0, thinkingDropped: 0, toolInputsKept: 0, toolInputsPruned: 0, toolInputsPrePruned: 0, toolOutputsKept: 0, toolOutputsPruned: 0, toolOutputsPrePruned: 0, agentResultsKept: 0, agentResultsPruned: 0, agentResultsPrePruned: 0, skillsKept: 0, skillsPruned: 0, injectionsKept: 0, injectionsPruned: 0, emptyAssistantRowsDropped: 0, priorMarkersDropped: 0, skillsNoted: [] };
}

export async function runBuild(sourcePath: string, decisionValue: unknown) {
  const decision = parseBuildDecision(decisionValue);
  const receipt = decodeReceipt(decision.receipt);
  const sourceSessionId = basename(sourcePath, ".jsonl");
  if (receipt.sessionId !== sourceSessionId) throw new Error("Receipt belongs to a different source session");
  const sourceRows = await readActiveTranscriptRows(sourcePath);
  validateCondenseSuffix(sourceRows, receipt.cutoffUuid);
  if (digestSource(sourceRows, receipt.cutoffUuid) !== receipt.sourceDigest) throw new Error("Source transcript prefix changed after analyze");

  const config: CondenseConfig = {
    ...DEFAULT_CONFIG,
    keepTurns: receipt.keepTurns,
    policies: { ...receipt.policies },
    retrieval: { ...DEFAULT_CONFIG.retrieval },
  };
  const analysis = runAnalyze(sourceRows, config, { sessionId: sourceSessionId, cutoffUuid: receipt.cutoffUuid });
  if (digestCandidates(analysis.candidateManifest) !== receipt.candidateDigest) throw new Error("Candidate manifest changed after analyze");
  validateDecision(decision.keep, decision.drop, analysis.candidateManifest);
  const manifest = new Map(analysis.candidateManifest.map((item) => [item.ref, item]));
  const keepRefs = new Set(decision.keep); const dropRefs = new Set(decision.drop);
  const shouldKeep = (ref: string): boolean => {
    const item = manifest.get(ref);
    if (!item) return true;
    const policy = receipt.policies[item.class];
    if (policy === "keep-all") return true;
    if (policy === "drop-all") return false;
    if (policy === "keep-ranked") return keepRefs.has(ref);
    return !dropRefs.has(ref);
  };

  const cutoffIndex = sourceRows.findIndex((row) => row.uuid === receipt.cutoffUuid);
  const prefixRows = sourceRows.slice(0, cutoffIndex + 1);
  const turns = buildAssistantTurns(prefixRows);
  if (turns.length <= receipt.keepTurns) throw new Error("Nothing to compact: no turns older than keepTurns");
  const preserved = new Set<string>();
  for (const turn of turns.slice(turns.length - receipt.keepTurns)) for (const row of turn.rows) preserved.add(row.uuid);
  const thinkingTurn = thinkingTurnMap(turns);
  const promptByTurn = new Map(analysis.perTurn.map((turn) => [turn.turn, turn.prompt]));
  const thinkingKeptTurns = new Set<number>(); const thinkingDroppedTurns = new Set<number>();

  const titleRows = await readTitleRows(sourcePath);
  const generation = parentGeneration(titleRows) + 1;
  const title = computeCondensedTitle(titleRows, prefixRows, generation, decision.title);
  const fork = await forkForCondense(sourcePath, { upToMessageId: receipt.cutoffUuid, title });
  try {
    const cache = await loadOmissionCache(fork.sessionId);
    const stats = emptyStats();
    const { names: toolNames, inputs: toolInputs } = toolMaps(fork.rows);
    const dropRows = new Set<string>();
    for (const row of fork.rows) {
      if (typeof row.uuid !== "string") continue;
      const ff = row["forkedFrom"];
      if (!isRecord(ff) || typeof ff["messageUuid"] !== "string") throw new Error(`SDK fork row ${row.uuid} is missing forkedFrom.messageUuid`);
      const originalUuid = ff["messageUuid"];
      if (row["condenseMarker"] === true) { dropRows.add(row.uuid); stats.priorMarkersDropped++; continue; }
      const forceKeep = preserved.has(originalUuid);
      if (row.type === "assistant") {
        filterThinking(row, originalUuid, forceKeep, shouldKeep, stats, thinkingTurn, thinkingKeptTurns, thinkingDroppedTurns);
        applyToolInputs(row, forceKeep, shouldKeep, cache, fork.sessionId, stats);
        if (isEmptyMessageContent(row)) { dropRows.add(row.uuid); stats.emptyAssistantRowsDropped++; }
      } else if (isToolResultRow(row)) {
        applyToolOutputs(row, forceKeep, shouldKeep, cache, fork.sessionId, toolNames, toolInputs, stats);
      } else if (row.type === "user") {
        applyInjection(row, originalUuid, forceKeep, shouldKeep, cache, fork.sessionId, stats);
      }
    }

    const parentOf = new Map(fork.rows.map((row) => [row.uuid, row.parentUuid]));
    const resolveParent = (uuid: string | null): string | null => {
      const seen = new Set<string>();
      while (uuid && dropRows.has(uuid)) {
        if (seen.has(uuid)) throw new Error("Cycle while resolving dropped marker parent");
        seen.add(uuid); uuid = parentOf.get(uuid) ?? null;
      }
      return uuid;
    };
    const kept = fork.rows.filter((row) => !dropRows.has(row.uuid));
    for (const row of kept) if (row.parentUuid && dropRows.has(row.parentUuid)) row.parentUuid = resolveParent(row.parentUuid);
    const mappedCutoff = fork.oldToNew.get(receipt.cutoffUuid);
    if (!mappedCutoff) throw new Error("SDK fork did not map the receipt cutoff UUID");
    const markerParent = resolveParent(mappedCutoff);
    if (!markerParent) throw new Error("No surviving marker parent exists");

    const stripped = kept.filter((row) => !["custom-title", "agent-name", "ai-title"].includes(row.type));
    const finalRows: JsonRecord[] = dedupeSingletonMeta(stripped as JsonRecord[]);
    finalRows.push(...makeTitleRows(fork.sessionId, title, generation));
    const lineageIds = collectReferencedContentIds(finalRows);
    const sourceChars = contextChars(prefixRows);
    const beforeMarkerChars = contextChars(finalRows);
    let markerText = "";
    for (let i = 0; i < 10; i++) {
      const previous = markerText;
      markerText = markerContents({ sourceSessionId, generation, keepTurns: receipt.keepTurns, sourceChars, finalChars: beforeMarkerChars + JSON.stringify(markerText).length, lineageCount: lineageIds.length, stats, keptThinking: formatTurnRanges(thinkingKeptTurns, promptByTurn, turns.length - 1), droppedThinking: formatTurnRanges(thinkingDroppedTurns, promptByTurn, turns.length - 1) });
      if (markerText === previous) break;
    }
    const marker = makeMarkerRow(fork.rows, fork.sessionId, markerParent, markerText);
    if (!marker) throw new Error("Could not construct the closing marker");
    finalRows.push(marker);

    const finalChars = contextChars(finalRows);
    if (!markerText.includes(`${sourceChars}→${finalChars} context chars`)) throw new Error("Marker context accounting did not converge");

    await saveOmissionCache(fork.sessionId, cache);
    await saveManifest(fork.sessionId, lineageIds);
    await writeTranscriptEntries(fork.transcriptPath, finalRows);
    return { sessionId: fork.sessionId, transcriptPath: fork.transcriptPath, generation, sourceChars, finalChars, reclaimPct: Math.round(((sourceChars - finalChars) / Math.max(1, sourceChars)) * 1000) / 10, lineageObjects: lineageIds.length, stats };
  } catch (error) {
    await unlink(fork.transcriptPath).catch(() => undefined);
    throw error;
  }
}

function validateDecision(keep: string[], drop: string[], candidates: CandidateManifestItem[]): void {
  const byRef = new Map(candidates.map((item) => [item.ref, item]));
  for (const ref of keep) {
    const item = byRef.get(ref); if (!item) throw new Error(`Unknown keep ref ${ref}`);
    if (item.action !== "keep") throw new Error(`Ref ${ref} is governed by ${item.action}, not keep`);
  }
  for (const ref of drop) {
    const item = byRef.get(ref); if (!item) throw new Error(`Unknown drop ref ${ref}`);
    if (item.action !== "drop") throw new Error(`Ref ${ref} is governed by ${item.action}, not drop`);
  }
}

function thinkingTurnMap(turns: ReturnType<typeof buildAssistantTurns>): Map<string, number> {
  const map = new Map<string, number>();
  turns.forEach((turn, turnIndex) => turn.rows.forEach((row) => {
    if (row.type !== "assistant" || !isRecord(row.message) || !Array.isArray(row.message["content"])) return;
    row.message["content"].forEach((block, index) => { if (isRecord(block) && block["type"] === "thinking") map.set(`t:${row.uuid}#${index}`, turnIndex); });
  }));
  return map;
}

function filterThinking(row: TranscriptRow, originalUuid: string, forceKeep: boolean, shouldKeep: (ref: string) => boolean, stats: Stats, turnMap: Map<string, number>, keptTurns: Set<number>, droppedTurns: Set<number>): void {
  if (!isRecord(row.message) || !Array.isArray(row.message["content"])) return;
  row.message["content"] = row.message["content"].filter((block, index) => {
    if (!isRecord(block) || block["type"] !== "thinking") return true;
    const ref = `t:${originalUuid}#${index}`; const keep = forceKeep || shouldKeep(ref); const turn = turnMap.get(ref);
    if (keep) { stats.thinkingKept++; if (turn !== undefined) keptTurns.add(turn); }
    else { stats.thinkingDropped++; if (turn !== undefined) droppedTurns.add(turn); }
    return keep;
  });
}

function applyToolInputs(row: TranscriptRow, forceKeep: boolean, shouldKeep: (ref: string) => boolean, cache: OmissionCache, sessionId: string, stats: Stats): void {
  if (!isRecord(row.message) || !Array.isArray(row.message["content"])) return;
  for (const block of row.message["content"]) {
    if (!isRecord(block) || block["type"] !== "tool_use") continue;
    if (hasPrunedInput(block)) { stats.toolInputsPrePruned++; continue; }
    if (!bigInputSize(block)) continue;
    const id = typeof block["id"] === "string" ? block["id"] : null;
    if (forceKeep || !id || shouldKeep(`i:${id}`)) { stats.toolInputsKept++; continue; }
    if (pruneToolInput(block, cache, sessionId)) stats.toolInputsPruned++; else stats.toolInputsKept++;
  }
}

function applyToolOutputs(row: TranscriptRow, forceKeep: boolean, shouldKeep: (ref: string) => boolean, cache: OmissionCache, sessionId: string, toolNames: Map<string, string>, toolInputs: Map<string, JsonRecord>, stats: Stats): void {
  if (!isRecord(row.message) || !Array.isArray(row.message["content"])) return;
  for (const block of row.message["content"]) {
    if (!isRecord(block) || block["type"] !== "tool_result") continue;
    const rendered = stringifyContent(block["content"]); const id = typeof block["tool_use_id"] === "string" ? block["tool_use_id"] : null;
    const name = id ? toolNames.get(id) ?? "?" : "?"; const agent = isAgentResult(name, rendered);
    if (isCondenseNotice(rendered)) {
      if (/agent-result/i.test(rendered)) stats.agentResultsPrePruned++; else stats.toolOutputsPrePruned++;
      continue;
    }
    if (!rendered || rendered.length < OUTPUT_FLOOR_CHARS || forceKeep || !id || shouldKeep(`o:${id}`)) {
      if (agent) stats.agentResultsKept++; else stats.toolOutputsKept++; continue;
    }
    const description = smartOutputDescription(name, rendered, id ? toolInputs.get(id) : undefined, agent);
    if (noticeOverhead(description) >= rendered.length) { if (agent) stats.agentResultsKept++; else stats.toolOutputsKept++; continue; }
    const input = id ? toolInputs.get(id) : undefined;
    const contentId = allocateOmission(cache, sessionId, block["content"], { kind: agent ? "agent-result" : "tool-output", metadata: { toolName: name, toolUseId: id, path: input?.["file_path"] ?? input?.["notebook_path"], command: input?.["command"], isError: block["is_error"] === true } });
    block["content"] = outputOmissionNotice(description, rendered.length, contentId);
    if (agent) stats.agentResultsPruned++; else stats.toolOutputsPruned++;
  }
}

function applyInjection(row: TranscriptRow, originalUuid: string, forceKeep: boolean, shouldKeep: (ref: string) => boolean, cache: OmissionCache, sessionId: string, stats: Stats): void {
  const injection = injectedInfo(row); if (!injection || !isRecord(row.message)) return;
  const keep = forceKeep || shouldKeep(`s:${originalUuid}`);
  if (keep) { if (injection.skill) stats.skillsKept++; else stats.injectionsKept++; return; }
  const content = row.message["content"];
  const contentId = allocateOmission(cache, sessionId, content, { kind: injection.skill ? "skill" : "injected", metadata: { skill: injection.skill, rowUuid: originalUuid } });
  if (injection.skill) {
    row.message["content"] = [{ type: "text", text: `[Skill "${injection.skill}" output (${injection.size} chars) omitted by condense. Re-invoke /${injection.skill}; fallback retrieve: ${contentId}]` }];
    stats.skillsPruned++; if (!stats.skillsNoted.includes(injection.skill)) stats.skillsNoted.push(injection.skill);
  } else {
    row.message["content"] = [{ type: "text", text: outputOmissionNotice("injected content omitted", injection.size, contentId) }]; stats.injectionsPruned++;
  }
}

function toolMaps(rows: TranscriptRow[]) {
  const names = new Map<string, string>(); const inputs = new Map<string, JsonRecord>();
  for (const row of rows) {
    if (!isRecord(row.message) || !Array.isArray(row.message["content"])) continue;
    for (const block of row.message["content"]) if (isRecord(block) && block["type"] === "tool_use" && typeof block["id"] === "string") {
      names.set(block["id"], String(block["name"] ?? "?")); if (isRecord(block["input"])) inputs.set(block["id"], block["input"]);
    }
  }
  return { names, inputs };
}

function isAgentResult(toolName: string, text: string): boolean { return /^\s*<task-notification\b/.test(text) || (["Agent", "Task", "TaskOutput"].includes(toolName) && /<(?:summary|result)>/.test(text)); }
function stringifyContent(content: unknown): string { return typeof content === "string" ? content : content === undefined || content === null ? "" : JSON.stringify(content); }
function previewLine(text: string, max = 80): string { const line = text.trim().split("\n")[0]?.trim() ?? ""; return line.length <= max ? line : `${line.slice(0, max).trim()}…`; }
function smartOutputDescription(name: string, text: string, input: JsonRecord | undefined, agent: boolean): string {
  if (agent) { const summary = text.match(/<summary>\s*(?:Agent\s+)?"?([^"<\n]{1,80})/); return `agent-result omitted${summary?.[1] ? ` ("${summary[1].trim()}")` : ""}`; }
  const path = input?.["file_path"] ?? input?.["notebook_path"];
  if (typeof path === "string" && ["Read", "Edit", "Write", "NotebookEdit"].includes(name)) return `${name} output omitted (${path}); reread file`;
  if (name === "Bash" && typeof input?.["command"] === "string") return `Bash output omitted (${previewLine(input["command"], 50)})`;
  return `${name} output omitted${text ? `: "${previewLine(text, 50)}"` : ""}`;
}

function isEmptyMessageContent(row: TranscriptRow): boolean { if (!isRecord(row.message)) return false; const content = row.message["content"]; return Array.isArray(content) ? content.length === 0 : typeof content === "string" && !content.trim(); }
function contextChars(rows: JsonRecord[]): number { return rows.reduce((sum, row) => sum + (isRecord(row["message"]) ? JSON.stringify(row["message"]["content"] ?? "").length : 0), 0); }

function formatTurnRanges(turns: Set<number>, prompts: Map<number, string>, latestTurn: number): string {
  const sorted = [...turns].sort((a, b) => a - b); if (!sorted.length) return "none";
  const ranges: Array<[number, number]> = []; let start = sorted[0]!; let end = start;
  for (const turn of sorted.slice(1)) { if (turn === end + 1) end = turn; else { ranges.push([start, end]); start = end = turn; } } ranges.push([start, end]);
  const anchor = (turn: number) => { const prompt = prompts.get(turn) || "(no prompt)"; return `t${turn} “${prompt.length > 80 ? `${prompt.slice(0, 80).trim()}…` : prompt}”`; };
  return ranges.map(([a, b]) => a === b ? (b === latestTurn ? `${anchor(a)} → latest` : anchor(a)) : `${anchor(a)} → ${b === latestTurn ? "latest" : anchor(b)}`).join("; ");
}

function markerContents(args: { sourceSessionId: string; generation: number; keepTurns: number; sourceChars: number; finalChars: number; lineageCount: number; stats: Stats; keptThinking: string; droppedThinking: string }): string {
  const reclaim = Math.round(((args.sourceChars - args.finalChars) / Math.max(1, args.sourceChars)) * 1000) / 10;
  const s = args.stats;
  return [
    `🗜 CONDENSE #${args.generation} | parent ${args.sourceSessionId} | lineage ${args.lineageCount} object(s) | ${args.sourceChars}→${args.finalChars} context chars (${reclaim}% reclaimed)`,
    `PROSE: all user/assistant prose verbatim | RECENT: last ${args.keepTurns} real turn(s) untouched`,
    `THINKING inline: ${args.keptThinking}`,
    `THINKING dropped [unrecoverable]: ${args.droppedThinking}`,
    `INPUTS inline ${s.toolInputsKept} | newly omitted ${s.toolInputsPruned} | pre-omitted ${s.toolInputsPrePruned}`,
    `OUTPUTS inline ${s.toolOutputsKept} | newly omitted ${s.toolOutputsPruned} | pre-omitted ${s.toolOutputsPrePruned}`,
    `AGENT RESULTS inline ${s.agentResultsKept} | newly omitted ${s.agentResultsPruned} | pre-omitted ${s.agentResultsPrePruned}`,
    `SKILLS inline ${s.skillsKept} | omitted/re-invokable ${s.skillsPruned}${s.skillsNoted.length ? ` [${s.skillsNoted.join(", ")}]` : ""}`,
    `INJECTIONS inline ${s.injectionsKept} | omitted ${s.injectionsPruned}`,
    `RECOVER: search_omitted_content(query[, mode]) searches current lineage; read_omitted_content(contentId[, start, length]) reads bounded exact-value renderings.`,
    `Original parent remains unchanged on disk. Do not re-condense unless the user asks.`,
  ].join("\n");
}

function makeMarkerRow(forkRows: TranscriptRow[], sessionId: string, parentUuid: string, text: string): JsonRecord | null {
  const template = forkRows.find((row) => row.type === "user" || row.type === "assistant"); if (!template) return null;
  const fields: JsonRecord = { ...template };
  for (const key of ["message", "uuid", "parentUuid", "type", "condenseMarker", "requestId", "isMeta", "forkedFrom"]) delete fields[key];
  const maxMs = forkRows.reduce((max, row) => { const value = Date.parse(row.timestamp); return Number.isFinite(value) ? Math.max(max, value) : max; }, 0);
  return { ...fields, type: "user", uuid: randomUUID(), parentUuid, sessionId, condenseMarker: true, timestamp: new Date((maxMs || Date.now()) + 1000).toISOString(), message: { role: "user", content: text } };
}

const SINGLETON_META = new Set(["mode", "permission-mode", "agent-color", "agent-setting", "pr-link", "tag"]);
function dedupeSingletonMeta(entries: JsonRecord[]): JsonRecord[] { const last = new Map<string, number>(); entries.forEach((entry, index) => { const type = String(entry["type"] ?? ""); if (SINGLETON_META.has(type)) last.set(type, index); }); return entries.filter((entry, index) => { const type = String(entry["type"] ?? ""); return !SINGLETON_META.has(type) || last.get(type) === index; }); }
function makeTitleRows(sessionId: string, title: string, generation: number): JsonRecord[] { return [{ type: "custom-title", customTitle: title, sessionId, condenseGeneration: generation }, { type: "agent-name", agentName: title, sessionId }]; }

async function readTitleRows(path: string): Promise<JsonRecord[]> {
  return (await readFile(path, "utf8")).split("\n").flatMap((line) => { try { const row = JSON.parse(line); return isRecord(row) && ["custom-title", "agent-name"].includes(String(row["type"])) ? [row] : []; } catch { return []; } });
}
function parentGeneration(rows: JsonRecord[]): number { return rows.reduce((max, row) => { if (row["type"] !== "custom-title") return max; if (typeof row["condenseGeneration"] === "number") return Math.max(max, row["condenseGeneration"]); const match = typeof row["customTitle"] === "string" ? row["customTitle"].match(/^🗜 condense #(\d+) —/u) : null; return match?.[1] ? Math.max(max, Number(match[1])) : max; }, 0); }
function firstUserPrompt(rows: TranscriptRow[]): string { for (const row of rows) { if (row.type !== "user" || row["isMeta"] === true || row["condenseMarker"] === true || !isRecord(row.message)) continue; const content = row.message["content"]; if (typeof content === "string" && content.trim()) return content.trim(); if (Array.isArray(content) && !content.some((block) => isRecord(block) && block["type"] === "tool_result")) { const text = content.filter((block) => isRecord(block) && block["type"] === "text").map((block) => String((block as JsonRecord)["text"] ?? "")).join(" ").trim(); if (text) return text; } } return "session"; }
function computeCondensedTitle(titleRows: JsonRecord[], rows: TranscriptRow[], generation: number, override?: string): string { let base = override ?? ""; if (!base) { let parent = ""; for (const row of titleRows) if (row["type"] === "custom-title" && typeof row["customTitle"] === "string") parent = row["customTitle"]; const match = parent.match(/^🗜 condense #\d+ — (.+)$/u); base = match?.[1] ? match[1].trim() : firstUserPrompt(rows); } if (base.length > 80) base = `${base.slice(0, 80).trim()}…`; return `🗜 condense #${generation} — ${base}`; }
