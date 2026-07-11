import { runAnalyze, renderAnalysisPage, renderRefInspection } from "./analyze";
import type { CondenseConfig } from "./config";
import type { HostAdapter, SessionSnapshot } from "./host";
import { newAvailableContentId } from "./omission";
import { contextContentDigest, projectRetention, shouldKeepCandidate, validateDecision } from "./planner";
import { parseInspectRequest, parsePrepareDecision, type InspectRequest, type PrepareDecision } from "./protocol";
import {
  loadAnalysisRecord,
  saveAnalysisRecord,
  savePreparedRecord,
  withReceiptLock,
  type AnalysisRecord,
  type PreparedStats,
  type StoredSource,
} from "./state";

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
  if (adapter.host !== record.source.identity.host) throw new Error("Receipt belongs to a different host adapter");
  const currentSessionId = process.env["CLAUDE_CODE_SESSION_ID"];
  if (currentSessionId && currentSessionId !== record.source.identity.sessionId)
    throw new Error("Receipt belongs to a different current session");
  const snapshot = await adapter.snapshot(record.source.identity, record.source.cutoffUuid);
  if (snapshot.storageDigest !== record.source.storageDigest)
    throw new Error("SDK fork-source prefix changed after analyze; rerun analyze.");
  if (snapshot.contextDigest !== record.source.contextDigest)
    throw new Error("Active context changed after analyze; rerun analyze.");
  return snapshot;
}

function automatic(
  candidates: ReturnType<typeof runAnalyze>["candidateManifest"],
): Array<["inline" | "omit", string, number]> {
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

async function prepareDecision(adapter: HostAdapter, decision: PrepareDecision) {
  const record = await loadAnalysisRecord(decision.receipt);
  const snapshot = await validateSnapshot(adapter, record);
  validateDecision(decision, record.candidates);
  const presentation = await adapter.preparePresentation(snapshot, decision.title);
  const omissions: Record<string, string> = {};
  for (const candidate of record.candidates) {
    if (candidate.class !== "thinking" && !shouldKeepCandidate(candidate, decision))
      omissions[candidate.ref] = await newAvailableContentId();
  }
  const prompts = new Map(record.turns.map((turn) => [turn.turn, turn.prompt]));
  const projection = projectRetention({
    rows: snapshot.contextEntries,
    candidates: record.candidates,
    decision,
    omissionIds: omissions,
    sourceSessionId: snapshot.identity.sessionId,
    generation: presentation.generation,
    keepTurns: record.config.keepTurns,
    prompts,
  });
  const droppedTurns = [...projection.droppedThinkingTurns]
    .sort((a, b) => a - b)
    .map((turn) => [turn, prompts.get(turn) || "(no prompt)"] as [number, string]);
  const tokenProjection = adapter.tokenCounter
    ? await adapter.tokenCounter.project(snapshot, {
        config: record.config,
        candidates: record.candidates,
        decision: { keep: decision.keep, drop: decision.drop, title: decision.title },
        omissions: Object.entries(omissions).map(([ref, contentId]) => ({ ref, contentId })),
        projectedChars: projection.projectedChars,
      })
    : undefined;
  const stats: PreparedStats = {
    thinking: { kept: projection.counts.thinkingKept, dropped: projection.counts.thinkingDropped, droppedTurns },
    externalized: projection.counts.externalized,
    inline: projection.counts.inline,
    impactChars: {
      source: projection.sourceChars,
      projected: projection.projectedChars,
      removed: projection.sourceChars - projection.projectedChars,
    },
    warnings: projection.counts.thinkingDropped
      ? [`${projection.counts.thinkingDropped} thinking block(s) are unrecoverable in the child session`]
      : [],
    ...(tokenProjection ? { tokenProjection } : {}),
  };
  const prepared = await savePreparedRecord({
    analysisHandle: record.handle,
    source: record.source,
    config: record.config,
    decision,
    omissions,
    generation: presentation.generation,
    title: presentation.title,
    plannedContextDigest: contextContentDigest(projection.rows, projection.markerText),
    plannedMutations: projection.mutations,
    stats,
  });
  return {
    plan: prepared.handle,
    thinking: stats.thinking,
    externalized: stats.externalized,
    inline: stats.inline,
    impactChars: stats.impactChars,
    warnings: stats.warnings,
    ...(stats.tokenProjection ? { tokenProjection: stats.tokenProjection } : {}),
  };
}

export async function prepareBuild(adapter: HostAdapter, decisionValue: unknown) {
  const decision = parsePrepareDecision(decisionValue);
  return withReceiptLock(decision.receipt, () => prepareDecision(adapter, decision));
}

export async function revalidatePreparedSource(adapter: HostAdapter, source: StoredSource): Promise<SessionSnapshot> {
  const snapshot = await adapter.snapshot(source.identity, source.cutoffUuid);
  if (snapshot.storageDigest !== source.storageDigest || snapshot.contextDigest !== source.contextDigest)
    throw new Error("Source changed after prepare; rerun analyze and prepare.");
  return snapshot;
}
