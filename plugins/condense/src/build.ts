import { randomUUID } from "node:crypto";
import type { HostAdapter } from "./host";
import { collectReferencedContentIds, saveManifest, saveV3Objects } from "./omission";
import { applyRetention, contextChars, convergeMarker } from "./planner";
import { parseBuildRequest } from "./protocol";
import { loadAnalysisRecord, loadPreparedRecord, removePending, withPlanLock } from "./state";
import {
  isRecord,
  isTranscriptRow,
  selectActiveTranscriptRows,
  writeTranscriptEntries,
  type JsonRecord,
  type TranscriptRow,
} from "./transcript";
import { revalidatePreparedSource } from "./workflow";

function originalUuid(row: TranscriptRow): string {
  const forkedFrom = row["forkedFrom"];
  if (!isRecord(forkedFrom) || typeof forkedFrom["messageUuid"] !== "string") throw new Error(`Fork row ${row.uuid} is missing source lineage`);
  return forkedFrom["messageUuid"];
}

function resolveDroppedParents(rows: TranscriptRow[], dropped: Set<string>): void {
  const parentOf = new Map(rows.map((row) => [row.uuid, row.parentUuid]));
  const resolve = (uuid: string | null): string | null => {
    const seen = new Set<string>();
    while (uuid && dropped.has(uuid)) {
      if (seen.has(uuid)) throw new Error("Cycle while resolving a dropped row parent");
      seen.add(uuid);
      uuid = parentOf.get(uuid) ?? null;
    }
    return uuid;
  };
  for (const row of rows) if (row.parentUuid && dropped.has(row.parentUuid)) row.parentUuid = resolve(row.parentUuid);
}

function titleRows(sessionId: string, title: string, generation: number): JsonRecord[] {
  return [
    { type: "custom-title", customTitle: title, sessionId, condenseGeneration: generation },
    { type: "agent-name", agentName: title, sessionId },
  ];
}

function markerRow(templateRows: TranscriptRow[], sessionId: string, parentUuid: string, text: string): TranscriptRow {
  const template = templateRows.find((row) => row.type === "user" || row.type === "assistant");
  if (!template) throw new Error("Could not construct the closing marker");
  const fields: JsonRecord = { ...template };
  for (const key of ["message", "uuid", "parentUuid", "type", "condenseMarker", "requestId", "isMeta", "forkedFrom"]) delete fields[key];
  const maxMs = templateRows.reduce((max, row) => {
    const parsed = Date.parse(row.timestamp);
    return Number.isFinite(parsed) ? Math.max(max, parsed) : max;
  }, 0);
  return {
    ...fields,
    type: "user",
    uuid: randomUUID(),
    parentUuid,
    sessionId,
    condenseMarker: true,
    timestamp: new Date((maxMs || Date.now()) + 1000).toISOString(),
    message: { role: "user", content: text },
  } as TranscriptRow;
}

export async function runBuild(adapter: HostAdapter, requestValue: unknown) {
  const request = parseBuildRequest(requestValue);
  return withPlanLock(request.plan, async () => {
    const prepared = await loadPreparedRecord(request.plan);
    const analysis = await loadAnalysisRecord(prepared.analysisHandle);
    const snapshot = await revalidatePreparedSource(adapter, prepared.source);
    const fork = await adapter.fork(snapshot, prepared.title);
    try {
      const activeOriginalUuids = new Set(snapshot.contextEntries.map((row) => row.uuid));
      const applied = applyRetention({
        rows: fork.messageRows,
        candidates: analysis.candidates,
        decision: prepared.decision,
        omissionIds: prepared.omissions,
        activeOriginalUuids,
        originalUuid,
      });
      for (const row of applied.rows) if (row["condenseMarker"] === true) applied.droppedRows.add(row.uuid);
      resolveDroppedParents(applied.rows, applied.droppedRows);
      const mutated = new Map(applied.rows.map((row) => [row.uuid, row]));
      const finalEntries: JsonRecord[] = [];
      for (const entry of fork.storageEntries) {
        if (["custom-title", "agent-name", "ai-title"].includes(String(entry["type"] ?? ""))) continue;
        if (isTranscriptRow(entry)) {
          if (applied.droppedRows.has(entry.uuid)) continue;
          finalEntries.push(mutated.get(entry.uuid) ?? entry);
        } else finalEntries.push(entry);
      }
      finalEntries.push(...titleRows(fork.sessionId, prepared.title, prepared.generation));

      const mappedCutoff = fork.oldToNew.get(snapshot.cutoffUuid);
      if (!mappedCutoff) throw new Error("SDK fork did not map the prepared cutoff UUID");
      let markerParent: string | null = mappedCutoff;
      const parentOf = new Map(applied.rows.map((row) => [row.uuid, row.parentUuid]));
      while (markerParent && applied.droppedRows.has(markerParent)) markerParent = parentOf.get(markerParent) ?? null;
      if (!markerParent) throw new Error("No surviving marker parent exists");

      const activeBeforeMarker = selectActiveTranscriptRows(finalEntries.filter(isTranscriptRow));
      const lineageIds = collectReferencedContentIds(activeBeforeMarker);
      const prompts = new Map(analysis.turns.map((turn) => [turn.turn, turn.prompt]));
      const beforeMarkerChars = contextChars(activeBeforeMarker);
      const markerProjection = convergeMarker({ sourceSessionId: snapshot.identity.sessionId, generation: prepared.generation, keepTurns: prepared.config.keepTurns, sourceChars: prepared.stats.impactChars.source, beforeMarkerChars, lineageCount: lineageIds.length, counts: applied.counts, droppedThinkingTurns: applied.droppedThinkingTurns, prompts });
      const markerText = markerProjection.text;
      const marker = markerRow(applied.rows, fork.sessionId, markerParent, markerText);
      finalEntries.push(marker);
      const activeFinal = selectActiveTranscriptRows(finalEntries.filter(isTranscriptRow));
      const finalChars = contextChars(activeFinal);
      if (finalChars !== prepared.stats.impactChars.projected) {
        throw new Error(`Prepared projection mismatch: expected ${prepared.stats.impactChars.projected}, built ${finalChars}`);
      }
      if (!markerText.includes(`${prepared.stats.impactChars.source}→${finalChars} context chars`)) throw new Error("Final marker accounting did not converge");

      await saveV3Objects(applied.objects);
      await saveManifest(fork.sessionId, lineageIds);
      await writeTranscriptEntries(fork.transcriptPath, finalEntries);
      await removePending(prepared.handle);
      await removePending(prepared.analysisHandle);
      return {
        sessionId: fork.sessionId,
        transcriptPath: fork.transcriptPath,
        generation: prepared.generation,
        sourceChars: prepared.stats.impactChars.source,
        finalChars,
        removedChars: prepared.stats.impactChars.source - finalChars,
        lineageObjects: lineageIds.length,
        thinking: prepared.stats.thinking,
        externalized: prepared.stats.externalized,
        inline: prepared.stats.inline,
        resume: `/resume ${fork.sessionId}`,
      };
    } catch (error) {
      await adapter.cleanupFork(fork);
      throw error;
    }
  });
}
