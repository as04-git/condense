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

Once protected prose dominates the context, analyze reports that floor so you can decide when semantic compaction is the better next step.

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

Modes are `keep-all`, `keep-ranked`, `drop-ranked`, and `drop-all`. The workflow is two mechanical calls: analyze produces candidates plus an opaque receipt; the current model ranks them; build validates the receipt and forks through the official Claude Agent SDK.

Defaults:

- thinking: `drop-ranked` (only explicitly selected thinking is removed);
- ordinary tools: `keep-ranked`;
- agent results: `drop-ranked`;
- re-invokable skills: `drop-all`;
- other injections: `keep-ranked`;
- most recent real turn: fully untouched.

The final visible marker reports actual reclaim, prompt-anchored thinking ranges, per-class inline/new/pre-omitted counts, lineage size, and recovery commands.

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
    "maxRegexPatternChars": 500
  }
}
```

`--attachments=MODE` remains as a deprecated alias for all recoverable classes; class-specific flags win.

## Recovery

New typed stores live under `${XDG_DATA_HOME:-~/.local/share}/condense` with user-only permissions. Legacy `~/.claude/condense-store` caches remain readable.

```text
read_omitted_content(contentId, start?, length?)
search_omitted_content(query, mode?, contentIds?, caseSensitive?, contextLines?, maxMatches?)
```

A bare read returns a bounded first page with total length and `nextStart`. Search without `contentIds` uses the current condensed session’s exact structural lineage across repeated condensations. Supplying IDs searches exactly those objects. `mode: "regex"` uses the linear-time RE2 subset; literal is the default.

Structured values are preserved as exact JSON values and rendered deterministically for paging/search. They are not claimed to reproduce incidental whitespace from the original JSONL serialization.

## Development and QA

```bash
cd plugins/condense
bun install
bun run typecheck
bun test
bun run test:integration
```

The default suite uses minimized synthetic fixtures. Integration tests create disposable synthetic Claude sessions and exercise the real SDK fork, signature preservation, parent chains, titles, repeated condensation, and lineage retrieval.

## Ancestry and license

`condense` is an independently evolved context-paging plugin derived in part from [`claude-magic-compact`](https://github.com/aerovato/magic-compact). It retains and substantially adapts portions of that project’s transcript, omission-store, and MCP machinery while replacing its spawned summarizer with in-session retention ranking.

Both projects use the BSD 3-Clause license. Both copyright notices are retained in [LICENSE.md](./LICENSE.md).
