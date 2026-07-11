import { readFile } from "node:fs/promises";
import { runAnalyze, renderAnalysisPage, renderRefInspection } from "./analyze";
import type { CondenseConfig } from "./config";
import type { HostAdapter, SessionSnapshot } from "./host";
import { newContentId } from "./omission";
import { projectRetention, shouldKeepCandidate, validateDecision } from "./planner";
import { parseInspectRequest, parsePrepareDecision, type InspectRequest } from "./protocol";
import {
  loadAnalysisRecord,
  saveAnalysisRecord,
  savePreparedRecord,
  type AnalysisRecord,
  type PreparedStats,
  type StoredSource,
} from "./state";
import { isRecord, type JsonRecord } from "./transcript";

function storedSource(snapshot: SessionSnapshot): StoredSource {
  return {
    identity: snapshot.identity,
    cutoffUuid: snapshot.cutoffUuid,
    operationUserUuid: snapshot.operationUserUuid,
    storageDigest: snapshot.storageDigest,
    contextDigest: snapshot.contextDigest,
  };
}

async function validateSnapshot(adapter: HostAdapter, record: AnalysisRecord): Promise<SessionSnapshot> {
  const currentSessionId = process.env["CLAUDE_CODE_SESSION_ID"];
  if (currentSessionId && currentSessionId !== record.source.identity.sessionId) throw new Error("Receipt belongs to a different current session");
  const snapshot = await adapter.snapshot(record.source.identity, record.source.cutoffUuid);
  if (snapshot.storageDigest !== record.source.storageDigest) throw new Error("SDK fork-source prefix changed after analyze; rerun analyze.");
  if (snapshot.contextDigest !== record.source.contextDigest) throw new Error("Active context changed after analyze; rerun analyze.");
  return snapshot;
}

