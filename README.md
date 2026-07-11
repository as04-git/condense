# condense

**Lossless, recoverable context condensation for coding agents.**

Condense moves bulky structured payloads out of Claude's active context while preserving the conversation itself. Every genuine user message and every assistant text block before the condensation command stays verbatim. Selected tool inputs, tool outputs, agent results, skill injections, and other injected material become integrity-checked Content-IDs that remain locally searchable and readable. Signed thinking is either kept byte-for-byte or dropped as a whole block.

“Lossless” here describes durable conversational content: prose is verbatim and externalized structured values preserve their exact JSON semantics. Deliberately dropped ephemeral thinking and incidental JSONL whitespace are not reconstructible from the child. The unchanged parent remains the full fallback.

The result is a new Claude Code session that you `/resume` into. The parent session is never modified.

The repository is organized as a host-neutral Condense project. `plugins/claude-code` is the current distribution; a future Codex adapter can live under `plugins/codex` without changing the planner or public workflow.

> Condense is alpha software. Version 0.3.2 establishes a clean storage baseline and intentionally does not support the short-lived pre-0.3.1 private formats.

## Why this exists

Long coding sessions often become context-heavy for mechanical reasons: repeated file reads, build logs, search results, large tool arguments, subagent payloads, and re-injected skill text. Those values can consume much of the live context even when the important conversational decisions around them are still concise.

Condense treats those payloads as recoverable attachments rather than as prose to summarize. The model already participating in the session reviews compact evidence, decides what must remain inline, and can externalize the rest without invoking a second model.

This makes Condense a high-fidelity context pager, complementary to Claude Code's semantic `/compact`:

| | Claude Code `/compact` | Condense |
|---|---|---|
| Conversation history | Replaced by an LLM summary | Genuine prose remains verbatim |
| Structured payloads | May be represented only through the summary | Exact JSON values can become retrievable Content-IDs |
| Signed thinking | Not preserved as resumable signed blocks | Kept byte-identically or dropped whole |
| Intelligence step | A new summarization pass | Current model reviews bounded evidence |
| Output | Rewrites the current session context | Creates a new resumable child session |
| Recovery | Depends on the summary and parent transcript | Bounded read/search over the child's Content-ID lineage |

Use `/compact` when you want semantic compression and accept a summary. Use Condense when exact wording and recoverable tool evidence matter. They solve different problems and can be used at different points in a long-running task.

## What it is good at

- **Preserving commitments and nuance.** User instructions, assistant explanations, conclusions, and code-review prose remain byte-for-byte text rather than becoming a paraphrase.
- **Removing mechanical bulk.** Large reconstructible reads, logs, tool arguments, and repeated injections can leave the active context without being destroyed.
- **Keeping recovery practical.** Placeholders carry directly addressable `co_…` IDs. MCP tools can page one value or search the exact multi-generation lineage.
- **Making irreversible effects visible.** Prepare reports dropped thinking first because thinking is the one eligible class that cannot be recovered from the omission store.
- **Avoiding fake token precision.** Planning and verification use exact active-context characters. Condense does not convert characters through a generic chars-per-token ratio.
- **Failing closed.** Source drift, changed user activity, SDK lineage loss, projection mismatch, integrity failure, and unsupported record versions abort rather than silently publishing a questionable child.
- **Leaving an escape hatch.** The source session stays intact, so the user can always return to it.

## Workflow

```text
analyze → inspect zero or more times → prepare → build → /resume
```

### Analyze: compact decision evidence

Analyze snapshots both the full SDK fork-source prefix and the exact active context. It returns a bounded, columnar candidate page plus an opaque `cr_` receipt.

It deliberately does **not** lead with a projected saving, percentage, token estimate, gross-eligible total, or minimum possible context. Those numbers can turn review into rubber-stamping. Instead, each candidate carries a local `netChars` cost and short type-aware evidence. Candidates not shown or inspected retain their safe policy defaults.

### Inspect: progressive disclosure

