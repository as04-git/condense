# condense

Local, model-ranked lossless context condensation for Claude Code.

Forked from [`claude-magic-compact`](https://github.com/aerovato/magic-compact). Where magic-compact spawns a second `claude -p` agent to LLM-summarize prose, `condense` does the compaction **in-session**: the model already holding the conversation ranks which tool outputs (and thinking blocks) to keep, keeps prose verbatim, and prunes the rest to retrievable Content-IDs.

- **prose** — kept verbatim, always.
- **tool-output** / **thinking** — each has modes `keep-all | keep-ranked | drop` (defaults `keep-ranked`).
- Removed tool outputs are retrievable via the `read_omitted_content` MCP tool. Removed thinking is dropped (opaque on disk; nothing readable to archive).
- **keepTurns** default `1`.

Installed as a local `directory`-source marketplace so marketplace updates cannot overwrite it. The upstream `claude-magic-compact` plugin is disabled to avoid command collision.

Status: scaffold + reusable machinery in place; orchestration WIP.
