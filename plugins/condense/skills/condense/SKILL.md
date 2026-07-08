---
name: condense
description: Losslessly condense this Claude Code session — keep prose verbatim, rank tool outputs (and thinking) to keep the important ones, prune the rest to retrievable Content-IDs.
argument-hint: "[keepTurns] [--thinking=keep-all|keep-ranked|drop] [--thinking-max=N] [--tools=keep-all|keep-ranked|drop] [--tools-max=N]"
disable-model-invocation: true
---

# condense — WORK IN PROGRESS

Scaffold only. The orchestration (analyze → present stats → in-session ranking → mechanical build → resume-test) is not implemented yet.

Design (locked):
- **prose** — kept verbatim, always.
- **tool I/O** — one `tools` mode (`keep-all | keep-ranked | drop`, default `keep-ranked`) governs BOTH tool outputs and big tool inputs (Write/Edit/Bash/Agent/Workflow/etc.). Small inputs (filepaths, patterns) are always kept verbatim and are never ranking candidates. Removed I/O becomes retrievable Content-IDs via the `read_omitted_content` MCP tool. No size threshold decides keep/drop — the model's ranking does; a floor only decides which inputs are big enough to be candidates.
- **thinking** — modes `keep-all | keep-ranked | drop`; default `keep-ranked`. Ranking is done in-session by the model (which holds the decrypted reasoning) using the turn's reasoning + prose as signal; kept thinking blocks are byte-copied (signatures intact); dropped ones are removed (thinking-only assistant rows that become empty are dropped and their children rewired).
- **keepTurns** — recent turns left fully untouched. Default `1`.

Until implemented, `/condense` does nothing useful. Do not rely on it.
