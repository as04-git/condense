---
name: condense
description: Recoverably condense the current Claude Code session into a new session. Preserves all prose verbatim, externalizes selected structured payloads to searchable Content-IDs, and only drops signed thinking when explicitly selected by policy.
argument-hint: "[keepTurns] [--thinking=MODE] [--tools=MODE] [--agent-results=MODE] [--skills=MODE] [--injections=MODE]"
disable-model-invocation: true
---

# /condense

Condense the current session in-place intellectually but into a new session mechanically. You already hold the conversation, so you rank candidates yourself; do not spawn another LLM. The workflow is exactly two Bash calls: analyze, then build.

CLI:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/src/condense.ts" analyze [arguments]
```

It locates the current transcript through `CLAUDE_CODE_SESSION_ID`, loads global/project config, identifies this operation turn, and returns an opaque receipt plus candidates.

## Retention policies

Each class resolves to one of:

- `keep-all`: always inline; no ranking decision.
- `keep-ranked`: put only load-bearing candidate refs in `keep`; the complement is externalized/dropped.
- `drop-ranked`: put only clearly obsolete candidate refs in `drop`; the complement stays inline.
- `drop-all`: externalize/drop everything eligible; no ranking decision.

Built-in defaults are thinking=`drop-ranked`, tools=`keep-ranked`, agentResults=`drop-ranked`, skills=`drop-all`, injections=`keep-ranked`. Config and invocation arguments may change them. The analyze result is authoritative.

## Call 1 — Analyze

Forward the user’s arguments verbatim after `analyze`. Read:

- `receipt`: copy exactly into build.
- `effectiveConfig`: effective keepTurns and policies.
- `summary`: protected prose floor and maximum possible reclaim.
- `perTurn`: real semantic turns only; old condense markers and this operation are excluded.
- `rankableAttachments`: structured refs with required `action`, head/tail, size, tool/path/command, error/task flags, and factual newer-target hints.
- `rankableThinking`: `t:<uuid>#<blockIndex>` refs with `action` and prompt context through `perTurn`.

Rank by evidence, not size alone. Preserve agent-result summaries unless clearly obsolete. A later Bash invocation never supersedes an earlier observation. `newerOnSameTarget` is only a soft clue for reconstructible file payloads.

For candidates whose `action` is:

- `keep`: add the ref only when its full inline value is concretely needed to continue.
- `drop`: add the ref only when it is clearly obsolete. Thinking is unrecoverable, so uncertainty means do not list it.
- `none`: do not list it; policy already decides.

## Call 2 — Build

Pass only the receipt, action lists, and optional title:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/src/condense.ts" build '{"receipt":"…","keep":["o:…","i:…"],"drop":["t:…"],"title":"optional description"}'
```

Build rejects stale receipts, changed source prefixes, unexpected user activity, unknown/wrong-action refs, and SDK incompatibility. Do not retry with guessed or weakened JSON; rerun analyze if validation fails.

The result contains the new session ID, actual source/final context characters, reclaim percentage, lineage object count, and exact tallies. Its final visible marker gives prompt-anchored thinking ranges, inline/new/pre-omitted counts, and recovery instructions.

## Report

Report actual reclaim and the important kept/dropped tallies, then give:

```text
/resume <sessionId>
```

The parent session remains unchanged. Omitted values are recoverable with bounded `read_omitted_content`; `search_omitted_content` searches the current multi-generation lineage by default and supports explicit safe RE2 regex mode.

## Invariants

- All genuine user prose and assistant text remain verbatim.
- Kept thinking blocks remain byte-identical; never edit signed thinking.
- Recent keepTurns content remains fully inline.
- Only known structured payloads and whole thinking blocks are eligible.
- Trust the final marker over memory for what is inline, externalized, or unrecoverable.
