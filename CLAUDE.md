# CLAUDE.md — `condense`

## Purpose

`condense` is a host-neutral context-paging project. The current distribution lives in `plugins/claude-code`; it forks the active Claude Code session through the official Claude Agent SDK, preserves all genuine user/assistant prose, keeps signed thinking byte-identical or drops it whole, and externalizes selected structured payloads to typed Content-IDs. A future Codex distribution belongs in `plugins/codex` and should reuse the planner rather than fork it.

It is derived in part from `claude-magic-compact`, but its retention protocol, in-session ranking, SDK fork architecture, lineage search, typed storage, and deterministic marker are independently evolved.

## Protocol

The skill follows `analyze → inspect* → prepare → build`:

1. `analyze` loads strict configuration, snapshots the complete SDK fork-source prefix and active host context separately, and emits a bounded evidence page plus a `cr_` receipt.
2. `inspect` optionally paginates or expands selected refs. It is a private CLI subcommand, not an MCP tool.
3. `prepare` accepts `{receipt, keep, drop, title?}`, validates both source digests, assigns the real Content-IDs, runs the exact planner, and returns a neutral audit plus a `bp_` handle. It does not fork or publish omission data.
4. `build` accepts only `{plan}`, revalidates the frozen boundary, forks to the sealed cutoff, applies exactly the prepared mutations, publishes objects/manifest/transcript in that order, and asserts the active-context character count equals the dry run.

Retention classes are thinking, tools, agent results, skills, and injections. Modes are `keep-all`, `keep-ranked`, `drop-ranked`, and `drop-all`. Thinking and agent results default to explicit drop; recoverable tools/injections default to explicit keep.

## Product and agent-experience compass

- Treat agent context as a constrained product surface. Default output must contain decision signal, not protocol exhaust.
- Use progressive disclosure: bounded initial evidence, optional inspect, then an exact audit. Payload size must not expand previews.
- Separate decision quality from optimization pressure. Analyze must not lead with aggregate savings, percentages, token estimates, or recommendations; Prepare shows impact only after decisions exist.
- Present irreversible effects before size impact. Thinking is not recoverable, so uncertainty always favors retaining it.
- Preserve safe defaults for hidden or uninspected candidates. Do not force the agent to enumerate every candidate.
- Hide internal record evolution behind short opaque handles. Omit unavailable optional fields instead of emitting `null`, heuristics, or cross-model conversions.
- Prefer deterministic, build-verifiable accounting. Add token projections only when one trustworthy model-specific method and scope counts both source and projected contexts.
- Keep host-specific discovery, transcript semantics, titles, markers, and publication in adapters. Keep retention policy and mutation planning host-neutral.
- Fail closed on ambiguity or drift, but keep errors actionable and recoverable. Never weaken validation merely to complete a build.
- Do not automate destructive lifecycle policy. Measure recovery storage compactly and let the user decide when historical recoverability is no longer valuable.

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
- Omission objects contain typed exact JSON values, a hash over the complete canonical envelope, and bounded provenance. Pre-0.3.1 private-alpha stores are intentionally unsupported.
- Store/manifest files publish before the transcript; a crash may orphan data but may not publish broken placeholders.
- Lineage manifests collect only IDs in condense-owned structured placeholder locations, never ID-shaped prose.
- Installed entrypoints go through `src/bootstrap.ts`. It fingerprints runtime source plus `runtime/package.json` and `runtime/bun.lock`, serializes installation into `${CLAUDE_PLUGIN_DATA}`, installs frozen production dependencies with optional SDK binaries and lifecycle scripts disabled, copies the runtime source beside them, and launches targets with `--no-install`. Keep development manifests at repository root; never add a plugin-root `package.json` or rely on Bun's implicit auto-install.

## Storage and retrieval

- New data: `${XDG_DATA_HOME:-~/.local/share}/condense/{objects,manifests,pending}`.
- Pre-0.3.1 private-alpha stores are unsupported; do not reintroduce compatibility code without an explicit product decision.
- Directories are `0700`; files are `0600`; malformed data and hash failures are errors.
- Pending `cr_` and `bp_` records expire after 24 hours and unsupported versions require a fresh analyze/prepare.
- Receipt/plan locks record PID, host, and a random owner token. Reject live contention, recover a dead same-host owner, and reclaim malformed/foreign locks only after the record TTL. Release only a lock whose token still matches.
- `read_omitted_content` is always bounded unless an explicit allowed length is supplied.
- Complete MCP responses are bounded. `search_omitted_content` is literal by default and current-lineage scoped when IDs are omitted. Literal and explicit regex search use pinned RE2JS.
- Exact active-context characters are the deterministic accounting unit. Do not add generic chars-per-token heuristics.
- `bun src/condense.ts storage [session-id]` is read-only and reports exact overall file bytes plus attributable lineage object bytes/payload characters. Lineage bytes are not necessarily reclaimable because manifests may share objects. Do not delete automatically.

## Development

Runtime is Bun. Before delivery run:

```bash
bun install --frozen-lockfile
bun run check
bun run typecheck
bun test
bun run test:bootstrap
bun run test:integration
claude plugin validate .
```

Then update `condense@condense`, launch a fresh Claude process, resume a disposable condensed session, and verify title/banner, marker, bounded read, literal/regex lineage search, and repeated condensation.

Never commit private real-session fixtures. Commit only minimized synthetic fixtures. Preserve the configured GitHub noreply commit identity; never override it with an injected account or billing email.
