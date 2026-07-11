import { ClaudeCodeAdapter } from "./claude-adapter";
import { loadConfig, RETENTION_MODES, type ConfigOverrides, type PolicyClass, type RetentionMode } from "./config";
import { runBuild } from "./build";
import { analyzeCurrentSession, inspectAnalysis, prepareBuild } from "./workflow";

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function jsonArgument(rest: string[], command: string): Promise<unknown> {
  const raw = rest[0] ?? (await readStdin());
  if (!raw.trim()) throw new Error(`${command} requires a JSON request as its first argument or on stdin`);
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${command} request is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseAnalyzeArgs(args: string[]): ConfigOverrides {
  const result: ConfigOverrides = { policies: {} };
  let positionalSeen = false;
  const explicit: Partial<Record<PolicyClass, RetentionMode>> = {};
  let attachments: RetentionMode | undefined;
  for (const argument of args) {
    if (!argument.startsWith("--")) {
      if (positionalSeen) throw new Error(`unexpected analyze argument "${argument}"`);
      const value = Number(argument);
      if (!Number.isInteger(value) || value < 0) throw new Error(`invalid keepTurns "${argument}"`);
      result.keepTurns = value;
      positionalSeen = true;
      continue;
    }
    const match = argument.match(/^--([a-z-]+)=(.+)$/);
    if (!match) throw new Error(`invalid option "${argument}"; expected --name=value`);
    const name = match[1]!;
    const value = match[2] as RetentionMode;
    if (!(RETENTION_MODES as readonly string[]).includes(value))
      throw new Error(`invalid retention mode "${match[2]}"`);
    const names: Record<string, PolicyClass> = {
      thinking: "thinking",
      tools: "tools",
      "agent-results": "agentResults",
      skills: "skills",
      injections: "injections",
    };
    if (name === "attachments") attachments = value;
    else if (names[name]) explicit[names[name]!] = value;
    else throw new Error(`unknown option --${name}`);
  }
  if (attachments)
    for (const key of ["tools", "agentResults", "skills", "injections"] as PolicyClass[])
      result.policies![key] = attachments;
  Object.assign(result.policies!, explicit);
  return result;
}

async function main(): Promise<void> {
  const [command, ...rest] = Bun.argv.slice(2);
  const adapter = new ClaudeCodeAdapter();
  if (command === "analyze") {
    const identity = adapter.locateCurrentSession();
    const config = await loadConfig(identity.projectCwd, parseAnalyzeArgs(rest));
    console.log(JSON.stringify(await analyzeCurrentSession(adapter, config)));
    return;
  }
  if (command === "inspect") {
    console.log(JSON.stringify(await inspectAnalysis(adapter, await jsonArgument(rest, command))));
    return;
  }
  if (command === "prepare") {
    console.log(JSON.stringify(await prepareBuild(adapter, await jsonArgument(rest, command))));
    return;
  }
  if (command === "build") {
    console.log(JSON.stringify(await runBuild(adapter, await jsonArgument(rest, command))));
    return;
  }
  console.error("usage: bun condense.ts <analyze [options] | inspect <json> | prepare <json> | build <json>>");
  process.exit(2);
}

main().catch((error) => {
  console.error(`condense: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
