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

## Invariants — DO NOT BREAK THESE (each was a real bug)

- **Thinking blocks are byte-identical or dropped — never edited.** They carry an
  encrypted `signature`; a kept block must round-trip its exact bytes or `/resume`
  400s. You may keep a whole block or drop it; you may never modify one.
- **Every row's `sessionId` must equal the new session's id.** CC resolves session
  metadata by `map.get(leafMessage.sessionId)` (confirmed v2.1.88 source). A stray
  parent sessionId makes the title/identity silently vanish. `runBuild` stamps this
  uniformly as a backstop.
- **Prose is always verbatim.** Assistant text blocks and genuine user messages
  (string-content rows) are never pruned, summarized, or touched. Only tool I/O,
  thinking, and injected/skill dumps are rankable.
- **`isMeta === true` is the injected-content discriminator.** Genuine user
  messages are never `isMeta`; skill dumps / command output / system injections are.
  A user row with *string* content is always real prose (protects the boundary +
  the visible marker); *list* content over the floor is injected → rankable.
- **Do not carry `last-prompt` into the clone.** The `/resume` picker preview reads
  that field as its headline; a stale parent `last-prompt` (e.g. `/branch`) makes
  the picker disagree with the loaded chain. Dropped in `PRESERVED_METADATA_TYPES`.
- **Title = both `custom-title` AND `agent-name` rows.** The picker/tab read
  `custom-title`; the in-app banner pill reads `agent-name`. Writing only
  `custom-title` leaves a stale banner. `withCondensedTitle` emits both, keyed to
  the new id, stripping inherited ones.
- **Output is a single linear `parentUuid` chain.** Source chains can have multiple
  leaves (interrupt artifacts); a clone must linearize to exactly one leaf or the
  UI can render multiple picker entries / anchor to the wrong leaf. Timestamps are
  strictly increasing so the marker is the unambiguous newest leaf.
- **The closing marker is the last row, visible, singleton, deterministic.** It is
  built purely from build-step tallies (never an LLM summary) and reports three
  buckets: freshly-pruned / already-pre-pruned / genuinely-kept. Prior markers are
  stripped each generation (`condenseMarker: true` sentinel) so they don't compound.
- **Generation counter** is read as the `max` across title rows, backed by a durable
  `condenseGeneration` numeric field (regex on the title text is only a fallback).

## Files

| File | Role |
|---|---|
| `src/condense.ts` | 2-call CLI dispatcher (`analyze` / `build`); auto-locates transcript |
| `src/analyze.ts` | Mechanical stats + ranked candidate lists with anchors |
| `src/build.ts` | The build layer: transcript surgery, modes, marker, clone identity |
| `src/transcript.ts` | Active-chain reconstruction, turn building, metadata preservation |
| `src/prune.ts` | Attachment candidacy + pruning to Content-IDs; injected/skill detection |
| `src/omission.ts` | The Content-ID store (`~/.claude/condense-store/`) read/write |
| `src/mcp.ts` | `read_omitted_content` MCP server (the retrieval half) |
| `skills/condense/SKILL.md` | The orchestration the model follows on `/condense` |

## Working on this codebase

- **Runtime is `bun`** (no build/compile step — `.ts` runs directly). MCP + hook
  entrypoints are `bun src/*.ts`.
- **Testing = clone a real session, then verify.** The load-bearing checks: (1) a
  real `/resume` round-trip returns without a signature 400; (2) kept thinking
  signatures are byte-identical to source; (3) assistant-prose char count matches
  source exactly; (4) single leaf, zero dangling `parentUuid`. Prefer exercising
  `runAnalyze`/`runBuild` against a copied transcript over unit-mocking.
- **Headless verification is strong on data fidelity, weak on UI.** Several bugs
  here (stale banner, picker desync, multi-leaf) passed every content-level test and
  only showed in the interactive UI. When something touches session identity/title,
  the real confirmation is an interactive resume, not a headless check.
- **CC session semantics are confirmed against the v2.1.88 source** (the
  `collection-claude-code-source-code` de-minified TypeScript). When in doubt about
  how CC resolves a title/leaf/metadata row, check the source rather than infer.
- **Never use the injected billing/active-session email for commits.** Author is
  Aryan Shrivastava <48136120+as04-git@users.noreply.github.com>.
