# condense

**Recoverable, model-ranked context condensation for Claude Code.**

`condense` moves bulky structured payloads out of the live context while preserving every genuine user message and every piece of assistant prose verbatim. Omitted tool I/O and injected material become typed, integrity-checked Content-IDs that can be searched or read in bounded pages. Signed thinking is either kept byte-identically or dropped whole under a fail-closed policy.

The result is a new Claude Code session that you `/resume` into. The parent session remains unchanged.

## Where it fits

`condense` is a high-fidelity context pager, complementary to semantic `/compact`:

| | `/compact` | `condense` |
|---|---|---|
| Semantic history | LLM summary | prose preserved verbatim |
| Structured payloads | discarded | searchable Content-IDs |
| Thinking | discarded | configurable; kept byte-identically or dropped whole |
| Result | current session | new resumable session |

Once protected prose dominates the context, the exact dry run makes that boundary visible without pretending that a generic tokenizer can measure it reliably.

## Install

Requires Bun on `PATH`.

```bash
claude plugin marketplace add /path/to/condense
claude plugin install condense@condense-local
```

Restart Claude Code after installation or update so the skill and MCP tools reload.

## Use

```text
/condense [keepTurns] [--thinking=MODE] [--tools=MODE]
                        [--agent-results=MODE] [--skills=MODE]
                        [--injections=MODE]
```

Modes are `keep-all`, `keep-ranked`, `drop-ranked`, and `drop-all`. The host-neutral workflow is:

```text
analyze → inspect zero or more times → prepare → build
```

- `analyze` returns a bounded, columnar evidence page and an opaque `cr_` receipt. It deliberately has no headline projection, token estimate, or global optimization target.
- `inspect` paginates hidden candidates or expands at most 20 selected refs with bounded, type-aware evidence.
- `prepare` freezes the decisions, assigns the real omission IDs, and runs the exact dry run. Its neutral audit presents irreversible effects before character impact.
- `build` accepts only the resulting `bp_` plan handle and commits exactly the prepared plan through the official Claude Agent SDK.

Analysis and plan records are private, expire after 24 hours, and are consumed after a successful build. Source and active-context digests are revalidated at every stage.

Defaults:

- thinking: `drop-ranked` (only explicitly selected thinking is removed);
- ordinary tools: `keep-ranked`;
- agent results: `drop-ranked`;
- re-invokable skills: `drop-all`;
- other injections: `keep-ranked`;
- most recent real turn: fully untouched.

The final visible marker reports actual character reclaim, prompt-anchored thinking ranges, per-class inline/new/pre-omitted counts, lineage size, and recovery commands. Condense does not emit heuristic token counts. A future host adapter may add token projection only when source and projected counts come from the same trustworthy model-specific method and scope.

## Configuration

Configuration precedence is built-ins → global → nearest project config → invocation flags.

- Global: `${XDG_CONFIG_HOME:-~/.config}/condense/config.json`
- Project: nearest ancestor `.condense.json`

Configuration is strict: unknown keys, invalid modes, and inconsistent limits abort rather than silently changing retention.

```json
{
  "keepTurns": 1,
  "policies": {
    "thinking": "drop-ranked",
    "tools": "keep-ranked",
    "agentResults": "drop-ranked",
    "skills": "drop-all",
    "injections": "keep-ranked"
  },
  "analysis": {
    "maxPageChars": 12000
  },
  "retrieval": {
    "defaultReadChars": 8000,
    "maxReadChars": 50000,
    "minQueryChars": 2,
    "caseSensitive": false,
    "defaultContextLines": 2,
    "maxContextLines": 10,
    "defaultMatches": 10,
    "maxMatches": 50,
    "maxExcerptChars": 4000,
    "allowRegex": true,
    "maxRegexPatternChars": 500,
    "maxResponseChars": 50000
  }
}
```

`--attachments=MODE` remains as a deprecated alias for all recoverable classes; class-specific flags win.

## Recovery

Omission objects live under `${XDG_DATA_HOME:-~/.local/share}/condense/objects` as directly addressable, sharded Content-IDs with user-only permissions. Their integrity hash covers the complete canonical envelope. Version 0.3.1 intentionally establishes a clean pre-public storage baseline and does not read the short-lived private alpha formats.

```text
read_omitted_content(contentId, start?, length?)
search_omitted_content(query, mode?, contentIds?, caseSensitive?, contextLines?, maxMatches?)
```

A bare read returns a bounded first page with total length and `nextStart`. Search without `contentIds` uses the current condensed session’s exact structural lineage across repeated condensations. Supplying IDs searches exactly those objects. `mode: "regex"` uses the linear-time RE2 subset; literal is the default.

Structured values are preserved as exact JSON values and rendered deterministically for paging/search. They are not claimed to reproduce incidental whitespace from the original JSONL serialization.

## Development and QA

```bash
cd plugins/condense
bun install --frozen-lockfile
bun run check
bun run typecheck
bun test
bun run test:integration
```

The default suite uses minimized synthetic fixtures. Integration tests create disposable synthetic Claude sessions and exercise the real SDK fork, signature preservation, parent chains, titles, repeated condensation, and lineage retrieval.

An authenticated resume check is intentionally opt-in and never runs in CI. Point it at a disposable-capable real transcript containing at least one eligible payload; the harness copies it to throwaway session IDs and removes the fixture, child, and private store afterward:

```bash
CONDENSE_SMOKE_SOURCE_TRANSCRIPT=/absolute/path/to/session.jsonl \
CONDENSE_SMOKE_PROJECT_CWD=/absolute/project/cwd \
bun run test:smoke
```

## Ancestry and license

`condense` is an independently evolved context-paging plugin derived in part from [`claude-magic-compact`](https://github.com/aerovato/magic-compact). It retains and substantially adapts portions of that project’s transcript, omission-store, and MCP machinery while replacing its spawned summarizer with in-session retention ranking.

Both projects use the BSD 3-Clause license. Both copyright notices are retained in [LICENSE.md](./LICENSE.md).