Inspect either paginates the stable candidate ordering or expands selected refs with bounded evidence. Payload size never causes a larger preview. The agent can ask for paths, command context, head/tail excerpts, failure windows, result boundaries, and supersession evidence only where the initial row is insufficient.

### Prepare: exact, non-mutating dry run

Prepare accepts the agent's explicit keep/drop overrides, allocates the real Content-IDs, and runs the exact final planner without creating a fork or publishing omission objects. It returns a short `bp_` plan handle and a neutral audit ordered as:

1. kept and unrecoverably dropped thinking;
2. externalized and inline counts by class;
3. exact source, projected, and removed active-context characters;
4. warnings.

Prepare can be repeated with revised decisions. Each plan is independent.

### Build: commit exactly the reviewed plan

Build accepts only the `bp_` handle. It revalidates the source, forks through the official Claude Agent SDK, applies the frozen mutations, and verifies that the built active context exactly matches Prepare. Publication order is omission objects, lineage manifest, then transcript, so a failed build may leave harmless unreferenced objects but cannot publish placeholders whose objects were never written.

Receipt and plan records are private, expire after 24 hours, and are consumed after success. A recoverable failure retains them for retry.

## Design inclinations

Condense treats agent ergonomics as part of correctness, not presentation polish:

- **Spend agent context only on decisions.** Default output is compact; details are available on demand. Internal versioning, hashes, provenance, and storage mechanics stay behind opaque handles unless they are needed.
- **Show evidence before optimization.** Analyze helps decide what information is load-bearing. Only after decisions are made does Prepare show aggregate impact.
- **Put danger before savings.** Unrecoverable thinking loss appears before character reduction. The tool never labels a plan “good” or recommends committing it.
- **Prefer safe defaults over forced completeness.** Hidden candidates retain policy defaults. Missing optional capabilities are omitted from output rather than represented by noisy `null` fields.
- **Use exact units or say nothing.** Character projections are deterministic and build-verified. Model-specific token counts should appear only if one trustworthy method can count both source and projected contexts at the same scope.
- **Separate host quirks from policy.** The retention planner is pure and host-neutral. Claude-specific transcript discovery, active-context selection, fork behavior, titles, markers, and resume semantics live in the adapter.
- **Keep lifecycle policy with the user.** Condense measures local recovery storage but does not guess when a conversation has stopped being valuable enough to retain.

These preferences intentionally trade a few mechanical calls for a workflow in which the reviewed decision is the committed decision.

## Install

Condense requires Bun on `PATH` and network access to the npm registry on first use or after a dependency update.

From inside Claude Code:

```text
/plugin marketplace add as04-git/condense
/plugin install condense@condense
/reload-plugins
```

For local development:

```bash
claude plugin marketplace add /path/to/condense
claude plugin install condense@condense
```

The first invocation installs pinned production dependencies and a sealed copy of the runtime source into Claude's persistent plugin-data directory. Condense explicitly omits the Agent SDK's large optional native binaries because its `forkSession` path does not require them. Later invocations reuse that runtime; updates reinstall only when the bundled source, package manifest, or lockfile changes.

Update or remove the public plugin with:

```text
/plugin marketplace update condense
/plugin update condense@condense
/plugin uninstall condense@condense
```

## Use

```text
/condense:condense [keepTurns] [--thinking=MODE] [--tools=MODE]
                                 [--agent-results=MODE] [--skills=MODE]
                                 [--injections=MODE]
```

Modes:

- `keep-all`: keep every eligible value in that class inline;
- `keep-ranked`: externalize by default; explicitly select values that must remain inline;
- `drop-ranked`: keep by default; explicitly select values that are clearly obsolete;
- `drop-all`: externalize or drop every eligible value in that class.

Built-in defaults:

- thinking: `drop-ranked`;
- ordinary tools: `keep-ranked`;
- agent results: `drop-ranked`;
- re-invokable skills: `drop-all`;
- other injections: `keep-ranked`;
- most recent real turn: completely untouched.

