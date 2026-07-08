// build.ts — mechanical build step for condense.
//
// Takes a source transcript + a ranking/mode decision (produced in-session by
// the model after reading analyze.ts output) and writes a NEW compacted
// session. Unlike magic-compact, there is NO LLM summarization: prose is kept
// verbatim, thinking is kept byte-for-byte or dropped (never edited — signatures
// must survive exactly), and tool outputs are kept inline or pruned to
// retrievable Content-IDs per the chosen mode.
//
// Usage: bun build.ts <source_transcript_path> <ranking_json_path>
// Ranking JSON shape:
//   {
//     "keepTurns": 1,
//     "modes": { "thinking": "keep-all|keep-ranked|drop",
//                "tools":    "keep-all|keep-ranked|drop" },
//     "keepThinking":    [ { "uuid": "<src row uuid>", "blockIndex": 0 }, ... ],
//     "keepToolOutputs": [ "toolu_...", ... ]
//   }
// Prints JSON: { "sessionId": "...", "transcriptPath": "...", "stats": {...} }

import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import {
  allocateOmission,
  loadOmissionCache,
  outputOmissionNotice,
  saveOmissionCache,
} from "./omission";
import { pruneTranscriptRow } from "./prune";
import {
  buildAssistantTurns,
  createTranscriptSession,
  isRecord,
  readActiveTranscriptRows,
  readPreservedMetadataEntries,
  type JsonRecord,
  type TranscriptRow,
  type Turn,
  writeTranscriptEntries,
} from "./transcript";

type Mode = "keep-all" | "keep-ranked" | "drop";

type Ranking = {
  keepTurns: number;
  modes: { thinking: Mode; tools: Mode };
  keepThinking: { uuid: string; blockIndex: number }[];
  keepToolOutputs: string[];
};

type Plan = {
  prefixTurns: Turn[];
  compactedTurns: Turn[];
  preservedTurns: Turn[];
  baseRow: TranscriptRow;
};

const POST_COMPACTION_NOTICE = `<post-compaction-notice>
A condense operation has just been applied to all messages above. Prose was kept verbatim. Some historical tool input/output was omitted and is retrievable via the read_omitted_content tool using the appropriate Content ID. Older extended-thinking was not carried forward. You may need to reread files to regain exact context.
</post-compaction-notice>`;

function isCondenseBoundaryRow(row: TranscriptRow): boolean {
  const c = row["condense"];
  return isRecord(c) && c["boundary"] === true;
}

async function main(): Promise<void> {
  const [sourcePath, rankingPath] = Bun.argv.slice(2);
  if (!sourcePath || !rankingPath) {
    console.error("usage: bun build.ts <source_transcript_path> <ranking_json_path>");
    process.exit(2);
  }
  const ranking = normalizeRanking(await Bun.file(rankingPath).json());

  const destination = await createTranscriptSession(sourcePath);
  try {
    const rows = await readActiveTranscriptRows(sourcePath);
    const plan = createPlan(rows, ranking.keepTurns);
    if (plan.compactedTurns.length === 0) {
      throw new Error("Nothing to compact: no turns older than keepTurns.");
    }

    const { compactedRows, stats } = await buildCompactedRows(
      plan,
      destination.sessionId,
      ranking,
    );
    const metadataEntries = await readPreservedMetadataEntries(
      sourcePath,
      plan.baseRow.sessionId,
      destination.sessionId,
    );
    await writeTranscriptEntries(destination.transcriptPath, [
      ...metadataEntries,
      ...compactedRows,
    ]);

    console.log(
      JSON.stringify({
        sessionId: destination.sessionId,
        transcriptPath: destination.transcriptPath,
        stats,
      }),
    );
  } catch (error) {
    await unlink(destination.transcriptPath).catch(() => undefined);
    throw error;
  }
}

function normalizeRanking(value: unknown): Ranking {
  const v = isRecord(value) ? value : {};
  const modes = isRecord(v["modes"]) ? v["modes"] : {};
  const asMode = (m: unknown, dflt: Mode): Mode =>
    m === "keep-all" || m === "keep-ranked" || m === "drop" ? m : dflt;
  return {
    keepTurns:
      typeof v["keepTurns"] === "number" ? Math.max(0, v["keepTurns"]) : 1,
    modes: {
      thinking: asMode(modes["thinking"], "keep-ranked"),
      tools: asMode(modes["tools"], "keep-ranked"),
    },
    keepThinking: Array.isArray(v["keepThinking"])
      ? v["keepThinking"].flatMap((e) =>
          isRecord(e) && typeof e["uuid"] === "string" && typeof e["blockIndex"] === "number"
            ? [{ uuid: e["uuid"], blockIndex: e["blockIndex"] }]
            : [],
        )
      : [],
    keepToolOutputs: Array.isArray(v["keepToolOutputs"])
      ? v["keepToolOutputs"].filter((x): x is string => typeof x === "string")
      : [],
  };
}

