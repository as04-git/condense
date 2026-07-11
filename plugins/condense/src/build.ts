import type { HostAdapter } from "./host";
import { collectReferencedContentIds, saveManifest, saveV3Objects } from "./omission";
import { applyRetention, contextChars, contextContentDigest, convergeMarker } from "./planner";
import { parseBuildRequest, sha256 } from "./protocol";
import { loadAnalysisRecord, loadPreparedRecord, removePending, withPlanLock, withReceiptLock } from "./state";
import {
  isRecord,
  isTranscriptRow,
  selectActiveTranscriptRows,
  type JsonRecord,
  type TranscriptRow,
} from "./transcript";
import { revalidatePreparedSource } from "./workflow";

export type BuildPublication = {
  saveObjects: typeof saveV3Objects;
  saveLineageManifest: typeof saveManifest;
  publishSession(
    adapter: HostAdapter,
    fork: Parameters<HostAdapter["publish"]>[0],
    storageEntries: JsonRecord[],
  ): Promise<void>;
};

const DEFAULT_PUBLICATION: BuildPublication = {
  saveObjects: saveV3Objects,
  saveLineageManifest: saveManifest,
  publishSession: (adapter, fork, storageEntries) => adapter.publish(fork, storageEntries),
};

function originalUuid(row: TranscriptRow): string {
  const forkedFrom = row["forkedFrom"];
  if (!isRecord(forkedFrom) || typeof forkedFrom["messageUuid"] !== "string")
    throw new Error(`Fork row ${row.uuid} is missing source lineage`);
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

export async function runBuild(
  adapter: HostAdapter,
  requestValue: unknown,
  publication: BuildPublication = DEFAULT_PUBLICATION,
) {
  const request = parseBuildRequest(requestValue);
  return withPlanLock(request.plan, async () => {
    const prepared = await loadPreparedRecord(request.plan);
    return withReceiptLock(prepared.analysisHandle, async () => {
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
        if (sha256(applied.mutations) !== sha256(prepared.plannedMutations))
          throw new Error("Prepared plan mutation mismatch: candidate mutations differ from the exact dry run");
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
        finalEntries.push(...adapter.titleEntries(fork, { title: prepared.title, generation: prepared.generation }));

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
        const markerProjection = convergeMarker({
          sourceSessionId: snapshot.identity.sessionId,
          generation: prepared.generation,
          keepTurns: prepared.config.keepTurns,
          sourceChars: prepared.stats.impactChars.source,
          beforeMarkerChars,
          lineageCount: lineageIds.length,
          counts: applied.counts,
          droppedThinkingTurns: applied.droppedThinkingTurns,
          prompts,
        });
        const markerText = markerProjection.text;
        const marker = adapter.markerEntry(fork, markerParent, markerText);
        finalEntries.push(marker);
        const activeFinal = selectActiveTranscriptRows(finalEntries.filter(isTranscriptRow));
        const finalChars = contextChars(activeFinal);
        if (finalChars !== prepared.stats.impactChars.projected) {
          throw new Error(
            `Prepared projection mismatch: expected ${prepared.stats.impactChars.projected}, built ${finalChars}`,
          );
        }
        if (contextContentDigest(activeFinal) !== prepared.plannedContextDigest) {
          throw new Error("Prepared plan content mismatch: built active context differs from the exact dry run");
        }
        if (!markerText.includes(`${prepared.stats.impactChars.source}→${finalChars} context chars`))
          throw new Error("Final marker accounting did not converge");

        await publication.saveObjects(applied.objects);
        await publication.saveLineageManifest(fork.sessionId, lineageIds);
        await publication.publishSession(adapter, fork, finalEntries);
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
          resume: adapter.resumeCommand(fork.sessionId),
        };
      } catch (error) {
        await adapter.cleanupFork(fork);
        throw error;
      }
    });
  });
}
