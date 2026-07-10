// fork.ts — thin wrapper over the official Claude Agent SDK's `forkSession`.
//
// This replaces condense's hand-built clone surgery (fresh identity, uuid
// remap, parentUuid re-chain, metadata rewrite). The SDK is the maintained
// layer over Claude Code's version-fragile on-disk format; letting it own the
// clone means format churn is Anthropic's problem, not ours. `forkSession`:
//   - mints a fresh sessionId + remaps every ROW uuid (tool_use ids untouched),
//   - preserves/re-chains parentUuid, drops last-prompt / ai-title / file-history,
//   - stamps forkedFrom.{sessionId,messageUuid} on every row (old->new map),
//   - preserves thinking signatures byte-identically,
//   - `upToMessageId` slices inclusively (our op-turn strip).
// It does NOT prune content, write an agent-name banner, or add a marker — those
// stay in our post-pass (build.ts), which is the whole value of condense.

import { basename, dirname, join } from "node:path";
import { forkSession } from "@anthropic-ai/claude-agent-sdk";
import { isRecord, readTranscriptRows, type TranscriptRow } from "./transcript";

export type ForkResult = {
  sessionId: string;
  transcriptPath: string;
  rows: TranscriptRow[];
  // original row uuid -> forked row uuid, from each forked row's forkedFrom.
  oldToNew: Map<string, string>;
};

export function assertForkLineage(rows: TranscriptRow[]): void {
  for (const row of rows) {
    const forkedFrom = row["forkedFrom"];
    if (!isRecord(forkedFrom) || typeof forkedFrom["messageUuid"] !== "string") {
      throw new Error(`SDK fork row ${row.uuid} is missing forkedFrom.messageUuid`);
    }
  }
}

// Fork `sourcePath`'s session via the SDK and load the result. `upToMessageId`
// (an ORIGINAL row uuid) slices the fork inclusively; `title` sets custom-title.
export async function forkForCondense(
  sourcePath: string,
  opts: { upToMessageId?: string; title?: string },
): Promise<ForkResult> {
  const sourceSessionId = basename(sourcePath, ".jsonl");
  // dir omitted: sessionIds are UUIDs, so the SDK's all-projects search is
  // unambiguous, and it writes the fork into the same project dir as the source.
  const { sessionId } = await forkSession(sourceSessionId, {
    upToMessageId: opts.upToMessageId,
    title: opts.title,
  });
  const transcriptPath = join(dirname(sourcePath), `${sessionId}.jsonl`);
  const rows = await readTranscriptRows(transcriptPath);
  assertForkLineage(rows);

  const oldToNew = new Map<string, string>();
  for (const r of rows) {
    if (!isRecord(r) || typeof r.uuid !== "string") continue;
    const ff = r["forkedFrom"];
    if (isRecord(ff) && typeof ff["messageUuid"] === "string") {
      oldToNew.set(ff["messageUuid"], r.uuid);
    }
  }
  return { sessionId, transcriptPath, rows, oldToNew };
}