function createPlan(rows: TranscriptRow[], keepTurns: number): Plan {
  const baseRow = rows.find(
    (row) => row.type === "user" || row.type === "assistant",
  );
  if (!baseRow) {
    throw new Error("Transcript does not contain compactable conversation rows.");
  }

  const turns = buildAssistantTurns(rows);
  // Everything after a previous condense boundary is fair game; the boundary
  // itself is a meta row that buildAssistantTurns won't include in a turn.
  const boundaryStart =
    turns.findLastIndex((turn) => turn.rows.some(isCondenseBoundaryRow)) + 1;
  const compactEnd =
    keepTurns <= 0
      ? turns.length
      : Math.max(boundaryStart, turns.length - keepTurns);

  return {
    prefixTurns: turns.slice(0, boundaryStart),
    compactedTurns: turns.slice(boundaryStart, compactEnd),
    preservedTurns: turns.slice(compactEnd),
    baseRow,
  };
}

async function buildCompactedRows(
  plan: Plan,
  sessionId: string,
  ranking: Ranking,
): Promise<{ compactedRows: TranscriptRow[]; stats: JsonRecord }> {
  const rows: TranscriptRow[] = [];
  const copiedUuids = new Map<string, string>();
  const completedToolUseIds = collectCompletedToolUseIds(plan.compactedTurns);
  const toolNamesById = collectToolNamesById(plan.compactedTurns);
  const omissionCache = await loadOmissionCache(sessionId);
  const timestamp = new Date().toISOString();
  const keepThinking = new Set(
    ranking.keepThinking.map((e) => `${e.uuid}#${e.blockIndex}`),
  );
  const keepTools = new Set(ranking.keepToolOutputs);

  const stats = {
    thinkingKept: 0,
    thinkingDropped: 0,
    toolOutputsKept: 0,
    toolOutputsPruned: 0,
  };

  const lastOriginalRow = sourceTurns(plan)
    .flatMap((turn) => turn.rows)
    .at(-1);
  if (!lastOriginalRow) {
    throw new Error("Compaction plan has no source rows.");
  }

  // Boundary marker.
  const boundaryUuid = randomUUID();
  rows.push({
    ...copySessionFields(plan.baseRow, sessionId, timestamp),
    type: "user",
    uuid: boundaryUuid,
    parentUuid: null,
    isMeta: true,
    message: {
      id: `msg_${randomUUID()}`,
      role: "user",
      content: POST_COMPACTION_NOTICE,
    },
    logicalParentUuid: lastOriginalRow.uuid,
    condense: { boundary: true },
  });
  let parentUuid: string | null = boundaryUuid;

  // Prefix + preserved turns: verbatim.
  for (const turn of plan.prefixTurns) {
    parentUuid = copyTurnVerbatim(turn, rows, copiedUuids, sessionId, timestamp, parentUuid);
  }

  // Compacted region: prose verbatim; thinking per mode; tool outputs per mode;
  // tool_use inputs shrunk mechanically (lossless).
  const ctx = { cache: omissionCache, sessionId, completedToolUseIds, toolNamesById };
  for (const turn of plan.compactedTurns) {
    for (const row of turn.rows) {
      const newParent = row.parentUuid
        ? copiedUuids.get(row.parentUuid) ?? parentUuid
        : parentUuid;
      const copied = copyRow(row, sessionId, timestamp, newParent);

      if (row.type === "assistant") {
        filterThinking(copied, row.uuid, ranking.modes.thinking, keepThinking, stats);
        pruneTranscriptRow(copied, ctx); // shrinks large tool_use INPUTS only
      } else if (isToolResultRow(row)) {
        applyToolOutputMode(copied, ranking.modes.tools, keepTools, ctx, stats);
      }
      // human prompts / other rows: verbatim (already copied)

      copiedUuids.set(row.uuid, copied.uuid);
      rows.push(copied);
      parentUuid = copied.uuid;
    }
  }

  for (const turn of plan.preservedTurns) {
    parentUuid = copyTurnVerbatim(turn, rows, copiedUuids, sessionId, timestamp, parentUuid);
  }

  await saveOmissionCache(sessionId, omissionCache);
  return { compactedRows: rows, stats };
}

// --- content handlers -------------------------------------------------------