The closing marker reports the actual character change, prompt-anchored thinking ranges, inline/new/pre-omitted counts, lineage size, and recovery commands. Condense never emits heuristic token counts.

## Recovery

Omission objects live under `${XDG_DATA_HOME:-~/.local/share}/condense/objects` in directly addressable shards. Directories are user-only `0700`; files are `0600`. Each object's integrity hash covers its complete canonical envelope. This provides tamper detection, not encryption or protection from a user/process that can already read your account files.

```text
read_omitted_content(contentId, start?, length?)
search_omitted_content(query, mode?, contentIds?, caseSensitive?, contextLines?, maxMatches?)
```

A bare read returns a bounded first page with continuation metadata. Search without explicit IDs uses the current child's structural lineage, including inherited objects from earlier Condense generations. Search is literal by default; explicit regex uses the linear-time RE2 subset. Matches, captures, excerpts, metadata, query length, and the complete MCP response are bounded.

Structured values retain their exact JSON semantics and are rendered deterministically for paging and search. Condense does not claim to preserve incidental whitespace from the source JSONL serialization.

## Storage visibility and cleanup policy

Condense intentionally has no automatic object garbage collector. A child manifest may reference objects created several generations earlier, and those objects can be shared by multiple descendant lineages. The plugin also does not own Claude's session-retention decisions. Automatically inferring that an object is unwanted could silently destroy the main recovery guarantee.

Use the read-only storage report instead:

```bash
# Overall store; inside Claude, also reports the current session lineage.
bun "${CLAUDE_PLUGIN_ROOT}/src/bootstrap.ts" condense "${CLAUDE_PLUGIN_DATA}" storage

# Overall store plus one explicit conversation lineage.
bun "${CLAUDE_PLUGIN_ROOT}/src/bootstrap.ts" condense "${CLAUDE_PLUGIN_DATA}" storage <session-id>
```

The compact JSON reports exact regular-file bytes for the whole root, objects, manifests, and pending workflow records. A lineage adds referenced/present/missing object counts, the unique object-file bytes referenced by that manifest, and rendered payload characters.

`lineage.objectBytes` is **attributable**, not necessarily reclaimable: another manifest may reference the same object. Whole-store deletion is safe only when you intentionally accept losing all Condense recovery data and any pending plans. Selective cleanup should be based on reachability across every manifest you intend to retain. Condense exposes the measurements and manifests but leaves that policy decision to the user.

Workflow locks are owner-stamped. Concurrent live operations are rejected; a lock left by a crashed process on the same host is reclaimed, while malformed or foreign-host locks are reclaimed only after the 24-hour pending-record lifetime. Token-checked release prevents an older owner from deleting a replacement lock.

## Configuration

Configuration precedence is built-ins → global → nearest project config → invocation flags.

- Global: `${XDG_CONFIG_HOME:-~/.config}/condense/config.json`
- Project: nearest ancestor `.condense.json`

Configuration is strict: unknown keys, invalid modes, and inconsistent limits abort instead of silently changing retention.

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

`--attachments=MODE` remains a deprecated convenience alias for all recoverable classes; class-specific flags win.

## Architecture and correctness boundary

```text
Claude adapter
  ├─ complete SDK fork-source entries
  └─ active context entries
           │
           ▼
    pure retention planner ──► exact character projection
           │
           ▼
    frozen prepared plan
           │
           ▼
official SDK fork → ref-mapped mutations → objects → manifest → transcript
```

Storage entries and active-context entries are intentionally different. Opaque metadata, inactive branches, `content-replacement`, and `relocated` entries must survive the SDK fork even though they do not become candidates or affect context accounting. Candidate mutations are keyed by source identity rather than row order because the SDK can reorder equivalent parallel tool-result rows.

Kept thinking blocks are never parsed and rewritten: their exact signed block is retained or the entire block is removed. Build asserts both projected active-context characters and a deterministic content digest before publishing the child transcript.

## Honest limitations

