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
import { bigInputSize, injectedInfo, isCondenseNotice, pruneToolInput } from "./prune";
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
  title?: string; // optional: override the descriptive part of the session title
  modes: { thinking: Mode; attachments: Mode };
  keepThinking: { uuid: string; blockIndex: number }[];
  // Refs the model chose to KEEP inline. Each ref is one of:
  //   "o:<toolUseId>"  tool-output attachment
  //   "i:<toolUseId>"  tool-input attachment (big Write/Edit/Bash/... payload)
  //   "s:<rowUuid>"    skill/injected attachment
  keepAttachments: string[];
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

export async function runBuild(sourcePath: string, rankingValue: unknown) {
  const ranking = normalizeRanking(rankingValue);

  const destination = await createTranscriptSession(sourcePath);
  try {
    const rows = await readActiveTranscriptRows(sourcePath);
    const plan = createPlan(rows, ranking.keepTurns);
    if (plan.compactedTurns.length === 0) {
      throw new Error("Nothing to compact: no turns older than keepTurns.");
    }

    // Generation is read from the parent's preserved "condense #N" title — the
    // boundary's generation field is NOT in the active chain, but the title is.
    const metadataEntries = await readPreservedMetadataEntries(
      sourcePath,
      plan.baseRow.sessionId,
      destination.sessionId,
    );
    const generation = parentGeneration(metadataEntries) + 1;
    const { compactedRows, stats } = await buildCompactedRows(
      plan,
      destination.sessionId,
      ranking,
      generation,
    );
    const titledMetadata = withCondensedTitle(
      metadataEntries,
      rows,
      destination.sessionId,
      generation,
      ranking.title,
    );
    await writeTranscriptEntries(destination.transcriptPath, [
      ...titledMetadata,
      ...compactedRows,
    ]);

    return {
      sessionId: destination.sessionId,
      transcriptPath: destination.transcriptPath,
      generation,
      stats,
    };
  } catch (error) {
    await unlink(destination.transcriptPath).catch(() => undefined);
    throw error;
  }
}