function automatic(candidates: ReturnType<typeof runAnalyze>["candidateManifest"]): Array<["inline" | "omit", string, number]> {
  const counts = new Map<string, number>();
  for (const candidate of candidates.filter((item) => item.action === "none")) {
    const behavior = candidate.defaultKeep ? "inline" : "omit";
    const key = `${behavior}:${candidate.class}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => {
    const [behavior, candidateClass] = key.split(":");
    return [behavior as "inline" | "omit", candidateClass!, count];
  });
}

export async function analyzeCurrentSession(adapter: HostAdapter, config: CondenseConfig) {
  const identity = adapter.locateCurrentSession();
  const snapshot = await adapter.snapshot(identity);
  const analysis = runAnalyze(snapshot.contextEntries, config);
  const record = await saveAnalysisRecord({
    source: storedSource(snapshot),
    config,
    candidates: analysis.candidateManifest,
    attachments: analysis.rankableAttachments,
    thinking: analysis.rankableThinking,
    turns: analysis.perTurn,
    automatic: automatic(analysis.candidateManifest),
  });
  return renderAnalysisPage(record);
}

function cursorOffset(cursor: string): number {
  const match = cursor.match(/^p_(\d+)$/);
  if (!match?.[1]) throw new Error("Invalid inspect cursor");
  return Number(match[1]);
}

export async function inspectAnalysis(adapter: HostAdapter, requestValue: unknown) {
  const request: InspectRequest = parseInspectRequest(requestValue);
  const record = await loadAnalysisRecord(request.receipt);
  await validateSnapshot(adapter, record);
  if (request.cursor) return renderAnalysisPage(record, cursorOffset(request.cursor));
  return renderRefInspection(record, request.refs!);
}

async function rawTitleRows(path: string): Promise<JsonRecord[]> {
  return (await readFile(path, "utf8")).split("\n").flatMap((line) => {
    try {
      const row: unknown = JSON.parse(line);
      return isRecord(row) && ["custom-title", "agent-name"].includes(String(row["type"])) ? [row] : [];
    } catch {
      return [];
    }
  });
}

function parentGeneration(rows: JsonRecord[]): number {
  return rows.reduce((max, row) => {
    if (row["type"] !== "custom-title") return max;
    if (typeof row["condenseGeneration"] === "number") return Math.max(max, row["condenseGeneration"]);
    const match = typeof row["customTitle"] === "string" ? row["customTitle"].match(/^🗜 condense #(\d+) —/u) : null;
    return match?.[1] ? Math.max(max, Number(match[1])) : max;
  }, 0);
}

function firstPrompt(snapshot: SessionSnapshot): string {
  for (const row of snapshot.contextEntries) {
    if (row.type !== "user" || row["isMeta"] === true || row["condenseMarker"] === true || !isRecord(row.message)) continue;
    const content = row.message["content"];
    if (typeof content === "string" && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const text = content.filter((block) => isRecord(block) && block["type"] === "text").map((block) => String((block as JsonRecord)["text"] ?? "")).join(" ").trim();
      if (text) return text;
    }
  }
  return "session";
}

function condensedTitle(rows: JsonRecord[], snapshot: SessionSnapshot, generation: number, override?: string): string {
  let base = override ?? "";
  if (!base) {
    const parent = [...rows].reverse().find((row) => row["type"] === "custom-title" && typeof row["customTitle"] === "string")?.["customTitle"];
    const match = typeof parent === "string" ? parent.match(/^🗜 condense #\d+ — (.+)$/u) : null;
    base = match?.[1]?.trim() || firstPrompt(snapshot);
  }
  if (base.length > 80) base = `${base.slice(0, 80).trim()}…`;
  return `🗜 condense #${generation} — ${base}`;
}

export async function prepareBuild(adapter: HostAdapter, decisionValue: unknown) {
  const decision = parsePrepareDecision(decisionValue);
  const record = await loadAnalysisRecord(decision.receipt);
  const snapshot = await validateSnapshot(adapter, record);
  validateDecision(decision, record.candidates);
  const titleRows = await rawTitleRows(snapshot.identity.transcriptPath);
  const generation = parentGeneration(titleRows) + 1;
  const title = condensedTitle(titleRows, snapshot, generation, decision.title);
  const omissions: Record<string, string> = {};
  for (const candidate of record.candidates) {
    if (candidate.class !== "thinking" && !shouldKeepCandidate(candidate, decision)) omissions[candidate.ref] = newContentId();
  }
  const prompts = new Map(record.turns.map((turn) => [turn.turn, turn.prompt]));
  const projection = projectRetention({ rows: snapshot.contextEntries, candidates: record.candidates, decision, omissionIds: omissions, sourceSessionId: snapshot.identity.sessionId, generation, keepTurns: record.config.keepTurns, prompts });
  const droppedTurns = [...projection.droppedThinkingTurns].sort((a, b) => a - b).map((turn) => [turn, prompts.get(turn) || "(no prompt)"] as [number, string]);
  const stats: PreparedStats = {
    thinking: { kept: projection.counts.thinkingKept, dropped: projection.counts.thinkingDropped, droppedTurns },
    externalized: projection.counts.externalized,
    inline: projection.counts.inline,
    impactChars: { source: projection.sourceChars, projected: projection.projectedChars, removed: projection.sourceChars - projection.projectedChars },
    warnings: projection.counts.thinkingDropped ? [`${projection.counts.thinkingDropped} thinking block(s) are unrecoverable in the child session`] : [],
  };
  const prepared = await savePreparedRecord({ analysisHandle: record.handle, source: record.source, config: record.config, decision, omissions, generation, title, stats });
  return { plan: prepared.handle, thinking: stats.thinking, externalized: stats.externalized, inline: stats.inline, impactChars: stats.impactChars, warnings: stats.warnings };
}

export async function revalidatePreparedSource(adapter: HostAdapter, source: StoredSource): Promise<SessionSnapshot> {
  const snapshot = await adapter.snapshot(source.identity, source.cutoffUuid);
  if (snapshot.storageDigest !== source.storageDigest || snapshot.contextDigest !== source.contextDigest) throw new Error("Source changed after prepare; rerun analyze and prepare.");
  return snapshot;
}
