# CLAUDE.md — `condense`

## Purpose

`condense` is a Claude Code context-paging plugin. It forks the current session through the official Claude Agent SDK, preserves all genuine user/assistant prose, keeps signed thinking byte-identical or drops it whole, and externalizes selected structured payloads to typed Content-IDs.

It is derived in part from `claude-magic-compact`, but its retention protocol, in-session ranking, SDK fork architecture, lineage search, typed storage, and deterministic marker are independently evolved.

## Protocol

The skill performs exactly two CLI calls:

1. `condense.ts analyze`: loads strict global/project/invocation config, identifies the current `/condense` operation once, excludes it and old markers from semantic turns, and emits candidates plus an opaque receipt.
2. `condense.ts build`: accepts `{receipt, keep, drop, title?}`, recomputes source/candidate hashes, rejects drift or malformed decisions, forks to the sealed cutoff, applies retention, publishes the store/manifest, then atomically publishes the final transcript.

Retention classes are thinking, tools, agent results, skills, and injections. Modes are `keep-all`, `keep-ranked`, `drop-ranked`, and `drop-all`. Thinking and agent results default to explicit drop; recoverable tools/injections default to explicit keep.

## Non-negotiable invariants

- Thinking blocks are byte-identical or removed whole. Never edit signed thinking.
- Genuine user messages and assistant text are verbatim.
- `isMeta === true` plus structured/list content remains the injected-content discriminator.
- Analyze identifies the newest operation turn once; build uses the receipt cutoff and never scans backward deleting matching real turns.
- Kept recent turns are content-untouched.
- Every decision-dependent fork row must carry `forkedFrom.messageUuid`; SDK drift fails closed.
- Both `custom-title` and `agent-name` rows are emitted for the new session.
- Multi-leaf SDK output is tolerated. The marker is parented to the mapped cutoff or nearest surviving ancestor and has the newest timestamp.
- Prior markers are removed. Marker rows never participate in semantic turns, prompt anchors, or titles.
- New stores contain typed exact JSON values, SHA-256 hashes, and useful provenance. Legacy string stores are read-only compatible.
- Store/manifest files publish before the transcript; a crash may orphan data but may not publish broken placeholders.
- Lineage manifests collect only IDs in condense-owned structured placeholder locations, never ID-shaped prose.

## Storage and retrieval

- New data: `${XDG_DATA_HOME:-~/.local/share}/condense/{sessions,manifests}`.
- Legacy reads: `~/.claude/condense-store`.
- Directories are `0700`; files are `0600`; malformed data, hash failures, and ambiguous short-ID suffixes are errors.
- `read_omitted_content` is always bounded unless an explicit allowed length is supplied.
- `search_omitted_content` is literal by default and current-lineage scoped when IDs are omitted. Regex is explicit and uses pinned RE2JS.

## Development

Runtime is Bun. Before delivery run:

```bash
bun run typecheck
bun test
bun run test:integration
claude plugin validate .
```

Then update `condense@condense-local`, launch a fresh Claude process, resume a disposable condensed session, and verify title/banner, marker, bounded read, literal/regex lineage search, and repeated condensation.

Never commit private real-session fixtures. Commit only minimized synthetic fixtures. Commit author, if requested, is Aryan Shrivastava <48136120+as04-git@users.noreply.github.com>.