- **It cannot compress protected prose.** When genuine conversation text dominates the context, Condense has little left to remove. Prepare makes that limit visible.
- **Thinking deletion is irreversible in the child.** Dropped signed thinking is not written to the omission store. The unchanged parent remains the fallback.
- **Ranking can still be wrong.** The current model may misjudge what should remain inline. Safe defaults, bounded inspection, repeated Prepare, and recoverability reduce the consequence; they do not make judgment infallible.
- **Recovery has a future context cost.** Reading an omitted object consumes a tool round-trip and brings selected content back into the current context.
- **Characters are not tokens.** Exact character removal is reproducible across model versions, but it does not promise a particular token reduction. Claude Code currently does not expose a trustworthy parent-and-projected model-specific counter to the plugin process.
- **This is a new session identity.** The source remains available and the filesystem working tree is unchanged, but host UI/session metadata can differ. Title, banner, marker, resume, and signature behavior are covered by adapter and smoke tests rather than assumed portable.
- **The local store grows until the user cleans it.** Measurement is built in; automatic deletion is not. Omitted data is still present on disk and should not be mistaken for secure erasure.
- **Very large lineages are bounded.** Retrieval caps request scope and response size; unusually large histories may need explicit Content-ID subsets.
- **Claude compatibility depends on the SDK and host format.** Condense pins its dependencies, preserves unknown entries, and fails closed on drift, but Claude Code changes can still require adapter updates.
- **The Codex adapter does not exist yet.** The planner and protocol were shaped around a host boundary, but 0.3.2 stabilizes Claude Code only.

## Development and QA

```bash
cd plugins/claude-code
bun install --frozen-lockfile
bun run check
bun run typecheck
bun test
bun run test:bootstrap
bun run test:integration
```

The unit suite uses minimized synthetic fixtures. Integration tests create disposable Claude sessions and exercise the real SDK fork, signature preservation, parent chains, inactive branches, opaque storage entries, titles, repeated condensation, and lineage retrieval. CI runs the unit, clean-bootstrap, SDK integration, type, format, and package checks on Linux, macOS, and Windows. The authenticated resume smoke has been exercised on Linux/WSL2.

An authenticated resume check is opt-in and never runs in CI. Point it at a disposable-capable real transcript with at least one eligible payload; the harness copies it to throwaway IDs and removes the fixture, child, and private store afterward:

```bash
CONDENSE_SMOKE_SOURCE_TRANSCRIPT=/absolute/path/to/session.jsonl \
CONDENSE_SMOKE_PROJECT_CWD=/absolute/project/cwd \
bun run test:smoke
```

## Ancestry and license

Condense is independently evolved from parts of [`claude-magic-compact`](https://github.com/aerovato/magic-compact). It retains and substantially adapts transcript, omission-store, and MCP machinery while replacing the spawned summarizer with in-session retention planning and an exact staged build protocol.

Both projects use the BSD 3-Clause license. The standard license text and both copyright notices are in [LICENSE.md](./LICENSE.md); derivative and external-dependency attribution is in [NOTICE.md](./NOTICE.md).

## Security and privacy

Condense is an independent, unofficial project and is not affiliated with or endorsed by Anthropic or OpenAI.

- Condensation and retrieval operate on local Claude Code session files. Condense does not call a second LLM or send omission objects to a separate service.
- First-use dependency bootstrap contacts the configured npm registry and installs the exact versions pinned by `bun.lock` into `${CLAUDE_PLUGIN_DATA}`. Dependency lifecycle scripts and the Agent SDK's optional native binaries are disabled.
- Omission objects and workflow records are stored with user-only permissions where the filesystem supports POSIX modes. Their hashes detect tampering; the files are not encrypted and remain readable to processes with access to the same user account.
- Retrieving an omitted value intentionally sends the selected excerpt back through the active Claude session, subject to Claude Code's normal data handling.
- The plugin can execute with the user's privileges, as all Claude Code plugins can. Review the source and install only from a repository you trust.
