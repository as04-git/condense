import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ClaudeCodeAdapter, encodeClaudeProjectPath } from "../src/claude-adapter";
import { runBuild } from "../src/build";
import { DEFAULT_CONFIG } from "../src/config";
import { loadManifest, searchOmittedContent } from "../src/omission";
import { isRecord, readTranscriptRows, type JsonRecord } from "../src/transcript";
import { analyzeCurrentSession, prepareBuild } from "../src/workflow";

const unique = randomUUID();
const projectCwdPromise = mkdtemp(join(homedir(), `.condense-integration-${unique}-`));
const dataDirPromise = mkdtemp(join(tmpdir(), "condense-integration-data-"));
const createdSessions = new Set<string>();
const adapter = new ClaudeCodeAdapter();
let projectCwd = "";
let projectDir = "";
let tick = Date.now() - 100000;
const timestamp = () => new Date((tick += 1000)).toISOString();

function messageRow(
  sessionId: string,
  type: "user" | "assistant" | "system",
  parentUuid: string | null,
  content: unknown,
  extra: JsonRecord = {},
): JsonRecord {
  return {
    type,
    uuid: randomUUID(),
    parentUuid,
    sessionId,
    timestamp: timestamp(),
    cwd: projectCwd,
    message: {
      role: type === "assistant" ? "assistant" : "user",
      content,
      ...(type === "assistant" ? { id: `msg_${randomUUID()}`, model: "claude-test" } : {}),
    },
    ...extra,
  };
}

function operationRows(sessionId: string, parentUuid: string): JsonRecord[] {
  const operation = messageRow(sessionId, "user", parentUuid, "/condense");
  const skill = messageRow(
    sessionId,
    "user",
    operation["uuid"] as string,
    [{ type: "text", text: "Base directory for this skill: /tmp/plugin/skills/condense" }],
    { isMeta: true },
  );
  const call = messageRow(sessionId, "assistant", skill["uuid"] as string, [
    {
      type: "tool_use",
      id: `toolu_${randomUUID()}`,
      name: "Bash",
      input: { command: 'bun "/plugin/src/bootstrap.ts" condense "/data" analyze' },
    },
  ]);
  return [operation, skill, call];
}

