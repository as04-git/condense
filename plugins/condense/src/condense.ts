// condense.ts — the single CLI the /condense skill drives. Two subcommands,
// each auto-locating the CURRENT session transcript via $CLAUDE_CODE_SESSION_ID
// so the model never has to find or pass a path:
//
//   bun condense.ts analyze [keepTurns]      -> stats + attachment candidates
//   bun condense.ts build '<ranking-json>'   -> writes the compacted session
//                                               (ranking may also arrive on stdin)
//
// This keeps the whole user story to two tool calls: analyze, then build.

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runAnalyze } from "./analyze";
import { runBuild } from "./build";
import { readActiveTranscriptRows } from "./transcript";

function locateTranscript(): string {
  const sid = process.env["CLAUDE_CODE_SESSION_ID"];
  if (!sid) {
    throw new Error(
      "CLAUDE_CODE_SESSION_ID is not set — cannot locate the current session transcript.",
    );
  }
  const base = join(homedir(), ".claude", "projects");
  let dirs: string[];
  try {
    dirs = readdirSync(base);
  } catch {
    throw new Error(`Claude projects directory not found: ${base}`);
  }
  for (const dir of dirs) {
    const p = join(base, dir, `${sid}.jsonl`);
    if (existsSync(p)) return p;
  }
  throw new Error(`Transcript for session ${sid} not found under ${base}`);
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const [cmd, ...rest] = Bun.argv.slice(2);
  const transcript = locateTranscript();

  if (cmd === "analyze") {
    const keepTurns = rest[0] ? Math.max(0, Number(rest[0])) : 1;
    const rows = await readActiveTranscriptRows(transcript);
    console.log(JSON.stringify(runAnalyze(rows, keepTurns)));
    return;
  }

  if (cmd === "build") {
    const raw = rest[0] ?? (await readStdin());
    if (!raw || !raw.trim()) {
      throw new Error("build requires a ranking JSON (as the first argument or on stdin).");
    }
    const result = await runBuild(transcript, JSON.parse(raw));
    console.log(JSON.stringify(result));
    return;
  }

  console.error("usage: bun condense.ts <analyze [keepTurns] | build '<ranking-json>'>");
  process.exit(2);
}

main().catch((err) => {
  console.error(`condense: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
