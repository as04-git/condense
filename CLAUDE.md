# CLAUDE.md — `condense`

Guidance for Claude Code sessions working on this repository.

## What this is

`condense` is a Claude Code plugin that losslessly compacts the **current
session** into a **new session you `/resume` into**. Unlike the built-in
`/compact` (lossy LLM summary, in place) and unlike its ancestor
`claude-magic-compact` (spawns a second `claude -p` agent to summarize), condense
does the compaction **in-session with no second LLM**: the model already holding
the conversation ranks what to keep, keeps all prose verbatim, and prunes
recoverable "attachments" to retrievable Content-IDs.

It is a **fork of `claude-magic-compact`** (kevinMEH / aerovato). The reusable
transcript-surgery + omission-store + MCP-retrieval machinery came from there;
the LLM-spawn summarizer was ripped out and replaced with in-session ranking.

## The data flow (two tool calls, no more)

1. `bun src/condense.ts analyze [keepTurns]` — mechanical stats pass. Auto-locates
   the current transcript via `$CLAUDE_CODE_SESSION_ID`. Emits per-turn / per-type
   breakdown + ranked candidate lists (attachments with ~140-char anchor snippets,
   thinking blocks). **The model reads this and ranks in-context** — that is the
   only "intelligence" step, and it is not a tool call.
2. `bun src/condense.ts build '<ranking-json>'` — mechanical build. Takes the
   model's keep-decision, writes a new compacted session, prints the new
   `sessionId` + `/resume` hint.

The skill (`skills/condense/SKILL.md`) orchestrates: analyze → rank → build.

## The build architecture: SDK fork + our post-pass

`runBuild` is **fork-then-post-pass**. The clone half is delegated to the
official **`@anthropic-ai/claude-agent-sdk`** (`forkSession`) — the maintained
layer over Claude Code's version-fragile on-disk format. We do NOT hand-roll
identity/chain surgery anymore; letting the SDK own it means format churn is
Anthropic's problem. `forkSession`:
- mints a fresh sessionId, remaps every ROW uuid (tool_use ids untouched),
  re-chains parentUuid, drops `last-prompt` / `ai-title` / file-history,
- stamps `forkedFrom.{sessionId,messageUuid}` on every row (our old→new map),
- preserves thinking signatures byte-identically,
- `upToMessageId` slices inclusively (our op-turn strip).

Our **post-pass** (`build.ts`) then owns everything content-level, which the SDK
deliberately doesn't touch: prune attachments/thinking to Content-IDs, write the
title pair, append the marker. Refs from the ranking are keyed by ORIGINAL uuids;
each forked row carries its original uuid in `forkedFrom.messageUuid`, so we map
`s:`/thinking refs through it (`o:`/`i:` use the unchanged `tool_use_id`).

## Invariants — DO NOT BREAK THESE (each was a real bug)

- **Thinking blocks are byte-identical or dropped — never edited.** They carry an
  encrypted `signature`; a kept block must round-trip its exact bytes or `/resume`
  400s. You may keep a whole block or drop it; you may never modify one. (The SDK
  fork preserves signatures; our post-pass only ever removes whole blocks.)
- **Prose is always verbatim.** Assistant text blocks and genuine user messages
  (string-content rows) are never pruned, summarized, or touched. Only tool I/O,
  thinking, and injected/skill dumps are rankable.
- **`isMeta === true` is the injected-content discriminator.** Genuine user
  messages are never `isMeta`; skill dumps / command output / system injections are.
  A user row with *string* content is always real prose (protects the visible
  marker); *list* content over the floor is injected → rankable.
- **Title = both `custom-title` AND `agent-name` rows.** The picker/tab read
  `custom-title`; the in-app banner pill reads `agent-name`. `forkSession` writes
  NEITHER reliably (ignores its `title` param when `upToMessageId` is set), so we
  own the title: strip any inherited/derived title rows and emit a fresh pair via
  `makeTitleRows`, keyed to the new id. `last-prompt` desync is handled *by the
  SDK* (it drops the row) — we don't re-add it.
- **Multi-leaf is tolerated — do NOT re-add linearization.** The SDK fork (and
  CC's own `/branch`) leave interrupt-artifact leaves in place; we mirror that.
  The marker carries the newest timestamp, so it's the resolved leaf regardless.
  (We tried enforcing a single leaf; it diverged from official behavior for no
  benefit.)
- **The closing marker is the last row, visible, singleton, deterministic.** It is
  built purely from build-step tallies (never an LLM summary) and reports three
  buckets: freshly-pruned / already-pre-pruned / genuinely-kept. Prior markers are
  stripped each generation (`condenseMarker: true` sentinel) so they don't compound.
- **Only appended rows get sessionId-stamped by us.** CC resolves metadata by
  `map.get(leafMessage.sessionId)`; the SDK already stamps every forked row, so the
  post-pass only sets sessionId on the title/marker rows it appends.
- **Generation counter** is read as the `max` across the source's RAW title rows
  (they're minimal meta rows with no uuid — read them raw, `readTranscriptRows`
  filters them out), backed by a durable `condenseGeneration` field (title-text
  regex is the fallback).

## Files

| File | Role |
|---|---|
| `src/condense.ts` | 2-call CLI dispatcher (`analyze` / `build`); auto-locates transcript |
| `src/analyze.ts` | Mechanical stats + ranked candidate lists with anchors |
| `src/build.ts` | The build layer: fork orchestration + prune/title/marker post-pass |
| `src/fork.ts` | Thin wrapper over the SDK's `forkSession` (the clone half) |
| `src/transcript.ts` | Active-chain reconstruction, turn building, row readers/writer |
| `src/prune.ts` | Attachment candidacy + pruning to Content-IDs; injected/skill detection |
| `src/omission.ts` | The Content-ID store (`~/.claude/condense-store/`) read/write |
| `src/mcp.ts` | `read_omitted_content` MCP server (the retrieval half) |
| `skills/condense/SKILL.md` | The orchestration the model follows on `/condense` |

## Working on this codebase

- **Runtime is `bun`** (no build/compile step — `.ts` runs directly). MCP + hook
  entrypoints are `bun src/*.ts`.
- **Testing = fork a throwaway session, then verify.** Copy a real session to a
  throwaway UUID under `~/.claude/projects/<proj>/`, run `runAnalyze`/`runBuild`
  against it, then delete both it and the fork. Load-bearing checks: (1) a real
  `claude -p --resume` round-trip returns without a signature 400; (2) kept
  thinking signatures byte-identical to source; (3) assistant-prose char count
  matches source (minus the stripped op-turn); (4) zero dangling `parentUuid`,
  marker is the newest-timestamp leaf; (5) generation increments + desc carries
  forward across a re-condense.
- **Headless verification is strong on data fidelity, weak on UI.** Several bugs
  here (stale banner, picker desync, multi-leaf) passed every content-level test and
  only showed in the interactive UI. When something touches session identity/title,
  the real confirmation is an interactive resume, not a headless check.
- **CC session semantics are confirmed against the v2.1.88 source** (the
  `collection-claude-code-source-code` de-minified TypeScript). When in doubt about
  how CC resolves a title/leaf/metadata row, check the source rather than infer.
- **Never use the injected billing/active-session email for commits.** Author is
  Aryan Shrivastava <48136120+as04-git@users.noreply.github.com>.
