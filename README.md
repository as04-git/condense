# condense

**Model-ranked, lossless-ish context condensation for Claude Code.**

`condense` compacts your **current session** into a **new session you `/resume`
into** — keeping every one of your messages and all of the model's prose
verbatim, while aggressively pruning the bulky, recoverable stuff (tool outputs,
large tool inputs, skill/command dumps) down to retrievable placeholders.

It is a fork of [`claude-magic-compact`](https://github.com/aerovato/magic-compact),
rebuilt around one idea: **don't spawn a second LLM to summarize.** The model
already holding the conversation does the ranking itself, so condensation costs
only a couple of tool calls instead of a full second agent pass.

## Why not just `/compact`?

| | built-in `/compact` | `condense` |
|---|---|---|
| Reduces context | in place, seamless | into a new session you `/resume` |
| What it keeps | a lossy LLM **summary** | your prose + model prose **verbatim** |
| Tool outputs | discarded | pruned to **retrievable** Content-IDs |
| Extra LLM cost | one summarization pass | **none** — the current model ranks in-context |
| Reasoning (thinking) | discarded | keep-ranked or dropped (your choice) |

The trade: condense can't rewrite the live window in place (only the built-in
`/compact` can — that's an internal capability), so you take a manual `/resume`
step. In exchange you get lossless, *recoverable* compaction with model judgment
about what's worth keeping inline.

## What gets kept vs. pruned

- **Prose** — your typed/pasted messages and the model's visible text: **always
  verbatim, never touched.**
- **Attachments** (the large, recoverable stuff) — ranked, then kept inline or
  pruned to a Content-ID:
  - **tool outputs** (re-runnable), **big tool inputs** (`Write`/`Edit`/`Bash`/…
    payloads — on disk + Content-ID), **skill/injected dumps** (re-invoke the skill
    to reload).
- **Thinking** (the model's prior reasoning) — `keep-all | keep-ranked | drop`.
  Kept blocks are preserved byte-for-byte; dropped ones are gone (they're opaque
  on disk — nothing readable to archive).

Every condensed session opens with a deterministic **marker** stating exactly what
was freshly pruned, what was already a placeholder from an earlier pass, and what
is genuinely kept inline — so the resumed model never has to guess.

## Recovering pruned content

Anything pruned leaves a placeholder with a **Content-ID**. Retrieve the exact
original bytes with the bundled MCP tool:

```
read_omitted_content(contentId: "…")
```

Skill dumps don't get a Content-ID by default — just re-invoke the skill
(`/<skill>`) to reload it. The original, un-pruned session is also left untouched
on disk; `/resume` it any time to see everything.

## Install

Requires [`bun`](https://bun.sh) on your `PATH` (the CLI, MCP server, and hook all
run `.ts` directly, no build step).

```bash
# register this repo as a local marketplace (updates can't clobber it)
claude plugin marketplace add /path/to/condense

# install the plugin
claude plugin install condense@condense-local

# optional: disable the upstream to avoid command overlap
claude plugin disable claude-magic-compact@magic-compact
```

Restart Claude Code so the `/condense` skill and the `read_omitted_content` MCP
server register.

## Usage

```
/condense [keepTurns] [--attachments=keep-all|keep-ranked|drop]
                      [--thinking=keep-all|keep-ranked|drop]
```

Defaults: `keepTurns=1`, `--attachments=keep-ranked`, `--thinking=keep-ranked`.
Bare `/condense` = "keep my prose + reasoning, intelligently thin the tool
outputs, leave the most recent turn fully intact." When it finishes it prints a
new session id — `/resume` into it.

## How it works (two tool calls)

1. **`analyze`** — a mechanical pass over the transcript: per-turn / per-type size
   breakdown plus ranked candidate lists (each attachment carries a short content
   snippet so the model ranks by recognizing content, not guessing).
2. *(the model ranks in-context — not a tool call)*
3. **`build`** — writes the new compacted session: prose verbatim, kept thinking
   byte-identical, pruned attachments → Content-IDs, one clean linear chain, a
   fresh identity, and the closing marker.

See [`CLAUDE.md`](./CLAUDE.md) for architecture and the invariants that keep
`/resume` working.

## Attribution & license

Fork of [`claude-magic-compact`](https://github.com/aerovato/magic-compact) by
Kevin Liao @ Aerovato Research — the transcript-surgery, omission-store, and
MCP-retrieval machinery originate there. That project is **BSD 3-Clause**
licensed; this fork retains that license and adds the fork's modifications under
the same terms. See [`LICENSE.md`](./LICENSE.md) (both copyright notices
retained per the BSD-3 terms).
