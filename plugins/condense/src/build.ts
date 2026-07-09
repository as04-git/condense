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
import { readFile, unlink } from "node:fs/promises";
import { forkForCondense } from "./fork";
import {
  allocateOmission,
  loadOmissionCache,
  noticeOverhead,
  outputOmissionNotice,
  saveOmissionCache,
} from "./omission";
import {
  bigInputSize,
  hasPrunedInput,
  injectedInfo,
  isCondenseNotice,
  pruneToolInput,
} from "./prune";
import {
  buildAssistantTurns,
  isRecord,
  readActiveTranscriptRows,
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


export async function runBuild(sourcePath: string, rankingValue: unknown) {
  const ranking = normalizeRanking(rankingValue);

  // --- Analyze the SOURCE (original uuids) to decide the fork slice + which
  // rows the post-pass must leave untouched. ------------------------------
  const sourceRows = await readActiveTranscriptRows(sourcePath);
  const turns = buildAssistantTurns(sourceRows);
  // Strip the trailing /condense operation turn(s) (skill dump + analyze call):
  // the fork's upToMessageId slice ends at the last real message before them.
  let end = turns.length;
  while (end > 0 && isCondenseOperationTurn(turns[end - 1])) end--;
  const keptTurns = turns.slice(0, end);
  if (keptTurns.length <= ranking.keepTurns) {
    throw new Error("Nothing to compact: no turns older than keepTurns.");
  }
  const lastKept = keptTurns[keptTurns.length - 1];
  const cutoffUuid = lastKept.rows[lastKept.rows.length - 1]?.uuid;
  // The keepTurns most-recent turns are left fully verbatim — collect their
  // ORIGINAL row uuids so the post-pass skips them (they were never candidates).
  const preserved = new Set<string>();
  for (const t of keptTurns.slice(keptTurns.length - ranking.keepTurns)) {
    for (const r of t.rows) if (typeof r.uuid === "string") preserved.add(r.uuid);
  }

  // Generation + title come from the SOURCE file's title meta rows. Read them
  // RAW: they are minimal ({type, customTitle/agentName, sessionId,
  // condenseGeneration}) with no uuid, so readTranscriptRows' isTranscriptRow
  // filter would drop them.
  const titleRows = (await readFile(sourcePath, "utf8"))
    .split("\n")
    .flatMap((line) => {
      const t = line.trim();
      if (!t) return [];
      try {
        const r = JSON.parse(t);
        return isRecord(r) && (r["type"] === "custom-title" || r["type"] === "agent-name")
          ? [r as TranscriptRow]
          : [];
      } catch {
        return [];
      }
    });
  const generation = parentGeneration(titleRows) + 1;
  const title = computeCondensedTitle(titleRows, sourceRows, generation, ranking.title);

  // --- Fork via the SDK (owns clone identity, uuid remap, chain, metadata). --
  const fork = await forkForCondense(sourcePath, { upToMessageId: cutoffUuid, title });
  try {
    const cache = await loadOmissionCache(fork.sessionId);
    // io is populated after the toolNames/toolInputs scan below.
    let io: { cache: typeof cache; sessionId: string; toolNames: Map<string, string>; toolInputs: Map<string, JsonRecord> };
    const stats = {
      thinkingKept: 0,
      thinkingDropped: 0,
      toolInputsKept: 0,
      toolInputsPruned: 0,
      toolInputsPrePruned: 0,
      toolOutputsKept: 0,
      toolOutputsPruned: 0,
      toolOutputsPrePruned: 0,
      injectedKept: 0,
      injectedPrunedToContentId: 0,
      injectedSkillNoted: 0,
      emptyAssistantRowsDropped: 0,
      priorMarkersDropped: 0,
      skillsNoted: [] as string[],
    };
    const attachMode = ranking.modes.attachments;
    const keepAttachments = new Set(ranking.keepAttachments);
    const keepThinking = new Set(
      ranking.keepThinking.map((t) => `${t.uuid}#${t.blockIndex}`),
    );

    // Build tool-use maps for context-aware output notices. tool_use blocks carry
    // the tool name and input; their matching tool_result carries the output but
    // not the name/input. Mapping by tool_use_id lets the output pruner say
    // "Read output (/path/to/file.ts)" instead of generic "Tool output".
    const toolNames = new Map<string, string>();
    const toolInputs = new Map<string, JsonRecord>();
    for (const row of fork.rows) {
      if (!isRecord(row.message)) continue;
      const c = row.message["content"];
      if (!Array.isArray(c)) continue;
      for (const b of c) {
        if (isRecord(b) && b["type"] === "tool_use" && typeof b["id"] === "string") {
          if (typeof b["name"] === "string") toolNames.set(b["id"], b["name"]);
          if (isRecord(b["input"])) toolInputs.set(b["id"], b["input"] as JsonRecord);
        }
      }
    }

    io = { cache, sessionId: fork.sessionId, toolNames, toolInputs };
    // --- Post-pass: prune content in the forked rows in place. Refs from the
    // ranking are keyed by ORIGINAL uuids; each forked row carries its original
    // uuid in forkedFrom.messageUuid. ---------------------------------------
    const drop = new Set<string>(); // forked uuids to remove (empty rows, old markers)
    for (const row of fork.rows) {
      if (typeof row.uuid !== "string") continue;
      const ff = row["forkedFrom"];
      const originalUuid = isRecord(ff) && typeof ff["messageUuid"] === "string"
        ? ff["messageUuid"]
        : undefined;
      // Strip a prior generation's visible marker so markers don't accumulate.
      if (row["condenseMarker"] === true) {
        drop.add(row.uuid);
        stats.priorMarkersDropped += 1;
        continue;
      }
      // keepTurns region: untouched.
      if (originalUuid && preserved.has(originalUuid)) continue;

      if (row.type === "assistant") {
        filterThinking(row, originalUuid ?? "", ranking.modes.thinking, keepThinking, stats);
        applyToolInputMode(row, attachMode, keepAttachments, io, stats);
        if (isEmptyMessageContent(row)) {
          drop.add(row.uuid);
          stats.emptyAssistantRowsDropped += 1;
        }
      } else if (isToolResultRow(row)) {
        applyToolOutputMode(row, attachMode, keepAttachments, io, stats);
      } else if (row.type === "user") {
        applyInjectedMode(row, originalUuid ?? "", attachMode, keepAttachments, io, stats);
      }
    }

    // Drop marked rows and re-chain any child of a dropped row to the nearest
    // surviving ancestor (localized — NOT the full clone re-chain the SDK owns).
    const parentOf = new Map<string, string | null>();
    for (const r of fork.rows) {
      if (typeof r.uuid === "string") {
        parentOf.set(r.uuid, typeof r.parentUuid === "string" ? r.parentUuid : null);
      }
    }
    const resolve = (u: string | null): string | null => {
      while (u && drop.has(u)) u = parentOf.get(u) ?? null;
      return u;
    };
    const kept = fork.rows.filter((r) => !(typeof r.uuid === "string" && drop.has(r.uuid)));
    for (const r of kept) {
      if (typeof r.parentUuid === "string" && drop.has(r.parentUuid)) {
        r.parentUuid = resolve(r.parentUuid);
      }
    }

    // --- Own the title + append the closing marker. Strip any title rows the
    // SDK wrote/derived (or the source carried) so ours are authoritative, then
    // append a fresh custom-title + agent-name pair and the deterministic marker
    // (the SDK has no marker mechanism). --------------------------------------
    const stripped = kept.filter(
      (r) =>
        r.type !== "custom-title" && r.type !== "agent-name" && r.type !== "ai-title",
    );
    const finalRows = dedupeSingletonMeta(stripped as JsonRecord[]);
    finalRows.push(...makeTitleRows(fork.sessionId, title, generation));
    const markerRow = makeMarkerRow(
      fork.rows,
      kept,
      fork.sessionId,
      condenseMarkerText(parentSessionIdOf(sourcePath), generation, ranking.keepTurns, stats),
    );
    if (markerRow) finalRows.push(markerRow);

    await saveOmissionCache(fork.sessionId, cache);
    await writeTranscriptEntries(fork.transcriptPath, finalRows);

    return {
      sessionId: fork.sessionId,
      transcriptPath: fork.transcriptPath,
      generation,
      stats,
    };
  } catch (error) {
    await unlink(fork.transcriptPath).catch(() => undefined);
    throw error;
  }
}

// Source session id from its file path (basename without .jsonl).
function parentSessionIdOf(sourcePath: string): string {
  const base = sourcePath.split("/").pop() ?? sourcePath;
  return base.replace(/\.jsonl$/, "");
}

// Emit BOTH title rows CC needs, keyed to the new session: `custom-title` (the
// /resume picker + tab title) and `agent-name` (the in-app banner pill). We own
// the title rather than relying on forkSession's `title` param, which the SDK
// ignores when `upToMessageId` is set (and otherwise appends a "(fork)" title).
// These are pure metadata rows — minimal shape, no uuid/parentUuid/timestamp.
function makeTitleRows(sessionId: string, title: string, generation: number): JsonRecord[] {
  return [
    { type: "custom-title", customTitle: title, sessionId, condenseGeneration: generation },
    { type: "agent-name", agentName: title, sessionId },
  ];
}

// Build the visible closing marker as the final content row (the single leaf).
function makeMarkerRow(
  forkRows: TranscriptRow[],
  keptRows: TranscriptRow[],
  sessionId: string,
  text: string,
): JsonRecord | null {
  const template = forkRows.find((r) => r.type === "user" || r.type === "assistant");
  if (!isRecord(template)) return null;
  // Carry the session/environment fields CC stamps on a message row; drop the
  // message-specific ones we set fresh.
  const fields: JsonRecord = { ...template };
  for (const k of ["message", "uuid", "parentUuid", "type", "condenseMarker", "requestId", "isMeta", "forkedFrom"]) {
    delete fields[k];
  }
  // Newest timestamp so the marker is the unambiguous leaf (max-ts tiebreak).
  let maxMs = 0;
  for (const r of forkRows) {
    const t = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
    if (Number.isFinite(t)) maxMs = Math.max(maxMs, t);
  }
  const tail = keptRows[keptRows.length - 1];
  return {
    ...fields,
    type: "user",
    uuid: randomUUID(),
    parentUuid: isRecord(tail) && typeof tail.uuid === "string" ? tail.uuid : null,
    sessionId,
    condenseMarker: true,
    timestamp: new Date((maxMs || Date.now()) + 1000).toISOString(),
    message: { role: "user", content: text },
  };
}

// Current-state singleton meta types (last-wins per sessionId, confirmed from
// v2.1.88 sessionStorage re-stamp logic); only the latest is meaningful.
// agent-name / custom-title / ai-title are stripped and re-emitted fresh by the
// post-pass (see makeTitleRows); the rest are deduped to their last occurrence
// so they don't compound across generations.
const SINGLETON_META = new Set([
  "mode",
  "permission-mode",
  "agent-color",
  "agent-setting",
  "pr-link",
  "tag",
]);

function dedupeSingletonMeta(entries: JsonRecord[]): JsonRecord[] {
  const lastIndex = new Map<string, number>();
  entries.forEach((e, i) => {
    const t = isRecord(e) ? String(e["type"]) : "";
    if (SINGLETON_META.has(t)) lastIndex.set(t, i);
  });
  return entries.filter((e, i) => {
    const t = isRecord(e) ? String(e["type"]) : "";
    return !SINGLETON_META.has(t) || lastIndex.get(t) === i;
  });
}

// The parent's generation, read from its preserved "🗜 condense #N —" title
// (0 if the parent was never condensed). The boundary's generation field is not
// in the active chain, so the title is the durable carrier.
function parentGeneration(metadataEntries: JsonRecord[]): number {
  let max = 0;
  for (const e of metadataEntries) {
    if (!isRecord(e) || e["type"] !== "custom-title") continue;
    // Prefer a durable numeric field; fall back to parsing the title text.
    if (typeof e["condenseGeneration"] === "number" && e["condenseGeneration"] > max) {
      max = e["condenseGeneration"];
    } else if (typeof e["customTitle"] === "string") {
      const m = e["customTitle"].match(/^🗜 condense #(\d+) —/u);
      if (m && Number(m[1]) > max) max = Number(m[1]);
    }
  }
  return max;
}

function firstUserPrompt(rows: TranscriptRow[]): string {
  for (const row of rows) {
    if (row.type !== "user" || row["isMeta"] === true || !isRecord(row.message)) continue;
    const c = row.message["content"];
    if (typeof c === "string") {
      if (c.trim()) return c.trim();
      continue;
    }
    if (Array.isArray(c)) {
      // Skip tool-result rows; otherwise take the first text from a list message.
      if (c.some((b) => isRecord(b) && b["type"] === "tool_result")) continue;
      const text = c
        .filter((b) => isRecord(b) && b["type"] === "text")
        .map((b) => String((b as JsonRecord)["text"] ?? ""))
        .join(" ")
        .trim();
      if (text) return text;
    }
  }
  return "session";
}

// Title for the compacted session: "🗜 condense #N — <base>". N is the
// generation; <base> carries the parent condensed session's <desc> forward (or
// derives from the first user prompt), stripping prior decoration so titles
// don't stack. Passed to forkSession as `title` (which writes the custom-title
// row); the matching agent-name banner row is appended separately.
function computeCondensedTitle(
  titleRows: TranscriptRow[],
  rows: TranscriptRow[],
  generation: number,
  titleOverride?: string,
): string {
  let base = titleOverride ?? "";
  if (!base) {
    let parent = "";
    for (const e of titleRows) {
      if (e.type === "custom-title" && typeof e["customTitle"] === "string") {
        parent = e["customTitle"];
      }
    }
    const m = parent.match(/^🗜 condense #\d+ — (.+)$/u);
    base = m ? m[1].trim() : firstUserPrompt(rows);
  }
  if (base.length > 80) base = `${base.slice(0, 80).trim()}…`;
  return `🗜 condense #${generation} — ${base}`;
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

// A turn is the /condense operation's own turn if it carries the condense skill
// dump or a call to the condense CLI — used to strip it from the compacted output.
function isCondenseOperationTurn(turn: Turn): boolean {
  for (const row of turn.rows) {
    if (!isRecord(row.message)) continue;
    const content = row.message["content"];
    const text = Array.isArray(content)
      ? content
          .filter((b) => isRecord(b) && b["type"] === "text")
          .map((b) => String((b as JsonRecord)["text"] ?? ""))
          .join("\n")
      : typeof content === "string"
        ? content
        : "";
    if (
      /Base directory for this skill:\s*\S*\/skills\/condense\b/.test(text) ||
      /condense\/src\/condense\.ts\s+(analyze|build)\b/.test(text)
    ) {
      return true;
    }
  }
  return false;
}

function condenseMarkerText(
  sourceSessionId: string,
  generation: number,
  keepTurns: number,
  stats: {
    thinkingKept: number;
    thinkingDropped: number;
    toolInputsKept: number;
    toolInputsPruned: number;
    toolInputsPrePruned: number;
    toolOutputsKept: number;
    toolOutputsPruned: number;
    toolOutputsPrePruned: number;
    injectedPrunedToContentId: number;
    injectedSkillNoted: number;
    skillsNoted: string[];
  },
): string {
  const skills = stats.skillsNoted.length ? ` [${stats.skillsNoted.join(", ")}]` : "";
  const prePrunedOut = stats.toolOutputsPrePruned;
  const prePrunedIn = stats.toolInputsPrePruned;
  const lines = [
    `🗜 CONDENSED SESSION (generation ${generation}) — you are now inside the condensed result.`,
    `Continue the work below; do NOT re-condense unless the user asks. This marker is deterministic (built from the build step's own tallies) — trust it over memory for what is present vs pruned.`,
    ``,
    `FRESHLY PRUNED this generation (bytes just moved out; recoverable):`,
    `  • ${stats.toolOutputsPruned} tool-output(s) + ${stats.toolInputsPruned} tool-input(s) — placeholder inline; retrieve exact bytes with read_omitted_content <Content-ID shown at each placeholder>.`,
  ];
  if (stats.injectedSkillNoted > 0) {
    lines.push(
      `  • ${stats.injectedSkillNoted} skill dump(s)${skills} — re-invoke the skill to reload (a Content-ID fallback is also on each note).`,
    );
  }
  if (stats.injectedPrunedToContentId > 0) {
    lines.push(
      `  • ${stats.injectedPrunedToContentId} other injection(s) — retrieve with read_omitted_content <Content-ID at each placeholder>.`,
    );
  }
  lines.push(
    `  • ${stats.thinkingDropped} thinking block(s) dropped — prior reasoning; NOT recoverable, but all prose is intact.`,
    ``,
    `ALREADY PRUNED by an earlier generation (still just placeholders inline; recoverable):`,
    `  • ${prePrunedOut} tool-output(s) + ${prePrunedIn} tool-input(s) — retrieve with read_omitted_content <Content-ID at each placeholder>.`,
    ``,
    `GENUINELY KEPT INLINE (full content present, nothing to retrieve):`,
    `  • ${stats.toolOutputsKept} tool-output(s), ${stats.toolInputsKept} tool-input(s), ${stats.thinkingKept} thinking block(s).`,
    `  • ALL prose (your text + user messages) and the last ${keepTurns} turn(s) — fully untouched.`,
    ``,
    `Condensed from parent session ${sourceSessionId} (unchanged on disk — /resume it to see everything un-pruned).`,
  );
  return lines.join("\n");
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
    skillsNoted: string[];
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
  // Store the FULL original content (all blocks), not just text, so retrieval
  // reconstructs the row faithfully even if it held non-text blocks.
  const stored = Array.isArray(content) ? JSON.stringify(content) : String(content ?? "");
  // Always allocate a Content-ID — even for skill dumps. Skills are reloadable,
  // but if the skill-marker heuristic ever misclassifies a non-skill blob, the
  // Content-ID is the safety net against data loss.
  const contentId = allocateOmission(io.cache, io.sessionId, stored);

  let notice: string;
  if (inj.skill) {
    notice =
      `[Skill "${inj.skill}" output (${inj.size} chars) omitted by condense. `
      + `Re-invoke: type /${inj.skill} or Skill tool. Fallback retrieve: ${contentId}]`;
    stats.injectedSkillNoted += 1;
    if (!stats.skillsNoted.includes(inj.skill)) stats.skillsNoted.push(inj.skill);
  } else {
    notice = outputOmissionNotice("injected content omitted", inj.size, contentId);
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
  stats: { toolInputsKept: number; toolInputsPruned: number; toolInputsPrePruned: number },
): void {
  if (!isRecord(row.message)) return;
  const content = row.message["content"];
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (!isRecord(block) || block["type"] !== "tool_use") continue;
    if (hasPrunedInput(block)) {
      stats.toolInputsPrePruned += 1; // pruned by an earlier condense
      continue;
    }
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
  ctx: { cache: Parameters<typeof allocateOmission>[0]; sessionId: string; toolNames: Map<string, string>; toolInputs: Map<string, JsonRecord> },
  stats: { toolOutputsKept: number; toolOutputsPruned: number; toolOutputsPrePruned: number },
): void {
  if (!isRecord(row.message)) return;
  const content = row.message["content"];
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (!isRecord(block) || block["type"] !== "tool_result") continue;
    const text = stringifyContent(block["content"]);
    // Content already pruned by an earlier condense: its bytes are NOT inline
    // (only the notice is). Classify as pre-pruned, never as genuinely kept, and
    // never re-prune (that would nest notice→notice).
    if (text && isCondenseNotice(text)) {
      stats.toolOutputsPrePruned += 1;
      continue;
    }
    // Genuinely kept inline (full content present): errors (cheap + diagnostic)
    // and empties.
    if (block["is_error"] === true || !text) {
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
    const toolName = toolUseId ? ctx.toolNames.get(toolUseId) ?? "?" : "?";
    const desc = smartOutputDescription(toolName, text, toolUseId ? ctx.toolInputs.get(toolUseId) : undefined);
    if (noticeOverhead(desc) >= text.length) {
      stats.toolOutputsKept += 1;
      continue;
    }
    const contentId = allocateOmission(ctx.cache, ctx.sessionId, text);
    block["content"] = outputOmissionNotice(desc, text.length, contentId);
    stats.toolOutputsPruned += 1;
  }
}

function isToolResultRow(row: TranscriptRow): boolean {
  if (row.type !== "user" || !isRecord(row.message)) return false;
  const content = row.message["content"];
  return (
    Array.isArray(content)
    && content.some((b) => isRecord(b) && b["type"] === "tool_result")
  );
}

function isEmptyMessageContent(row: TranscriptRow): boolean {
  if (!isRecord(row.message)) return false;
  const content = row.message["content"];
  if (Array.isArray(content)) return content.length === 0;
  if (typeof content === "string") return content.trim() === "";
  return false;
}

function previewLine(text: string, max = 80): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.length <= max ? line : `${line.slice(0, max).trim()}…`;
}

function smartOutputDescription(
  toolName: string,
  text: string,
  toolInput?: JsonRecord,
): string {
  // Task-notification (agent result).
  const taskMatch = text.match(/<summary>\s*(?:Agent\s+)?"([^"]+)"/);
  const resultMatch = text.match(/<result>\s*([\s\S]{1,80})/);
  if (taskMatch || resultMatch) {
    const d = taskMatch ? ` "${taskMatch[1]}"` : "";
    const p = resultMatch ? `: "${previewLine(resultMatch[1])}"` : "";
    return `agent-result${d} omitted${p}`;
  }

  // File ops — show path.
  if (toolInput && (toolName === "Read" || toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit")) {
    const path = toolInput["file_path"] ?? toolInput["notebook_path"];
    if (typeof path === "string") return `${toolName} output omitted (${path}); reread file`;
  }

  // Bash — show command head.
  if (toolName === "Bash" && toolInput && typeof toolInput["command"] === "string") {
    return `Bash output omitted (${previewLine(toolInput["command"], 50)})`;
  }

  // WebFetch/WebSearch.
  if (toolName === "WebFetch" && toolInput && typeof toolInput["url"] === "string")
    return `WebFetch omitted (${toolInput["url"]})`;
  if (toolName === "WebSearch" && toolInput && typeof toolInput["query"] === "string")
    return `WebSearch omitted ("${toolInput["query"]}")`;

  // Fallback — tool name + content preview.
  const head = previewLine(text, 50);
  return `${toolName} output omitted${head ? `: "${head}"` : ""}`;
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
