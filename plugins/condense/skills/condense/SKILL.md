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
(default keepTurns = 1). Read the JSON: `summary`, `typeBreakdown`, `projectedReclaim`, `tierSummary`, `perTurn`, `rankableAttachments`, and `rankableThinking`.

`rankableAttachments` is **pre-sorted prune-first** and each carries decision-support signals:
- `ref`, `kind`, `turn`, `size`, `head` (anchor snippet — identify it by content).
- `age` — turns from the end.
- `superseded` / `supersededBy` — `true` when a LATER op acted on the same file/command (e.g. `"Edit@turn41"`), so this is a stale snapshot; the current version is elsewhere.
- `tier` — `prime-prune` (superseded stale copy, or a re-invokable skill dump), `review` (live + sizable — your judgment call), or `likely-keep` (small; cheap to leave inline).

## Step 2 — Rank, biased HARD toward pruning

**Reclaim is the goal. Default to dropping.** The tiers make this cheap — but they *advise*, they don't decide. Your job is to catch what they get wrong:
- **prime-prune** → prune, essentially always (stale/superseded or re-invokable). Only rescue one if you can name a concrete reason you need its exact bytes inline.
- **review** → the real judgment. Keep only what you can name a reason for (a file you are mid-edit on, a spec you keep re-reading). Otherwise prune — this tier is the biggest reclaim.
- **likely-keep** → leave inline; not worth the retrieval round-trip. But prune a small item too if it's clearly dead.

Everything is recoverable (`read_omitted_content`, re-run the tool, re-invoke the skill), so err aggressively toward shedding. Do **not** keep something merely because it is large or recent — check `superseded` and whether you can name a use.

- **Attachments** (`keep-ranked`): from `rankableAttachments`, pick the *minimal* set of `ref`s to KEEP. Use the `head` snippet to recognize each. Copy kept refs verbatim into `keepAttachments`. Everything not listed is pruned (tool I/O → Content-ID; skill → re-invoke note).
- **Thinking** (`keep-ranked`): from `rankableThinking` (keyed by `turn`/`uuid`/`blockIndex`), keep reasoning only from turns whose thinking is still load-bearing to continue — cross-reference `perTurn` prompts and your own memory of what you reasoned about. Drop the rest. Put kept blocks as `{uuid, blockIndex}` in `keepThinking`.

## Step 3 — Build (call 2)

Pass the ranking inline:
```bash
bun ~/.claude/condense/plugins/condense/src/condense.ts build '{"keepTurns":1,"title":"…optional…","modes":{"thinking":"keep-ranked","attachments":"keep-ranked"},"keepThinking":[{"uuid":"…","blockIndex":0}],"keepAttachments":["o:toolu_…","i:toolu_…","s:…"]}'
```
Modes: `keep-all` (keep everything of that class), `keep-ranked` (keep only the listed refs/blocks), `drop` (shed all — leave the keep-list empty). Prints `{ sessionId, transcriptPath, generation, stats }`.

**Optional `title`** — the compacted session is titled `🗜 condense #N — <desc>` (N auto-increments across repeated condensing). By default `<desc>` is derived from the session's first prompt; set `"title"` in the ranking to give a better one-line description of what the session is about (the `#N` prefix is always kept). Do this when the first prompt is a poor descriptor of the actual work.

The build step automatically (a) **strips the `/condense` operation's own turn** (this skill dump + the analyze call) so the compacted session ends at real work, not machinery, and (b) **appends one deterministic closing marker** stating exactly what it pruned/kept and how to recover it. You don't rank or specify either — they come from the build's own tallies. On the resumed side, that marker is the last thing you'll see: trust it over memory for what's inline vs pruned.

## Step 4 — Report

Concisely: reclaim achieved (source vs projected), what was pruned vs kept (from `stats`), and **`/resume <sessionId>`** to enter the compacted session. Note: the original session is untouched; pruned attachments are recoverable via `read_omitted_content` (Content-ID) or by re-invoking the named skill.

## Invariants (never violate)

- Prose (string-content user messages + your text) is always verbatim.
- Kept thinking blocks are byte-copied by the build step — you only choose *which* survive, never edit them (signatures must stay exact or resume 400s).
- The `keepTurns` region is untouched regardless of modes.
- Bias to prune: the failure mode to avoid is keeping too much. Reclaim is the point.
