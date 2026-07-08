---
name: condense
description: Losslessly condense the current Claude Code session — keep prose and reasoning-relevant context, rank tool I/O (and thinking) to keep what's load-bearing, prune the rest to retrievable Content-IDs, and produce a new session to resume into.
argument-hint: "[keepTurns] [--thinking=keep-all|keep-ranked|drop] [--thinking-max=N] [--tools=keep-all|keep-ranked|drop] [--tools-max=N]"
disable-model-invocation: true
---

# /condense

You are performing an **in-session, lossless-ish context condensation**. Unlike `/compact`, nothing calls a second LLM: **you**, right now, hold the full conversation (including your own decrypted prior reasoning), so **you** do the ranking. Follow these steps exactly.

Plugin scripts live at `~/.claude/condense/plugins/condense/src/` (run with `bun`). The omission/retrieval store is `~/.claude/condense-store/`.

## Step 1 — Locate the transcript and parse arguments

```bash
TRANSCRIPT=$(find ~/.claude/projects -name "$CLAUDE_CODE_SESSION_ID.jsonl" 2>/dev/null | head -1)
echo "$TRANSCRIPT"
```
If empty, stop and tell the user the current session transcript couldn't be found (report `$CLAUDE_CODE_SESSION_ID`).

Parse the invocation args (all optional):
- **keepTurns** (bare integer, default **1**) — most-recent turns left 100% untouched.
- **--thinking=** `keep-all` | `keep-ranked` | `drop` (default **keep-ranked**), **--thinking-max=N** (optional cap).
- **--tools=** `keep-all` | `keep-ranked` | `drop` (default **keep-ranked**), **--tools-max=N** (default **15**) — governs BOTH tool outputs and big tool inputs.

## Step 2 — Analyze

```bash
bun ~/.claude/condense/plugins/condense/src/analyze.ts "$TRANSCRIPT" <keepTurns> > /tmp/condense-stats.json
```
Read `/tmp/condense-stats.json`. Note `summary`, `typeBreakdown`, `projectedReclaim`, the `perTurn` table, and the candidate lists `rankableToolOutputs`, `rankableToolInputs`, `rankableThinking`.

## Step 3 — Rank (this is the whole point — use judgment, not size)

Build a ranking object. The **mechanical stats give you size/tool/turn/recency; you supply relevance** from what you actually know about this conversation.

- **tools = keep-ranked:** From the combined `rankableToolOutputs` + `rankableToolInputs` (both size-sorted, each has `toolUseId`, `turn`, `tool`, `side`, `size`), pick the **most load-bearing** items to KEEP inline — up to `--tools-max` total. Keep an item if its content is still needed to continue the work and can't be trivially re-derived (e.g. a file you're actively editing, a spec you keep referencing). Prune (omit) the rest — they become retrievable Content-IDs. Put kept output ids in `keepToolOutputs`, kept input ids in `keepToolInputs`. (Errored/empty outputs and small inputs are auto-kept — don't list them.)
- **thinking = keep-ranked:** `rankableThinking` lists blocks by `turn`/`uuid`/`blockIndex` (content is opaque on disk, but **you remember what you reasoned about in each turn**). Keep thinking from turns whose reasoning is still load-bearing for continuing — cross-reference the `perTurn` prompts. Drop the rest, up to `--thinking-max`. Put kept blocks as `{uuid, blockIndex}` in `keepThinking`.
- **keep-all / drop modes:** leave the corresponding keep-list empty (build ignores it).

Write the ranking to a file:
```jsonc
// /tmp/condense-ranking.json
{
  "keepTurns": <int>,
  "modes": { "thinking": "<mode>", "tools": "<mode>" },
  "keepThinking":    [ { "uuid": "<src row uuid>", "blockIndex": <int> } ],
  "keepToolOutputs": [ "toolu_..." ],
  "keepToolInputs":  [ "toolu_..." ]
}
```

## Step 4 — Build

```bash
bun ~/.claude/condense/plugins/condense/src/build.ts "$TRANSCRIPT" /tmp/condense-ranking.json
```
This prints `{ "sessionId", "transcriptPath", "stats" }`. If it errors, report the error and stop — the original session is untouched.

## Step 5 — Report

Tell the user, concisely:
- what was kept vs pruned (from `stats`: thinking kept/dropped, tool inputs/outputs kept/pruned, empty rows dropped),
- rough reclaim (from `projectedReclaim` minus what you kept),
- and the command to enter the compacted session: **`/resume <sessionId>`**.

Note that pruned I/O is retrievable mid-work via the `read_omitted_content` tool (pass the Content ID shown in any omission notice), and the original session is preserved unchanged.

## Notes & invariants (do not violate)

- **Prose (your visible text + the user's prompts) is always kept verbatim.** Never rank or drop it.
- **Kept thinking blocks are byte-copied** by the build step — you only choose *which* blocks survive, never edit them (signatures must stay exact or resume fails).
- The `keepTurns` region is untouched regardless of modes.
- Ranking is about *relevance to continuing the work*, not size. A tiny output can be load-bearing; a huge stale log usually isn't.
