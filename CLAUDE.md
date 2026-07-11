# CLAUDE.md — `condense`

## Purpose

`condense` is a Claude Code context-paging plugin. It forks the current session through the official Claude Agent SDK, preserves all genuine user/assistant prose, keeps signed thinking byte-identical or drops it whole, and externalizes selected structured payloads to typed Content-IDs.

It is derived in part from `claude-magic-compact`, but its retention protocol, in-session ranking, SDK fork architecture, lineage search, typed storage, and deterministic marker are independently evolved.

## Protocol

The skill follows `analyze → inspect* → prepare → build`:

1. `analyze` loads strict configuration, snapshots the complete SDK fork-source prefix and active host context separately, and emits a bounded evidence page plus a `cr_` receipt.
2. `inspect` optionally paginates or expands selected refs. It is a private CLI subcommand, not an MCP tool.
3. `prepare` accepts `{receipt, keep, drop, title?}`, validates both source digests, assigns real v3 IDs, runs the exact planner, and returns a neutral audit plus a `bp_` handle. It does not fork or publish omission data.
4. `build` accepts only `{plan}`, revalidates the frozen boundary, forks to the sealed cutoff, applies exactly the prepared mutations, publishes objects/manifest/transcript in that order, and asserts the active-context character count equals the dry run.

Retention classes are thinking, tools, agent results, skills, and injections. Modes are `keep-all`, `keep-ranked`, `drop-ranked`, and `drop-all`. Thinking and agent results default to explicit drop; recoverable tools/injections default to explicit keep.

## Non-negotiable invariants

- Thinking blocks are byte-identical or removed whole. Never edit signed thinking.
- Genuine user messages and assistant text are verbatim.
- `isMeta === true` plus structured/list content remains the injected-content discriminator.
- Analyze identifies the newest operation turn once; later stages use the frozen cutoff and never scan backward deleting matching real turns.
- Kept recent turns are content-untouched.
- SDK storage entries, opaque metadata, `content-replacement`, `relocated`, and inactive branches are preserved. Retention applies only to mapped active-context candidates.
- Inactive branches never affect candidates, lineage, accounting, or marker statistics.
- Every decision-dependent fork row must carry `forkedFrom.messageUuid`; SDK drift fails closed.
- Both `custom-title` and `agent-name` rows are emitted for the new session.
- Multi-leaf SDK output is tolerated. The marker is parented to the mapped cutoff or nearest surviving ancestor and has the newest timestamp.
- Prior markers are removed. Marker rows never participate in semantic turns, prompt anchors, or titles.
- New v3 objects contain typed exact JSON values, a hash over the complete canonical envelope, and bounded provenance. Legacy v1/v2 stores are read-only compatible.
- Store/manifest files publish before the transcript; a crash may orphan data but may not publish broken placeholders.
- Lineage manifests collect only IDs in condense-owned structured placeholder locations, never ID-shaped prose.

## Storage and retrieval

- New data: `${XDG_DATA_HOME:-~/.local/share}/condense/{objects,manifests,pending}`.
- Legacy reads: `~/.claude/condense-store`.
- Directories are `0700`; files are `0600`; malformed data, hash failures, and ambiguous short-ID suffixes are errors.
- Pending `cr_` and `bp_` records expire after 24 hours and unsupported versions require a fresh analyze/prepare.
- `read_omitted_content` is always bounded unless an explicit allowed length is supplied.
- Complete MCP responses are bounded. `search_omitted_content` is literal by default and current-lineage scoped when IDs are omitted. Literal and explicit regex search use pinned RE2JS.
- Exact active-context characters are the deterministic accounting unit. Do not add generic chars-per-token heuristics.

## Development

Runtime is Bun. Before delivery run:

```bash
bun install --frozen-lockfile
bun run check
bun run typecheck
bun test
bun run test:integration
claude plugin validate .
```

Then update `condense@condense-local`, launch a fresh Claude process, resume a disposable condensed session, and verify title/banner, marker, bounded read, literal/regex lineage search, and repeated condensation.

Never commit private real-session fixtures. Commit only minimized synthetic fixtures. Commit author, if requested, is Aryan Shrivastava <48136120+as04-git@users.noreply.github.com>.