// The parent's generation, read from its preserved "🗜 condense #N —" title
// (0 if the parent was never condensed). The boundary's generation field is not
// in the active chain, so the title is the durable carrier.
function parentGeneration(metadataEntries: JsonRecord[]): number {
  for (const e of metadataEntries) {
    if (isRecord(e) && e["type"] === "custom-title" && typeof e["customTitle"] === "string") {
      const m = e["customTitle"].match(/^🗜 condense #(\d+) —/u);
      if (m) return Number(m[1]);
    }
  }
  return 0;
}

function firstUserPrompt(rows: TranscriptRow[]): string {
  for (const row of rows) {
    if (row.type === "user" && row["isMeta"] !== true && isRecord(row.message)) {
      const c = row.message["content"];
      if (typeof c === "string" && c.trim()) return c.trim();
    }
  }
  return "session";
}

// Session title for the compacted session: "🗜 condense #N — <base>". N is the
// generation (survives repeated condensing via the boundary's generation field);
// <base> strips any prior condense/branch decoration so titles don't stack.
function withCondensedTitle(
  metadataEntries: JsonRecord[],
  rows: TranscriptRow[],
  sessionId: string,
  generation: number,
  titleOverride?: string,
): JsonRecord[] {
  let base = titleOverride ?? "";
  if (!base) {
    // If the parent was already a condensed session ("🗜 condense #N — <desc>"),
    // carry its <desc> forward (strip the prefix). Otherwise derive from the
    // first user prompt — not the parent's auto/branch title.
    let parent = "";
    for (const e of metadataEntries) {
      if (isRecord(e) && e["type"] === "custom-title" && typeof e["customTitle"] === "string") {
        parent = e["customTitle"];
      }
    }
    const m = parent.match(/^🗜 condense #\d+ — (.+)$/u);
    base = m ? m[1].trim() : firstUserPrompt(rows);
  }
  if (base.length > 80) base = `${base.slice(0, 80).trim()}…`;
  const customTitle = `🗜 condense #${generation} — ${base}`;

  let replaced = false;
  const mapped = metadataEntries.map((e) => {
    if (isRecord(e) && e["type"] === "custom-title") {
      replaced = true;
      return { ...e, customTitle, sessionId };
    }
    return e;
  });
  if (!replaced) {
    mapped.unshift({ type: "custom-title", customTitle, sessionId });
  }
  return mapped;
}

function normalizeRanking(value: unknown): Ranking {
  const v = isRecord(value) ? value : {};
  const modes = isRecord(v["modes"]) ? v["modes"] : {};
  const asMode = (m: unknown, dflt: Mode): Mode =>
    m === "keep-all" || m === "keep-ranked" || m === "drop" ? m : dflt;
  return {
    keepTurns:
      typeof v["keepTurns"] === "number" && Number.isFinite(v["keepTurns"])
        ? Math.max(0, Math.floor(v["keepTurns"]))
        : 1,
    title: typeof v["title"] === "string" && v["title"].trim() ? v["title"].trim() : undefined,
    modes: {
      thinking: asMode(modes["thinking"], "keep-ranked"),
      attachments: asMode(modes["attachments"], "keep-ranked"),
    },
    keepThinking: Array.isArray(v["keepThinking"])
      ? v["keepThinking"].flatMap((e) =>
          isRecord(e) && typeof e["uuid"] === "string" && typeof e["blockIndex"] === "number"
            ? [{ uuid: e["uuid"], blockIndex: e["blockIndex"] }]
            : [],
        )
      : [],
    keepAttachments: Array.isArray(v["keepAttachments"])
      ? v["keepAttachments"].filter((x): x is string => typeof x === "string")
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
  generation: number,
): Promise<{ compactedRows: TranscriptRow[]; stats: JsonRecord }> {
  const rows: TranscriptRow[] = [];
  const copiedUuids = new Map<string, string>();
  const omissionCache = await loadOmissionCache(sessionId);
  const timestamp = new Date().toISOString();
  const keepThinking = new Set(
    ranking.keepThinking.map((e) => `${e.uuid}#${e.blockIndex}`),
  );
  const keepAttachments = new Set(ranking.keepAttachments);
  const attachMode = ranking.modes.attachments;

  const stats = {
    thinkingKept: 0,
    thinkingDropped: 0,
    toolInputsKept: 0,
    toolInputsPruned: 0,
    toolOutputsKept: 0,
    toolOutputsPruned: 0,
    injectedKept: 0,
    injectedPrunedToContentId: 0,
    injectedSkillNoted: 0,
    emptyAssistantRowsDropped: 0,
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
    condense: { boundary: true, generation },
  });
  let parentUuid: string | null = boundaryUuid;

  // Prefix + preserved turns: verbatim.
  for (const turn of plan.prefixTurns) {
    parentUuid = copyTurnVerbatim(turn, rows, copiedUuids, sessionId, timestamp, parentUuid);
  }

  // Compacted region: prose verbatim; thinking per mode; tool inputs + outputs
  // per the (shared) tools mode. keepTurns region left fully untouched.
  const io = { cache: omissionCache, sessionId };
  for (const turn of plan.compactedTurns) {
    for (const row of turn.rows) {
      const newParent = row.parentUuid
        ? copiedUuids.get(row.parentUuid) ?? parentUuid
        : parentUuid;
      const copied = copyRow(row, sessionId, timestamp, newParent);

      if (row.type === "assistant") {
        filterThinking(copied, row.uuid, ranking.modes.thinking, keepThinking, stats);
        applyToolInputMode(copied, attachMode, keepAttachments, io, stats);
        if (isEmptyMessageContent(copied)) {
          // A thinking-only assistant message whose thinking was all dropped
          // would become content:[] — invalid on resume. Drop the row and
          // rewire any children to its parent. Such rows carry no tool_use, so
          // no tool_result depends on them.
          copiedUuids.set(row.uuid, newParent ?? boundaryUuid);
          stats.emptyAssistantRowsDropped += 1;
          continue; // do not push; do not advance parentUuid
        }
      } else if (isToolResultRow(row)) {
        applyToolOutputMode(copied, attachMode, keepAttachments, io, stats);
      } else if (row.type === "user") {
        // Genuine user prose (string content) is untouched; only injected
        // list-content (skill dumps / structured injections) is a rankable attachment.
        applyInjectedMode(copied, row.uuid, attachMode, keepAttachments, io, stats);
      }
      // everything else: verbatim (already copied)

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

function applyInjectedMode(
  row: TranscriptRow,
  originalUuid: string,
  mode: Mode,
  keepInjected: Set<string>,
  io: { cache: Parameters<typeof allocateOmission>[0]; sessionId: string },
  stats: {
    injectedKept: number;
    injectedPrunedToContentId: number;
    injectedSkillNoted: number;
  },
): void {
  const inj = injectedInfo(row);
  if (!inj) return; // not injected (genuine user prose) — leave verbatim
  const keep =
    mode === "keep-all"
      ? true
      : mode === "drop"
        ? false
        : keepInjected.has(`s:${originalUuid}`); // keep-ranked
  if (keep) {
    stats.injectedKept += 1;
    return;
  }
  if (!isRecord(row.message)) return;
  const content = row.message["content"];
  const text = Array.isArray(content)
    ? content
        .filter((b) => isRecord(b) && b["type"] === "text")
        .map((b) => String((b as JsonRecord)["text"] ?? ""))
        .join("\n")
    : "";

  let notice: string;
  if (inj.skill) {
    // Skill output is deterministically reloadable — don't store it, just say so.
    notice =
      `[Skill "${inj.skill}" output (${inj.size} chars) was omitted by condense to reclaim context. `
      + `This was NOT the user's message — it is skill-injected reference material. `
      + `If you need it again, re-invoke the skill (type /${inj.skill}, or use the Skill tool with skill "${inj.skill}").]`;
    stats.injectedSkillNoted += 1;
  } else {
    // Generic injection — store to a retrievable Content-ID.
    const contentId = allocateOmission(io.cache, io.sessionId, text);
    notice = outputOmissionNotice("Injected content omitted by condense", text.length, contentId);
    stats.injectedPrunedToContentId += 1;
  }
  row.message["content"] = [{ type: "text", text: notice }];
}

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

function applyToolInputMode(
  row: TranscriptRow,
  mode: Mode,
  keepInputs: Set<string>,
  io: { cache: Parameters<typeof allocateOmission>[0]; sessionId: string },
  stats: { toolInputsKept: number; toolInputsPruned: number },
): void {
  if (!isRecord(row.message)) return;
  const content = row.message["content"];
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (!isRecord(block) || block["type"] !== "tool_use") continue;
    if (bigInputSize(block) === 0) continue; // small input: always kept verbatim
    const toolUseId = typeof block["id"] === "string" ? block["id"] : null;
    const keep =
      mode === "keep-all"
        ? true
        : mode === "drop"
          ? false
          : toolUseId !== null && keepInputs.has(`i:${toolUseId}`); // keep-ranked
    if (keep) {
      stats.toolInputsKept += 1;
      continue;
    }
    const pruned = pruneToolInput(block, io.cache, io.sessionId);
    if (pruned > 0) stats.toolInputsPruned += 1;
    else stats.toolInputsKept += 1;
  }
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
    const text = stringifyContent(block["content"]);
    // Always keep (never prune): errors (cheap + diagnostic), empties, and
    // content that is already a condense notice (avoid nesting).
    if (block["is_error"] === true || !text || isCondenseNotice(text)) {
      stats.toolOutputsKept += 1;
      continue;
    }
    const toolUseId =
      typeof block["tool_use_id"] === "string" ? block["tool_use_id"] : null;
    const keep =
      mode === "keep-all"
        ? true
        : mode === "drop"
          ? false
          : toolUseId !== null && keepTools.has(`o:${toolUseId}`); // keep-ranked
    if (keep) {
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

function isEmptyMessageContent(row: TranscriptRow): boolean {
  if (!isRecord(row.message)) return false;
  const content = row.message["content"];
  if (Array.isArray(content)) return content.length === 0;
  if (typeof content === "string") return content.trim() === "";
  return false;
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === undefined || content === null) return "";
  return JSON.stringify(content);
}

if (import.meta.main) {
  const [sourcePath, rankingPath] = Bun.argv.slice(2);
  if (!sourcePath || !rankingPath) {
    console.error("usage: bun build.ts <source_transcript_path> <ranking_json_path>");
    process.exit(2);
  }
  runBuild(sourcePath, await Bun.file(rankingPath).json())
    .then((result) => console.log(JSON.stringify(result)))
    .catch((err) => {
      console.error(`build failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