async function writeRows(path: string, rows: JsonRecord[]): Promise<void> {
  await Bun.write(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

async function rawRows(path: string): Promise<JsonRecord[]> {
  return (await readFile(path, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function analyzePrepareBuild(path: string) {
  const sessionId = basename(path).replace(/\.jsonl$/, "");
  process.env["CLAUDE_CODE_SESSION_ID"] = sessionId;
  process.env["CLAUDE_PROJECT_DIR"] = projectCwd;
  const config = {
    ...DEFAULT_CONFIG,
    keepTurns: 1,
    policies: { ...DEFAULT_CONFIG.policies },
    analysis: { ...DEFAULT_CONFIG.analysis },
    retrieval: { ...DEFAULT_CONFIG.retrieval },
  };
  const analysis = await analyzeCurrentSession(adapter, config);
  expect(JSON.stringify(analysis).length).toBeLessThanOrEqual(config.analysis.maxPageChars);
  expect(analysis).not.toHaveProperty("projection");
  const prepared = await prepareBuild(adapter, { receipt: analysis.receipt, keep: [], drop: [] });
  const result = await runBuild(adapter, { plan: prepared.plan });
  expect(result.finalChars).toBe(prepared.impactChars.projected);
  createdSessions.add(result.sessionId);
  return result;
}

async function appendGeneration(path: string, keyword: string): Promise<void> {
  const rows = await rawRows(path);
  const marker = [...rows].reverse().find((row) => row["condenseMarker"] === true)!;
  const sessionId = String(marker["sessionId"]);
  const user = messageRow(sessionId, "user", marker["uuid"] as string, `generate ${keyword}`);
  const use = messageRow(sessionId, "assistant", user["uuid"] as string, [
    { type: "tool_use", id: `toolu_${keyword}`, name: "Bash", input: { command: `emit ${keyword}` } },
  ]);
  const result = messageRow(sessionId, "user", use["uuid"] as string, [
    { type: "tool_result", tool_use_id: `toolu_${keyword}`, content: `${keyword}\n${"x".repeat(1300)}` },
  ]);
  const close = messageRow(sessionId, "assistant", result["uuid"] as string, [
    { type: "text", text: `recorded ${keyword}` },
  ]);
  const finalUser = messageRow(sessionId, "user", close["uuid"] as string, `continue after ${keyword}`);
  const finalAssistant = messageRow(sessionId, "assistant", finalUser["uuid"] as string, [
    { type: "text", text: `ready after ${keyword}` },
  ]);
  rows.push(
    user,
    use,
    result,
    close,
    finalUser,
    finalAssistant,
    ...operationRows(sessionId, finalAssistant["uuid"] as string),
  );
  await writeRows(path, rows);
}

afterAll(async () => {
  for (const sessionId of createdSessions) await rm(join(projectDir, `${sessionId}.jsonl`), { force: true });
  await rm(projectDir, { recursive: true, force: true });
  await rm(await projectCwdPromise, { recursive: true, force: true });
  await rm(await dataDirPromise, { recursive: true, force: true });
  delete process.env["CONDENSE_DATA_HOME"];
  delete process.env["CLAUDE_CODE_SESSION_ID"];
  delete process.env["CLAUDE_PROJECT_DIR"];
});

describe("v0.3.2 SDK workflow", () => {
  test("preserves opaque entries and inactive branches while carrying searchable lineage", async () => {
    process.env["CONDENSE_DATA_HOME"] = await dataDirPromise;
    projectCwd = await projectCwdPromise;
    projectDir = join(homedir(), ".claude", "projects", encodeClaudeProjectPath(projectCwd));
    await mkdir(projectDir, { recursive: true });
    const sourceId = randomUUID();
    createdSessions.add(sourceId);
    const sourcePath = join(projectDir, `${sourceId}.jsonl`);
    const preBoundary = messageRow(sourceId, "user", null, "pre-boundary history");
    const compactBoundary = messageRow(
      sourceId,
      "system",
      preBoundary["uuid"] as string,
      [{ type: "text", text: "synthetic compact boundary" }],
      { condense: { boundary: true } },
    );
    const firstUser = messageRow(sourceId, "user", compactBoundary["uuid"] as string, "synthetic first prompt", {
      futureMetadata: { sentinel: "unknown-metadata-preserved" },
    });
    const firstUse = messageRow(sourceId, "assistant", firstUser["uuid"] as string, [
      { type: "tool_use", id: "toolu_generation1", name: "Bash", input: { command: "emit generation-one-keyword" } },
    ]);
    const firstResult = messageRow(sourceId, "user", firstUse["uuid"] as string, [
      { type: "tool_result", tool_use_id: "toolu_generation1", content: `generation-one-keyword\n${"a".repeat(1300)}` },
    ]);
    const signed = messageRow(sourceId, "assistant", firstResult["uuid"] as string, [
      { type: "thinking", thinking: "synthetic reasoning", signature: "synthetic-signed-thinking" },
      { type: "text", text: "synthetic durable prose" },
    ]);
    const inactive = messageRow(sourceId, "assistant", signed["uuid"] as string, [
      { type: "text", text: `INACTIVE-${"z".repeat(12000)}` },
    ]);
    const recentUser = messageRow(sourceId, "user", signed["uuid"] as string, "synthetic recent prompt");
    const recentAssistant = messageRow(sourceId, "assistant", recentUser["uuid"] as string, [
      { type: "text", text: "synthetic recent answer" },
    ]);
    const opaque = {
      type: "content-replacement",
      sessionId: sourceId,
      replacements: [{ sentinel: "preserved" }],
      uuid: randomUUID(),
      timestamp: timestamp(),
    };
    const relocated = { type: "relocated", sessionId: sourceId, relocatedCwd: projectCwd };
    await writeRows(sourcePath, [
      preBoundary,
      compactBoundary,
      firstUser,
      firstUse,
      firstResult,
      signed,
      inactive,
      recentUser,
      recentAssistant,
      ...operationRows(sourceId, recentAssistant["uuid"] as string),
      opaque,
      relocated,
    ]);

    const first = await analyzePrepareBuild(sourcePath);
    const firstRaw = await rawRows(first.transcriptPath);
    expect(
      firstRaw.some((row) => row["type"] === "content-replacement" && JSON.stringify(row).includes("preserved")),
    ).toBe(true);
    expect(firstRaw.some((row) => row["type"] === "relocated")).toBe(true);
    expect(firstRaw.some((row) => isRecord(row["condense"]) && row["condense"]["boundary"] === true)).toBe(true);
    expect(JSON.stringify(firstRaw)).toContain("unknown-metadata-preserved");
    expect(JSON.stringify(firstRaw)).toContain("INACTIVE-");
    expect(first.sourceChars).toBeLessThan(12000);
    const firstRows = await readTranscriptRows(first.transcriptPath);
    const sourceThinking = (signed["message"] as JsonRecord)["content"] as JsonRecord[];
    const builtThinking = firstRows
      .flatMap((row) => (isRecord(row.message) && Array.isArray(row.message["content"]) ? row.message["content"] : []))
      .find((block) => isRecord(block) && block["type"] === "thinking");
    expect(builtThinking).toEqual(sourceThinking[0]);
    expect(JSON.stringify(firstRows)).toContain("synthetic durable prose");
    expect(firstRows.at(-1)?.["condenseMarker"]).toBe(true);
    for (const row of firstRows)
      if (row.parentUuid) expect(firstRows.some((candidate) => candidate.uuid === row.parentUuid)).toBe(true);

    await appendGeneration(first.transcriptPath, "generation-two-keyword");
    const second = await analyzePrepareBuild(first.transcriptPath);
    await appendGeneration(second.transcriptPath, "generation-three-keyword");
    const third = await analyzePrepareBuild(second.transcriptPath);
    expect(third.generation).toBe(3);
    const manifest = await loadManifest(third.sessionId);
    expect(manifest?.contentIds.length).toBeGreaterThanOrEqual(3);
    for (const keyword of ["generation-one-keyword", "generation-two-keyword", "generation-three-keyword"]) {
      const found = await searchOmittedContent({ query: keyword, config: DEFAULT_CONFIG, sessionId: third.sessionId });
      expect(found.matches.length).toBeGreaterThan(0);
    }
    const raw = await rawRows(third.transcriptPath);
    expect(raw.some((entry) => entry["type"] === "custom-title" && entry["condenseGeneration"] === 3)).toBe(true);
    expect(raw.some((entry) => entry["type"] === "agent-name")).toBe(true);
    expect(raw.filter((entry) => entry["condenseMarker"] === true)).toHaveLength(1);
    expect(
      raw.every((entry) => !isRecord(entry["message"]) || !JSON.stringify(entry["message"]).includes("approxTokens")),
    ).toBe(true);
  }, 120000);
});
