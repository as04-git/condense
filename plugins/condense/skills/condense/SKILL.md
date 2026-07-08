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
- **tool-output** — modes `keep-all | keep-ranked | drop`; default `keep-ranked` (max ≈15). Removed outputs become retrievable Content-IDs via the `read_omitted_content` MCP tool.
- **thinking** — modes `keep-all | keep-ranked | drop`; default `keep-ranked`. Ranking is done in-session by the model (which holds the decrypted reasoning) using the turn's reasoning + prose as signal; kept thinking blocks are byte-copied (signatures intact); dropped ones are removed.
- **keepTurns** — recent turns left fully untouched. Default `1`.

Until implemented, `/condense` does nothing useful. Do not rely on it.
