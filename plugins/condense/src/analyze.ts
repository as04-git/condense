// analyze.ts — mechanical stats pass for condense.
//
// Reads a Claude Code transcript, splits it into assistant turns (reusing the
// same active-chain logic the build step uses), and prints a per-turn /
// per-type / per-rankable-block breakdown. The in-session model reads this
// output to make grounded keep/drop ranking decisions before the build step.
//
// Usage: bun analyze.ts <transcript_path> [keepTurns]
//
// Note on "thinking size": the `thinking` text is empty on disk (display:
// "omitted"); what is stored is an opaque `signature` blob that the server
// decrypts to the real (larger) reasoning. So the byte sizes reported for
// thinking are SIGNATURE bytes — a lower-bound proxy for the true live-context
// weight, not the reasoning length. #blocks and turn position are the more
// meaningful signals for ranking; the model supplies relevance from its own
// in-context (decrypted) reasoning.

import {
  buildAssistantTurns,
  isRecord,
  readActiveTranscriptRows,
  type TranscriptRow,
  type Turn,
} from "./transcript";

type BlockKind =
  | "prose"
  | "thinking"
  | "tool_input"
  | "tool_output"
  | "human_prompt"
  | "other";

type ToolOutputStat = {
  toolUseId: string | null;
  turn: number;
  toolName: string;
  size: number;
  errored: boolean;
};

type ThinkingStat = {
  turn: number;
  blockIndex: number;
  signatureSize: number;
};

type TurnStat = {
  turn: number;
  age: number; // turns from the end (0 = most recent)
  userPrompt: string;
  prose: number;
  thinkingSig: number;
  thinkingBlocks: number;
  toolInput: number;
  toolOutput: number;
  toolCalls: number;
  total: number;
};

function blockText(block: unknown): number {
  if (typeof block === "string") return block.length;
  if (!isRecord(block)) return JSON.stringify(block).length;
  const t = block["type"];
  if (t === "text") return String(block["text"] ?? "").length;
  if (t === "thinking") {
    return (
      String(block["thinking"] ?? "").length
      + String(block["signature"] ?? "").length
    );
  }
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

function signatureSize(block: unknown): number {
  return isRecord(block) ? String(block["signature"] ?? "").length : 0;
}

function isToolResultRow(row: TranscriptRow): boolean {
  if (row.type !== "user" || !isRecord(row.message)) return false;
  const c = row.message["content"];
  return (
    Array.isArray(c)
    && c.some((b) => isRecord(b) && b["type"] === "tool_result")
  );
}

function firstLine(text: string, max = 90): string {
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

function main(): void {
  const [transcriptPath, keepTurnsArg] = Bun.argv.slice(2);
  if (!transcriptPath) {
    console.error("usage: bun analyze.ts <transcript_path> [keepTurns]");
    process.exit(2);
  }
  const keepTurns = keepTurnsArg ? Math.max(0, Number(keepTurnsArg)) : 1;

  readActiveTranscriptRows(transcriptPath)
    .then((rows) => report(rows, keepTurns))
    .catch((err) => {
      console.error(`analyze failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}

function report(rows: TranscriptRow[], keepTurns: number): void {
  const turns = buildAssistantTurns(rows);
  const n = turns.length;

  const turnStats: TurnStat[] = [];
  const toolOutputs: ToolOutputStat[] = [];
  const thinkingBlocks: ThinkingStat[] = [];
  const typeTotals: Record<BlockKind, number> = {
    prose: 0,
    thinking: 0,
    tool_input: 0,
    tool_output: 0,
    human_prompt: 0,
    other: 0,
  };

  // Map tool_use_id -> tool name (names come from assistant tool_use blocks).
  const toolNames = new Map<string, string>();
  for (const turn of turns) {
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
        }
      }
    }
  }

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
      total: 0,
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
            typeTotals.thinking += blockText(b);
            thinkingBlocks.push({ turn: ti, blockIndex: bi, signatureSize: sig });
          } else if (isRecord(b) && b["type"] === "tool_use") {
            st.toolInput += blockText(b);
            st.toolCalls += 1;
            typeTotals.tool_input += blockText(b);
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
              const toolUseId =
                typeof b["tool_use_id"] === "string" ? b["tool_use_id"] : null;
              toolOutputs.push({
                toolUseId,
                turn: ti,
                toolName: (toolUseId && toolNames.get(toolUseId)) || "?",
                size,
                errored: b["is_error"] === true,
              });
            } else {
              st.toolOutput += blockText(b);
              typeTotals.tool_output += blockText(b);
            }
          }
        } else {
          const s = blocks.reduce((acc, b) => acc + blockText(b), 0);
          st.prose += 0; // human prompt, tracked separately
          typeTotals.human_prompt += s;
        }
      }
    });

    st.total = st.prose + st.thinkingSig + st.toolInput + st.toolOutput;
    turnStats.push(st);
  });

  const grand = Object.values(typeTotals).reduce((a, b) => a + b, 0) || 1;
  const rankableTurns = turnStats.filter((t) => t.age >= keepTurns);

  // Projected reclaim (chars) if a whole class is removed from the rankable region.
  const rankableToolOut = toolOutputs
    .filter((t) => t.turn < n - keepTurns)
    .reduce((a, t) => a + t.size, 0);
  const rankableThinkingSig = thinkingBlocks
    .filter((t) => t.turn < n - keepTurns)
    .reduce((a, t) => a + t.signatureSize, 0);

  const out = {
    summary: {
      turns: n,
      keepTurns,
      rankableTurns: rankableTurns.length,
      totalChars: grand,
      approxTokens: Math.round(grand / 4),
    },
    typeBreakdown: Object.fromEntries(
      (Object.keys(typeTotals) as BlockKind[]).map((k) => [
        k,
        { chars: typeTotals[k], pct: +((100 * typeTotals[k]) / grand).toFixed(1) },
      ]),
    ),
    projectedReclaim: {
      toolOutputs_drop_or_ranked_chars: rankableToolOut,
      thinking_signatures_drop_chars: rankableThinkingSig,
      note:
        "tool-output reclaim is lossless (retrievable Content-IDs). thinking reclaim shown is SIGNATURE bytes only; true live-context reclaim is larger (decrypted reasoning). keepTurns region excluded.",
    },
    perTurn: turnStats.map((t) => ({
      turn: t.turn,
      age: t.age,
      inKeepTurns: t.age < keepTurns,
      prompt: t.userPrompt,
      prose: t.prose,
      thinking: `${t.thinkingBlocks}blk/${t.thinkingSig}sig`,
      toolIn: t.toolInput,
      toolOut: t.toolOutput,
      calls: t.toolCalls,
      total: t.total,
    })),
    rankableToolOutputs: toolOutputs
      .filter((t) => t.turn < n - keepTurns)
      .sort((a, b) => b.size - a.size)
      .map((t) => ({
        toolUseId: t.toolUseId,
        turn: t.turn,
        tool: t.toolName,
        size: t.size,
        errored: t.errored,
      })),
    rankableThinking: thinkingBlocks
      .filter((t) => t.turn < n - keepTurns)
      .map((t) => ({
        turn: t.turn,
        blockIndex: t.blockIndex,
        signatureSize: t.signatureSize,
      })),
  };

  console.log(JSON.stringify(out, null, 2));
}

main();