function filterThinking(
  row: TranscriptRow,
  originalUuid: string,
  mode: Mode,
  keepThinking: Set<string>,
  stats: { thinkingKept: number; thinkingDropped: number },
): void {
  if (!isRecord(row.message)) return;
  const content = row.message["content"];
  if (!Array.isArray(content)) return;

  const next = content.filter((block, index) => {
    if (!isRecord(block) || block["type"] !== "thinking") return true;
    const keep =
      mode === "keep-all"
        ? true
        : mode === "drop"
          ? false
          : keepThinking.has(`${originalUuid}#${index}`); // keep-ranked
    if (keep) stats.thinkingKept += 1;
    else stats.thinkingDropped += 1;
    return keep;
  });
  row.message["content"] = next;
}

function applyToolOutputMode(
  row: TranscriptRow,
  mode: Mode,
  keepTools: Set<string>,
  ctx: { cache: Parameters<typeof allocateOmission>[0]; sessionId: string },
  stats: { toolOutputsKept: number; toolOutputsPruned: number },
): void {
  if (!isRecord(row.message)) return;
  const content = row.message["content"];
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (!isRecord(block) || block["type"] !== "tool_result") continue;
    if (block["is_error"] === true) {
      stats.toolOutputsKept += 1;
      continue; // errors are cheap + diagnostic; always keep
    }
    const toolUseId =
      typeof block["tool_use_id"] === "string" ? block["tool_use_id"] : null;
    const keep =
      mode === "keep-all"
        ? true
        : mode === "drop"
          ? false
          : toolUseId !== null && keepTools.has(toolUseId); // keep-ranked
    if (keep) {
      stats.toolOutputsKept += 1;
      continue;
    }
    const text = stringifyContent(block["content"]);
    if (!text) {
      stats.toolOutputsKept += 1;
      continue;
    }
    const contentId = allocateOmission(ctx.cache, ctx.sessionId, text);
    block["content"] = outputOmissionNotice(
      "Tool output omitted by condense. Retrieve with read_omitted_content if the exact I/O is needed and cannot be re-derived by re-running the tool.",
      text.length,
      contentId,
    );
    stats.toolOutputsPruned += 1;
  }
}

// --- transcript surgery (ported from magic-compact, condense-renamed) --------

function copyTurnVerbatim(
  turn: Turn,
  rows: TranscriptRow[],
  copiedUuids: Map<string, string>,
  sessionId: string,
  timestamp: string,
  initialParentUuid: string | null,
): string | null {
  let parentUuid = initialParentUuid;
  for (const row of turn.rows) {
    const newParent = row.parentUuid
      ? copiedUuids.get(row.parentUuid) ?? parentUuid
      : parentUuid;
    const copied = copyRow(row, sessionId, timestamp, newParent);
    copiedUuids.set(row.uuid, copied.uuid);
    rows.push(copied);
    parentUuid = copied.uuid;
  }
  return parentUuid;
}

function copyRow(
  row: TranscriptRow,
  sessionId: string,
  timestamp: string,
  parentUuid: string | null,
): TranscriptRow {
  const copied = structuredClone(row) as TranscriptRow;
  copied.uuid = randomUUID();
  copied.parentUuid = parentUuid;
  copied.sessionId = sessionId;
  copied.timestamp = timestamp;
  return copied;
}

function copySessionFields(
  row: TranscriptRow,
  sessionId: string,
  timestamp: string,
): TranscriptRow {
  const copied = structuredClone(row) as TranscriptRow;
  copied.sessionId = sessionId;
  copied.timestamp = timestamp;
  copied.isSidechain = false;
  delete copied.message;
  return copied;
}

function collectCompletedToolUseIds(turns: Turn[]): Set<string> {
  const ids = new Set<string>();
  for (const turn of turns) {
    for (const row of turn.rows) {
      if (!isRecord(row.message)) continue;
      const content = row.message["content"];
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (
          isRecord(block)
          && block["type"] === "tool_result"
          && block["is_error"] !== true
          && typeof block["tool_use_id"] === "string"
        ) {
          ids.add(block["tool_use_id"]);
        }
      }
    }
  }
  return ids;
}

function collectToolNamesById(turns: Turn[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const turn of turns) {
    for (const row of turn.rows) {
      if (!isRecord(row.message)) continue;
      const content = row.message["content"];
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (
          isRecord(block)
          && block["type"] === "tool_use"
          && typeof block["id"] === "string"
          && typeof block["name"] === "string"
        ) {
          names.set(block["id"], block["name"]);
        }
      }
    }
  }
  return names;
}

function isToolResultRow(row: TranscriptRow): boolean {
  if (row.type !== "user" || !isRecord(row.message)) return false;
  const content = row.message["content"];
  return (
    Array.isArray(content)
    && content.some((b) => isRecord(b) && b["type"] === "tool_result")
  );
}

function sourceTurns(plan: Plan): Turn[] {
  return [...plan.prefixTurns, ...plan.compactedTurns, ...plan.preservedTurns];
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === undefined || content === null) return "";
  return JSON.stringify(content);
}

await main();
