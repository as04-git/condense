---
name: condense
description: Losslessly and recoverably condense the current Claude Code session into a new session. Preserves all prose verbatim, externalizes selected structured payloads to searchable Content-IDs, and only drops ephemeral signed thinking when explicitly selected by policy.
argument-hint: "[keepTurns] [--thinking=MODE] [--tools=MODE] [--agent-results=MODE] [--skills=MODE] [--injections=MODE]"
disable-model-invocation: true
---

# /condense

Condense the current session in-place intellectually but into a new session mechanically. You already hold the conversation, so you review candidates yourself; do not spawn another LLM.

The workflow is `analyze → inspect zero or more times → prepare → build`. Prepare is mandatory: it lets you review the exact dry run after making retention decisions and before committing them.

CLI:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/src/bootstrap.ts" condense "${CLAUDE_PLUGIN_DATA}" analyze [arguments]
```

It locates the current transcript through `CLAUDE_CODE_SESSION_ID`, loads global/project config, identifies this operation turn, and returns an opaque `cr_` receipt plus bounded candidates.

## Retention policies

Each class resolves to one of:

- `keep-all`: always inline; no ranking decision.
- `keep-ranked`: put only load-bearing candidate refs in `keep`; the complement is externalized/dropped.
- `drop-ranked`: put only clearly obsolete candidate refs in `drop`; the complement stays inline.
- `drop-all`: externalize/drop everything eligible; no ranking decision.

Built-in defaults are thinking=`drop-ranked`, tools=`keep-ranked`, agentResults=`drop-ranked`, skills=`drop-all`, injections=`keep-ranked`. Config and invocation arguments may change them. The analyze result is authoritative.

## Analyze

Forward the user’s arguments verbatim after `analyze`. Read:

- `receipt`: retain for inspect and prepare.
- `scope`: semantic turn count and untouched recent-turn boundary.
- `columns`: schema for every candidate row.
- `turns`: prompt anchors only for turns referenced on this page.
- `reviewToKeep`: recoverable payloads that default to externalization; list a ref in `keep` only when full inline content is still needed.
- `reviewToDrop`: payloads or thinking that default to inline retention; list a ref in `drop` only when clearly obsolete.
- `automatic`: compact counts for classes wholly controlled by policy.
- `more`: stable cursor and remaining row counts when another page exists.

The row-local `netChars` is the exact character cost of that decision, not a global optimization target. Prioritize correctness evidence over size. Preserve agent-result summaries unless clearly obsolete. A later Bash invocation never supersedes an earlier observation. Supersession is only strong evidence for reconstructible payloads.

For candidates whose `action` is:

- `keep`: add the ref only when its full inline value is concretely needed to continue.
- `drop`: add the ref only when it is clearly obsolete. Thinking is unrecoverable, so uncertainty means do not list it.
- `none`: do not list it; policy already decides.

Analyze deliberately omits a headline projection, percentage, token estimate, gross-eligible figure, and minimum-post-condense estimate. Do not invent them.

## Inspect, when useful

Use the returned cursor to page without losing stable ordering:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/src/bootstrap.ts" condense "${CLAUDE_PLUGIN_DATA}" inspect '{"receipt":"cr_…","cursor":"p_12"}'
```

Request deeper bounded evidence for up to 20 known refs when the initial row is insufficient:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/src/bootstrap.ts" condense "${CLAUDE_PLUGIN_DATA}" inspect '{"receipt":"cr_…","refs":["o:…","t:…"]}'
```

Cursor and refs are mutually exclusive. Inspect validates the frozen source. Hidden or uninspected candidates retain their safe policy defaults.

## Prepare

Submit only refs whose defaults you are intentionally overriding, plus an optional title:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/src/bootstrap.ts" condense "${CLAUDE_PLUGIN_DATA}" prepare '{"receipt":"cr_…","keep":["o:…","i:…"],"drop":["t:…"],"title":"optional description"}'
```

Prepare is non-mutating apart from its private, expiring plan record. Review its decision audit in this order:

1. `thinking`, especially unrecoverable dropped blocks and prompt-anchored turns;
2. `externalized` and `inline` counts by content class;
3. `impactChars.source`, `projected`, and `removed`;
4. `warnings`.

Do not label the plan good or bad. If the audit exposes a mistaken decision, call prepare again with revised lists; each result has an independent `bp_` handle. Never infer tokens from the character counts.

## Build

After the audit matches the intended decisions, pass only the prepared plan handle:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/src/bootstrap.ts" condense "${CLAUDE_PLUGIN_DATA}" build '{"plan":"bp_…"}'
```

Build rejects stale plans, changed SDK source prefixes, changed active context, unexpected user activity, and SDK incompatibility. It applies exactly the frozen mutations and Content-IDs, then verifies the actual active-context character count equals prepare. Do not retry with guessed or weakened JSON; rerun analyze and prepare if validation fails.

The result contains the new session ID, actual source/final context characters, reclaim percentage, lineage object count, and exact tallies. Its final visible marker gives prompt-anchored thinking ranges, inline/new/pre-omitted counts, and recovery instructions.

## Report

Report the actual character change and important kept/dropped tallies, then give:

```text
/resume <sessionId>
```

The parent session remains unchanged. Omitted values are recoverable with bounded `read_omitted_content`; `search_omitted_content` searches the current multi-generation lineage by default and supports literal or explicit safe RE2 regex mode.

If the user asks about retained recovery storage, run this read-only report rather than estimating:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/src/bootstrap.ts" condense "${CLAUDE_PLUGIN_DATA}" storage
```

Pass an explicit session ID as the final argument only when the user requests another lineage. Report exact bytes compactly. A lineage's `objectBytes` is attributable usage, not guaranteed reclaimable space, because other manifests may share those objects. Never delete recovery data without an explicit user request.

## Invariants

- All genuine user prose and assistant text remain verbatim.
- Kept thinking blocks remain byte-identical; never edit signed thinking.
- Recent keepTurns content remains fully inline.
- Only known structured payloads and whole thinking blocks are eligible.
- Inactive branches and opaque SDK metadata remain stored but never influence retention or accounting.
- Trust the final marker over memory for what is inline, externalized, or unrecoverable.
