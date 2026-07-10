// condense.ts — the single CLI the /condense skill drives. Two subcommands,
// each auto-locating the CURRENT session transcript via $CLAUDE_CODE_SESSION_ID
// so the model never has to find or pass a path:
//
//   bun condense.ts analyze [keepTurns]      -> stats + attachment candidates
//   bun condense.ts build '<ranking-json>'   -> writes the compacted session
//                                               (ranking may also arrive on stdin)
//
// This keeps the whole user story to two tool calls: analyze, then build.

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runAnalyze } from "./analyze";
import { runBuild } from "./build";
import { loadConfig, RETENTION_MODES, type ConfigOverrides, type PolicyClass, type RetentionMode } from "./config";
import { findCondenseOperationBoundary, readActiveTranscriptRows } from "./transcript";

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
  const matches: string[] = [];
  for (const dir of dirs) {
    const p = join(base, dir, `${sid}.jsonl`);
    if (existsSync(p)) matches.push(p);
  }
  if (matches.length === 0) {
    throw new Error(`Transcript for session ${sid} not found under ${base}`);
  }
  if (matches.length > 1) {
    // Session IDs are UUIDs, so this should be impossible — but if a transcript
    // was copied across projects, pick the most-recently-modified and warn
    // rather than silently resolving to an arbitrary one.
    matches.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    console.error(
      `condense: WARNING — ${matches.length} transcripts match session ${sid}; using newest:\n  ${matches.join("\n  ")}`,
    );
  }
  return matches[0]!;
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
    const rows = await readActiveTranscriptRows(transcript);
    const boundary = findCondenseOperationBoundary(rows);
    const cutoff = rows.find((row) => row.uuid === boundary.cutoffUuid);
    const cwd = typeof cutoff?.["cwd"] === "string" ? cutoff["cwd"] : process.cwd();
    const config = await loadConfig(cwd, parseAnalyzeArgs(rest));
    const sessionId = process.env["CLAUDE_CODE_SESSION_ID"] ?? "";
    console.log(JSON.stringify(runAnalyze(rows, config, { sessionId, cutoffUuid: boundary.cutoffUuid })));
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

function parseAnalyzeArgs(args: string[]): ConfigOverrides {
  const result: ConfigOverrides = { policies: {} };
  let positionalSeen = false;
  const explicit: Partial<Record<PolicyClass, RetentionMode>> = {};
  let attachments: RetentionMode | undefined;
  for (const arg of args) {
    if (!arg.startsWith("--")) {
      if (positionalSeen) throw new Error(`unexpected analyze argument "${arg}"`);
      const value = Number(arg);
      if (!Number.isInteger(value) || value < 0) throw new Error(`invalid keepTurns "${arg}"`);
      result.keepTurns = value; positionalSeen = true; continue;
    }
    const match = arg.match(/^--([a-z-]+)=(.+)$/);
    if (!match) throw new Error(`invalid option "${arg}"; expected --name=value`);
    const name = match[1]!;
    const rawValue = match[2]!;
    const value = rawValue as RetentionMode;
    if (!(RETENTION_MODES as readonly string[]).includes(value)) throw new Error(`invalid retention mode "${match[2]}"`);
    const names: Record<string, PolicyClass> = { thinking: "thinking", tools: "tools", "agent-results": "agentResults", skills: "skills", injections: "injections" };
    if (name === "attachments") attachments = value;
    else {
      const policyClass = names[name];
      if (policyClass) explicit[policyClass] = value;
      else throw new Error(`unknown option --${name}`);
    }
  }
  if (attachments) for (const key of ["tools", "agentResults", "skills", "injections"] as PolicyClass[]) result.policies![key] = attachments;
  Object.assign(result.policies!, explicit);
  return result;
}

main().catch((err) => {
  console.error(`condense: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
