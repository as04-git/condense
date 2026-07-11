import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ClaudeCodeAdapter } from "../src/claude-adapter";
import { runBuild } from "../src/build";
import { DEFAULT_CONFIG } from "../src/config";
import { loadManifest, readOmittedContent } from "../src/omission";
import {
  isRecord,
  isTranscriptRow,
  selectActiveTranscriptRows,
  type JsonRecord,
  type TranscriptRow,
} from "../src/transcript";
import { analyzeCurrentSession, prepareBuild } from "../src/workflow";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the opt-in resume smoke test`);
  return value;
}

async function entries(path: string): Promise<JsonRecord[]> {
  return (await readFile(path, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonRecord);
}

function timestampAfter(rows: TranscriptRow[], offset: number): string {
  const latest = rows.reduce((max, row) => Math.max(max, Date.parse(row.timestamp) || 0), Date.now());
  return new Date(latest + offset * 1000).toISOString();
}

function operationRows(template: TranscriptRow, parentUuid: string, sessionId: string): TranscriptRow[] {
  const make = (
    type: "user" | "assistant",
    parent: string,
    content: unknown,
    offset: number,
    extra: JsonRecord = {},
  ): TranscriptRow => ({
    ...template,
    ...extra,
    type,
    uuid: randomUUID(),
    parentUuid: parent,
    sessionId,
    condenseMarker: undefined,
    forkedFrom: undefined,
    isMeta: extra["isMeta"],
    timestamp: timestampAfter([template], offset),
    message: { role: type, content },
  });
  const operation = make("user", parentUuid, "/condense", 1);
  const skill = make(
    "user",
    operation.uuid,
    [{ type: "text", text: "Base directory for this skill: /tmp/condense/skills/condense" }],
    2,
    { isMeta: true },
  );
  const call = make(
    "assistant",
    skill.uuid,
    [{ type: "tool_use", id: `toolu_${randomUUID()}`, name: "Bash", input: { command: "condense analyze" } }],
    3,
  );
  return [operation, skill, call];
}

function signedThinking(rows: TranscriptRow[]): string[] {
  return rows.flatMap((row) => {
    if (row.type !== "assistant" || !isRecord(row.message) || !Array.isArray(row.message["content"])) return [];
    return row.message["content"]
      .filter((block) => isRecord(block) && block["type"] === "thinking")
      .map((block) => JSON.stringify(block));
  });
}

function prose(rows: TranscriptRow[]): string[] {
  return rows.flatMap((row) => {
    if (!isRecord(row.message)) return [];
    const content = row.message["content"];
    if (typeof content === "string" && row["isMeta"] !== true && row["condenseMarker"] !== true) return [content];
    if (row.type !== "assistant" || !Array.isArray(content)) return [];
    return content
      .filter((block) => isRecord(block) && block["type"] === "text")
      .map((block) => String((block as JsonRecord)["text"] ?? ""));
  });
}

async function main(): Promise<void> {
  const sourcePath = required("CONDENSE_SMOKE_SOURCE_TRANSCRIPT");
  const sourceEntries = await entries(sourcePath);
  const sourceRows = selectActiveTranscriptRows(sourceEntries.filter(isTranscriptRow));
  const leaf = sourceRows.at(-1);
  if (!leaf) throw new Error("Smoke source has no active transcript leaf");
  const projectCwd = process.env["CONDENSE_SMOKE_PROJECT_CWD"] || String(leaf["cwd"] || "");
  if (!projectCwd) throw new Error("Set CONDENSE_SMOKE_PROJECT_CWD when the source rows do not contain cwd");

  const fixtureId = randomUUID();
  const fixturePath = join(dirname(sourcePath), `${fixtureId}.jsonl`);
  const dataRoot = await mkdtemp(join(tmpdir(), "condense-resume-smoke-"));
  let childPath = "";
  const previous = {
    session: process.env["CLAUDE_CODE_SESSION_ID"],
    project: process.env["CLAUDE_PROJECT_DIR"],
    data: process.env["CONDENSE_DATA_HOME"],
  };
  try {
    const copied: JsonRecord[] = sourceEntries.map((entry) => ({ ...entry, sessionId: fixtureId }) as JsonRecord);
    const copiedRows = selectActiveTranscriptRows(copied.filter(isTranscriptRow));
    const copiedLeaf = copiedRows.at(-1)!;
    const operation = operationRows(copiedLeaf, copiedLeaf.uuid, fixtureId);
    await writeFile(fixturePath, `${[...copied, ...operation].map((entry) => JSON.stringify(entry)).join("\n")}\n`);

    process.env["CLAUDE_CODE_SESSION_ID"] = fixtureId;
    process.env["CLAUDE_PROJECT_DIR"] = projectCwd;
    process.env["CONDENSE_DATA_HOME"] = dataRoot;
    const adapter = new ClaudeCodeAdapter();
    const analysis = await analyzeCurrentSession(adapter, DEFAULT_CONFIG);
    const prepared = await prepareBuild(adapter, { receipt: analysis.receipt, keep: [], drop: [] });
    const built = await runBuild(adapter, { plan: prepared.plan });
    childPath = built.transcriptPath;

    const childEntries = await entries(childPath);
    const childRows = selectActiveTranscriptRows(childEntries.filter(isTranscriptRow));
    if (JSON.stringify(signedThinking(childRows)) !== JSON.stringify(signedThinking(copiedRows)))
      throw new Error("Kept thinking blocks changed during the real-session smoke build");
    for (const text of prose(copiedRows))
      if (!prose(childRows).includes(text))
        throw new Error("Verbatim prose was lost during the real-session smoke build");
    const customTitle = childEntries.find((entry) => entry["type"] === "custom-title")?.["customTitle"];
    const agentName = childEntries.find((entry) => entry["type"] === "agent-name")?.["agentName"];
    if (typeof customTitle !== "string" || customTitle !== agentName)
      throw new Error("Title and banner metadata do not agree");
    if (childRows.at(-1)?.["condenseMarker"] !== true)
      throw new Error("Closing marker is not the resolved active leaf");
    const manifest = await loadManifest(built.sessionId);
    if (!manifest?.contentIds.length) throw new Error("Smoke source produced no omission object to retrieve");
    if (!(await readOmittedContent(manifest.contentIds[0]!, { config: DEFAULT_CONFIG })))
      throw new Error("Published omission object could not be retrieved");

    const executable = process.env["CONDENSE_SMOKE_CLAUDE_BIN"] || "claude";
    const processResult = Bun.spawn(
      [executable, "-p", "--resume", built.sessionId, "Reply exactly CONDENSE_SMOKE_OK and nothing else."],
      { cwd: projectCwd, stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      processResult.exited,
      new Response(processResult.stdout).text(),
      new Response(processResult.stderr).text(),
    ]);
    if (exitCode !== 0 || !stdout.includes("CONDENSE_SMOKE_OK"))
      throw new Error(`Authenticated resume failed (${exitCode}): ${stderr || stdout}`);
    console.log(`resume smoke passed for disposable child ${built.sessionId}`);
  } finally {
    await rm(fixturePath, { force: true });
    if (childPath) await rm(childPath, { force: true });
    await rm(dataRoot, { recursive: true, force: true });
    if (previous.session === undefined) delete process.env["CLAUDE_CODE_SESSION_ID"];
    else process.env["CLAUDE_CODE_SESSION_ID"] = previous.session;
    if (previous.project === undefined) delete process.env["CLAUDE_PROJECT_DIR"];
    else process.env["CLAUDE_PROJECT_DIR"] = previous.project;
    if (previous.data === undefined) delete process.env["CONDENSE_DATA_HOME"];
    else process.env["CONDENSE_DATA_HOME"] = previous.data;
  }
}

await main();
