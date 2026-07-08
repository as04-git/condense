---
name: condense
description: Losslessly condense the current Claude Code session into a new session you resume into. Keeps your prose and the model's reasoning-relevant context verbatim; aggressively prunes recoverable "attachments" (tool outputs, big tool inputs, skill/injected dumps) that aren't load-bearing, leaving retrievable Content-IDs or re-invoke notes.
argument-hint: "[keepTurns] [--attachments=keep-all|keep-ranked|drop] [--thinking=keep-all|keep-ranked|drop]"
disable-model-invocation: true
---

# /condense

An in-session, lossless-ish compaction. **Nothing calls a second LLM — you do the ranking**, because you already hold this whole conversation (including your own decrypted prior reasoning). The entire flow is **two tool calls**: `analyze`, then `build`. Do not add extra steps.

CLI: `bun ~/.claude/condense/plugins/condense/src/condense.ts <subcommand>`. It auto-locates the current transcript via `$CLAUDE_CODE_SESSION_ID` — you never find or pass a path.

## Concepts

- **Attachments** = the large, non-prose, non-reasoning, **recoverable** content you can shed:
  - `tool-output` (re-runnable), `tool-input` (big Write/Edit/Bash payloads — on disk + Content-ID), `skill`/`injected` (skill dumps — **re-invokable**).
  - Every attachment is recoverable, which is *why* shedding it is safe and should be done freely.
- **Prose** (your visible text + the user's typed/pasted messages) — always kept verbatim, never touched.
- **Thinking** — your prior reasoning; opaque on disk but you remember it. Rankable by turn relevance.

## Step 1 — Analyze (call 1)

```bash
bun ~/.claude/condense/plugins/condense/src/condense.ts analyze <keepTurns>
```
(default keepTurns = 1). Read the JSON: `summary`, `typeBreakdown`, `projectedReclaim`, `perTurn`, `rankableAttachments` (each has a `ref`, `kind`, `turn`, `size`, and an **anchor `head` snippet** so you identify it by content), and `rankableThinking`.

## Step 2 — Rank, biased HARD toward pruning

**Reclaim is the goal. Default to dropping.** Keep an attachment **only if you can name a concrete reason you will need its exact content to continue the work** — e.g. a file you are actively mid-edit on, a spec you keep re-reading. If you cannot name that reason, prune it. Everything is recoverable (`read_omitted_content`, re-run the tool, re-invoke the skill), so err aggressively toward shedding. A huge stale skill dump or an old file read is exactly what should go. Do **not** keep something merely because it is large or recent.

- **Attachments** (`keep-ranked`): from `rankableAttachments`, pick the *minimal* set of `ref`s to KEEP. Use the `head` snippet to recognize each. Copy kept refs verbatim into `keepAttachments`. Everything not listed is pruned (tool I/O → Content-ID; skill → re-invoke note).
- **Thinking** (`keep-ranked`): from `rankableThinking` (keyed by `turn`/`uuid`/`blockIndex`), keep reasoning only from turns whose thinking is still load-bearing to continue — cross-reference `perTurn` prompts and your own memory of what you reasoned about. Drop the rest. Put kept blocks as `{uuid, blockIndex}` in `keepThinking`.

## Step 3 — Build (call 2)

Pass the ranking inline:
```bash
bun ~/.claude/condense/plugins/condense/src/condense.ts build '{"keepTurns":1,"title":"…optional…","modes":{"thinking":"keep-ranked","attachments":"keep-ranked"},"keepThinking":[{"uuid":"…","blockIndex":0}],"keepAttachments":["o:toolu_…","i:toolu_…","s:…"]}'
```
Modes: `keep-all` (keep everything of that class), `keep-ranked` (keep only the listed refs/blocks), `drop` (shed all — leave the keep-list empty). Prints `{ sessionId, transcriptPath, generation, stats }`.

**Optional `title`** — the compacted session is titled `🗜 condense #N — <desc>` (N auto-increments across repeated condensing). By default `<desc>` is derived from the session's first prompt; set `"title"` in the ranking to give a better one-line description of what the session is about (the `#N` prefix is always kept). Do this when the first prompt is a poor descriptor of the actual work.

## Step 4 — Report

Concisely: reclaim achieved (source vs projected), what was pruned vs kept (from `stats`), and **`/resume <sessionId>`** to enter the compacted session. Note: the original session is untouched; pruned attachments are recoverable via `read_omitted_content` (Content-ID) or by re-invoking the named skill.

## Invariants (never violate)

- Prose (string-content user messages + your text) is always verbatim.
- Kept thinking blocks are byte-copied by the build step — you only choose *which* survive, never edit them (signatures must stay exact or resume 400s).
- The `keepTurns` region is untouched regardless of modes.
- Bias to prune: the failure mode to avoid is keeping too much. Reclaim is the point.
