// analyze.ts — mechanical stats pass for condense.
//
// Reads a Claude Code transcript, splits it into assistant turns (reusing the
// same active-chain logic the build step uses), and returns a per-turn /
// per-type / per-attachment breakdown. The in-session model reads this to make
// grounded keep/prune decisions before the build step.
//
// "Attachments" = the large, non-prose, non-reasoning, RECOVERABLE content the
// model can shed: tool outputs (re-runnable), big tool inputs (on disk +
// Content-ID), and injected/skill dumps (skills are re-invokable). Each carries
// an anchor snippet so the model ranks by recognizing content, not guessing
// turn numbers. Thinking is separate (opaque on disk; anchored by turn context).

import { bigInputSize, injectedInfo, isCondenseNotice } from "./prune";
import {
  buildAssistantTurns,
  isRecord,
  readActiveTranscriptRows,
  type TranscriptRow,
  type Turn,
} from "./transcript";

export type Attachment = {
  ref: string; // "o:<toolUseId>" | "i:<toolUseId>" | "s:<rowUuid>"
  kind: "tool-output" | "tool-input" | "skill" | "injected";
  turn: number;
  size: number;
  head: string; // anchor snippet
  errored?: boolean;
  skill?: string;
};

// Prune-priority tier (soft hint; the model decides). prime-prune = safe to shed
// almost always (superseded stale copy, or a re-invokable skill dump); review =
// live + sizable, the model's judgment call; likely-keep = small/cheap to keep.
type Tier = "prime-prune" | "review" | "likely-keep";

// An operation on a "target" (a file path or a bash command). Earlier ops on the
// same target are SUPERSEDED by later ones — the later op is the current reality,
// so the earlier snapshot is the safest thing to prune.
type Op = { id: string; turn: number; seq: number; name: string; target: string };

// Below this size an attachment isn't worth pruning (the retrieval round-trip
// costs more than the reclaim), so it defaults to likely-keep.
const KEEP_SIZE = 1000;

type ThinkingStat = {
  turn: number;
  uuid: string;
  blockIndex: number;
  signatureSize: number;
};

type TurnStat = {
  turn: number;
  age: number;
  userPrompt: string;
  prose: number;
  thinkingSig: number;
  thinkingBlocks: number;
  toolInput: number;
  toolOutput: number;
  toolCalls: number;
};

type BlockKind =
  | "prose"
  | "thinking"
  | "tool_input"
  | "tool_output"
  | "human_prompt"
  | "injected"
  | "other";

function blockText(block: unknown): number {
  if (!isRecord(block)) return typeof block === "string" ? block.length : 0;
  const t = block["type"];
  if (t === "text") return String(block["text"] ?? "").length;
  if (t === "thinking") return String(block["thinking"] ?? "").length;
  if (t === "tool_use") {
    return (
      JSON.stringify(block["input"] ?? {}).length
      + String(block["name"] ?? "").length
      + String(block["id"] ?? "").length
    );
  }
  if (t === "tool_result") {
    const c = block["content"];
    if (Array.isArray(c)) return c.reduce((n, x) => n + blockText(x), 0);
    return typeof c === "string" ? c.length : JSON.stringify(c ?? "").length;
  }
  return JSON.stringify(block).length;
}

function stringify(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === undefined || content === null) return "";
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        isRecord(b) && typeof b["text"] === "string" ? b["text"] : stringify(b),
      )
      .join(" ");
  }
  return JSON.stringify(content);
}

function preview(s: string, n = 140): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : `${flat.slice(0, n)}…`;
}

function signatureSize(block: unknown): number {
  return isRecord(block) ? String(block["signature"] ?? "").length : 0;
}

// The "target" a tool_use acts on, for supersession: a file path (Read/Edit/
// Write/NotebookEdit) or a bash command string. null = not supersession-eligible
// (no shared target, e.g. Grep/Glob/Task). Exact-match by design — a near-repeat
// (git status vs git status -s) is a DIFFERENT target, so we never falsely flag
// something live as superseded.
function toolTarget(name: string, input: unknown): string | null {
  if (!isRecord(input)) return null;
  const path = input["file_path"] ?? input["notebook_path"];
  if (
    (name === "Read" || name === "Edit" || name === "Write" || name === "NotebookEdit")
    && typeof path === "string"
  ) {
    return `file:${path}`;
  }
  if (name === "Bash" && typeof input["command"] === "string") {
    return `bash:${input["command"]}`;
  }
  return null;
}

// Given all target-bearing ops (across the whole session, not just rankable
// ones), mark every op on a target EXCEPT the last as superseded, recording the
// op that supersedes it.
function computeSupersession(ops: Op[]): Map<string, { turn: number; tool: string }> {
  const byTarget = new Map<string, Op[]>();
  for (const op of ops) {
    const list = byTarget.get(op.target) ?? [];
    list.push(op);
    byTarget.set(op.target, list);
  }
  const superseded = new Map<string, { turn: number; tool: string }>();
  for (const list of byTarget.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.turn - b.turn || a.seq - b.seq);
    const last = list[list.length - 1];
    for (let i = 0; i < list.length - 1; i++) {
      superseded.set(list[i].id, { turn: last.turn, tool: last.name });
    }
  }
  return superseded;
}

function isToolResultRow(row: TranscriptRow): boolean {
  if (row.type !== "user" || !isRecord(row.message)) return false;
  const c = row.message["content"];
  return Array.isArray(c) && c.some((b) => isRecord(b) && b["type"] === "tool_result");
}

function firstLine(text: string, max = 100): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.length <= max ? line : `${line.slice(0, max).trim()}…`;
}

function userPromptText(turn: Turn): string {
  const parts: string[] = [];
  for (const row of turn.userRows) {
    if (!isRecord(row.message)) continue;
    const c = row.message["content"];
    if (typeof c === "string") parts.push(c);
    else if (Array.isArray(c)) {
      for (const b of c) {
        if (isRecord(b) && typeof b["text"] === "string") parts.push(b["text"]);
      }
    }
  }
  return firstLine(parts.join("\n"));
}

export function runAnalyze(rows: TranscriptRow[], keepTurns: number) {
  const turns = buildAssistantTurns(rows);
  const n = turns.length;

  const turnStats: TurnStat[] = [];
  const attachments: Attachment[] = [];
  const thinkingBlocks: ThinkingStat[] = [];
  const typeTotals: Record<BlockKind, number> = {
    prose: 0,
    thinking: 0,
    tool_input: 0,
    tool_output: 0,
    human_prompt: 0,
    injected: 0,
    other: 0,
  };

  const toolNames = new Map<string, string>();
  const ops: Op[] = [];
  let seq = 0;
  turns.forEach((turn, ti) => {
    for (const row of turn.rows) {
      if (!isRecord(row.message)) continue;
      const c = row.message["content"];
      if (!Array.isArray(c)) continue;
      for (const b of c) {
        if (
          isRecord(b)
          && b["type"] === "tool_use"
          && typeof b["id"] === "string"
          && typeof b["name"] === "string"
        ) {
          toolNames.set(b["id"], b["name"]);
          const target = toolTarget(b["name"], b["input"]);
          if (target) ops.push({ id: b["id"], turn: ti, seq: seq++, name: b["name"], target });
        }
      }
    }
  });
  // tool_use_id -> the later op that supersedes it (for outputs AND inputs, both
  // keyed by the producing tool_use's id).
  const superseded = computeSupersession(ops);

  turns.forEach((turn, ti) => {
    const st: TurnStat = {
      turn: ti,
      age: n - 1 - ti,
      userPrompt: userPromptText(turn),
      prose: 0,
      thinkingSig: 0,
      thinkingBlocks: 0,
      toolInput: 0,
      toolOutput: 0,
      toolCalls: 0,
    };

    turn.rows.forEach((row) => {
      const msg = row.message;
      if (!isRecord(msg)) return;
      const content = msg["content"];
      const blocks = Array.isArray(content) ? content : [content];

      if (row.type === "assistant") {
        blocks.forEach((b, bi) => {
          if (isRecord(b) && b["type"] === "thinking") {
            const sig = signatureSize(b);
            st.thinkingSig += sig;
            st.thinkingBlocks += 1;
            // thinking TEXT is empty on disk (display:omitted); count the
            // signature bytes as a (lower-bound) proxy for its context weight.
            typeTotals.thinking += sig;
            thinkingBlocks.push({ turn: ti, uuid: row.uuid, blockIndex: bi, signatureSize: sig });
          } else if (isRecord(b) && b["type"] === "tool_use") {
            st.toolInput += blockText(b);
            st.toolCalls += 1;
            typeTotals.tool_input += blockText(b);
            const bigIn = bigInputSize(b);
            const id = typeof b["id"] === "string" ? b["id"] : null;
            if (bigIn > 0 && id) {
              attachments.push({
                ref: `i:${id}`,
                kind: "tool-input",
                turn: ti,
                size: bigIn,
                head: `${String(b["name"] ?? "?")}: ${preview(stringify(b["input"]))}`,
              });
            }
          } else {
            st.prose += blockText(b);
            typeTotals.prose += blockText(b);
          }
        });
      } else if (row.type === "user") {
        if (isToolResultRow(row)) {
          for (const b of blocks) {
            if (isRecord(b) && b["type"] === "tool_result") {
              const size = blockText(b);
              st.toolOutput += size;
              typeTotals.tool_output += size;
              const id = typeof b["tool_use_id"] === "string" ? b["tool_use_id"] : null;
              const errored = b["is_error"] === true;
              // Skip already-pruned outputs (notices) — not reclaimable, and
              // re-pruning them would nest notices.
              if (id && !errored && !isCondenseNotice(stringify(b["content"]))) {
                attachments.push({
                  ref: `o:${id}`,
                  kind: "tool-output",
                  turn: ti,
                  size,
                  head: `${toolNames.get(id) ?? "?"}: ${preview(stringify(b["content"]))}`,
                  errored,
                });
              }
            } else {
              typeTotals.tool_output += blockText(b);
            }
          }
        } else {
          const s = blocks.reduce((acc, b) => acc + blockText(b), 0);
          const inj = injectedInfo(row);
          if (inj) {
            typeTotals.injected += s;
            attachments.push({
              ref: `s:${row.uuid}`,
              kind: inj.skill ? "skill" : "injected",
              turn: ti,
              size: inj.size,
              head: preview(stringify(content)),
              skill: inj.skill ?? undefined,
            });
          } else {
            typeTotals.human_prompt += s;
          }
        }
      }
    });

    turnStats.push(st);
  });

  const grand = Object.values(typeTotals).reduce((a, b) => a + b, 0) || 1;
  const rankable = (turn: number) => turn < n - keepTurns;

  // Enrich each candidate with prune-priority signals so the model ranks by
  // scanning a pre-tiered list instead of reasoning over raw items. The metrics
  // ORDER and ANNOTATE; they never decide — build acts only on the model's
  // explicit keep-list. The model's job is to catch what the tiers get wrong
  // (an old-but-live item; a small-but-critical one).
  const enrich = (a: Attachment) => {
    const id = a.ref.startsWith("o:") || a.ref.startsWith("i:") ? a.ref.slice(2) : null;
    const sup = id ? superseded.get(id) : undefined;
    const age = n - 1 - a.turn;
    const tier: Tier = sup
      ? "prime-prune"
      : a.kind === "skill"
        ? "prime-prune"
        : a.size < KEEP_SIZE
          ? "likely-keep"
          : "review";
    // Superseded + skill dumps float to the top; then by size, then age.
    const pruneScore =
      (sup ? 1e9 : 0) + (a.kind === "skill" ? 5e8 : 0) + a.size + age * 100;
    return {
      ...a,
      age,
      superseded: Boolean(sup),
      supersededBy: sup ? `${sup.tool}@turn${sup.turn}` : null,
      tier,
      pruneScore,
    };
  };

  const rankableAttachments = attachments
    .filter((a) => rankable(a.turn))
    .map(enrich)
    .sort((a, b) => b.pruneScore - a.pruneScore);
  const rankableThinking = thinkingBlocks.filter((t) => rankable(t.turn));

  const tierSummary = (["prime-prune", "review", "likely-keep"] as Tier[]).map((t) => {
    const items = rankableAttachments.filter((a) => a.tier === t);
    return { tier: t, count: items.length, chars: items.reduce((s, x) => s + x.size, 0) };
  });

  return {
    summary: {
      turns: n,
      keepTurns,
      rankableTurns: turnStats.filter((t) => t.age >= keepTurns).length,
      totalChars: grand,
      approxTokens: Math.round(grand / 4),
    },
    typeBreakdown: Object.fromEntries(
      (Object.keys(typeTotals) as BlockKind[]).map((k) => [
        k,
        { chars: typeTotals[k], pct: Math.round((typeTotals[k] / grand) * 1000) / 10 },
      ]),
    ),
    projectedReclaim: {
      attachments_chars: rankableAttachments.reduce((a, x) => a + x.size, 0),
      thinking_signature_chars: rankableThinking.reduce((a, x) => a + x.signatureSize, 0),
      note:
        "attachment reclaim is lossless: tool outputs re-runnable, inputs on disk + Content-ID, skills re-invokable. thinking reclaim shown is SIGNATURE bytes only; true live-context reclaim is larger (decrypted reasoning). keepTurns region excluded.",
    },
    // Prune-priority tiers (soft hints — you decide). Confirm prime-prune; spend
    // judgment on review; likely-keep is cheap to leave inline. supersededBy on
    // an attachment names the later op that made it stale.
    tierSummary,
    perTurn: turnStats.map((t) => ({
      turn: t.turn,
      age: t.age,
      prompt: t.userPrompt,
      prose: t.prose,
      thinkingBlocks: t.thinkingBlocks,
      toolCalls: t.toolCalls,
      toolInput: t.toolInput,
      toolOutput: t.toolOutput,
    })),
    rankableAttachments,
    rankableThinking: rankableThinking.map((t) => ({
      turn: t.turn,
      uuid: t.uuid,
      blockIndex: t.blockIndex,
      signatureSize: t.signatureSize,
    })),
  };
}

if (import.meta.main) {
  const [transcriptPath, keepTurnsArg] = Bun.argv.slice(2);
  if (!transcriptPath) {
    console.error("usage: bun analyze.ts <transcript_path> [keepTurns]");
    process.exit(2);
  }
  const keepTurns = keepTurnsArg ? Math.max(0, Number(keepTurnsArg)) : 1;
  readActiveTranscriptRows(transcriptPath)
    .then((rows) => console.log(JSON.stringify(runAnalyze(rows, keepTurns))))
    .catch((err) => {
      console.error(`analyze failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
