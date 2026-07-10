import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runAnalyze } from "../src/analyze";
import { runBuild } from "../src/build";
import { DEFAULT_CONFIG } from "../src/config";
import { loadManifest, searchOmittedContent } from "../src/omission";
import { findCondenseOperationBoundary, isRecord, readActiveTranscriptRows, readTranscriptRows, type JsonRecord } from "../src/transcript";

const projectDir = join(homedir(), ".claude", "projects", `-condense-integration-${randomUUID()}`);
const dataDirPromise = mkdtemp("/tmp/condense-integration-data-");
const createdSessions = new Set<string>();
let tick = Date.now() - 100000;
const timestamp = () => new Date(tick += 1000).toISOString();

function messageRow(sessionId: string, type: "user" | "assistant" | "system", parentUuid: string | null, content: unknown, extra: JsonRecord = {}): JsonRecord {
  return {
    type, uuid: randomUUID(), parentUuid, sessionId, timestamp: timestamp(), cwd: "/tmp/condense-integration-project",
    message: { role: type === "assistant" ? "assistant" : "user", content, ...(type === "assistant" ? { id: `msg_${randomUUID()}`, model: "claude-test" } : {}) },
    ...extra,
  };
}

function operationRows(sessionId: string, parentUuid: string): JsonRecord[] {
  const op = messageRow(sessionId, "user", parentUuid, "/condense");
  const skill = messageRow(sessionId, "user", op.uuid as string, [{ type: "text", text: "Base directory for this skill: /tmp/plugin/skills/condense" }], { isMeta: true });
  const call = messageRow(sessionId, "assistant", skill.uuid as string, [{ type: "tool_use", id: `toolu_${randomUUID()}`, name: "Bash", input: { command: "bun /tmp/plugin/condense/src/condense.ts analyze" } }]);
  return [op, skill, call];
}

async function writeRows(path: string, rows: JsonRecord[]): Promise<void> { await Bun.write(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`); }
async function rawRows(path: string): Promise<JsonRecord[]> { return (await readFile(path, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)); }

async function analyzeAndBuild(path: string) {
  const rows = await readActiveTranscriptRows(path); const boundary = findCondenseOperationBoundary(rows);
  const config = { ...DEFAULT_CONFIG, keepTurns: 1, policies: { ...DEFAULT_CONFIG.policies }, retrieval: { ...DEFAULT_CONFIG.retrieval } };
  const sessionId = path.split("/").at(-1)!.replace(/\.jsonl$/, "");
  const analysis = runAnalyze(rows, config, { sessionId, cutoffUuid: boundary.cutoffUuid });
  const result = await runBuild(path, { receipt: analysis.receipt, keep: [], drop: [] });
  createdSessions.add(result.sessionId); return result;
}

async function appendGeneration(path: string, keyword: string): Promise<void> {
  const rows = await rawRows(path); const marker = [...rows].reverse().find((row) => row["condenseMarker"] === true)!;
  const sessionId = String(marker["sessionId"]); const dataUser = messageRow(sessionId, "user", marker["uuid"] as string, `generate ${keyword}`);
  const use = messageRow(sessionId, "assistant", dataUser.uuid as string, [{ type: "tool_use", id: `toolu_${keyword}`, name: "Bash", input: { command: `emit ${keyword}` } }]);
  const result = messageRow(sessionId, "user", use.uuid as string, [{ type: "tool_result", tool_use_id: `toolu_${keyword}`, content: `${keyword}\n${"x".repeat(1300)}` }]);
  const close = messageRow(sessionId, "assistant", result.uuid as string, [{ type: "text", text: `recorded ${keyword}` }]);
  const finalUser = messageRow(sessionId, "user", close.uuid as string, `continue after ${keyword}`);
  const finalAssistant = messageRow(sessionId, "assistant", finalUser.uuid as string, [{ type: "text", text: `ready after ${keyword}` }]);
  rows.push(dataUser, use, result, close, finalUser, finalAssistant, ...operationRows(sessionId, finalAssistant.uuid as string));
  await writeRows(path, rows);
}

afterAll(async () => {
  for (const sessionId of createdSessions) await rm(join(projectDir, `${sessionId}.jsonl`), { force: true });
  await rm(projectDir, { recursive: true, force: true });
  await rm(await dataDirPromise, { recursive: true, force: true });
  delete process.env["CONDENSE_DATA_HOME"];
});

describe("real SDK fork integration", () => {
  test("preserves signatures/prose and carries searchable lineage through three generations", async () => {
    process.env["CONDENSE_DATA_HOME"] = await dataDirPromise; await mkdir(projectDir, { recursive: true });
    const sourceId = randomUUID(); createdSessions.add(sourceId); const sourcePath = join(projectDir, `${sourceId}.jsonl`);
    const u1 = messageRow(sourceId, "user", null, "synthetic first prompt");
    const a1 = messageRow(sourceId, "assistant", u1.uuid as string, [{ type: "tool_use", id: "toolu_generation1", name: "Bash", input: { command: "emit generation-one-keyword" } }]);
    const r1 = messageRow(sourceId, "user", a1.uuid as string, [{ type: "tool_result", tool_use_id: "toolu_generation1", content: `generation-one-keyword\n${"a".repeat(1300)}` }]);
    const signed = messageRow(sourceId, "assistant", r1.uuid as string, [{ type: "thinking", thinking: "", signature: "synthetic-signed-thinking" }, { type: "text", text: "synthetic durable prose" }]);
    const u2 = messageRow(sourceId, "user", signed.uuid as string, "synthetic recent prompt");
    const a2 = messageRow(sourceId, "assistant", u2.uuid as string, [{ type: "text", text: "synthetic recent answer" }]);
    await writeRows(sourcePath, [u1, a1, r1, signed, u2, a2, ...operationRows(sourceId, a2.uuid as string)]);

    const first = await analyzeAndBuild(sourcePath);
    const firstRows = await readTranscriptRows(first.transcriptPath);
    expect(JSON.stringify(firstRows)).toContain("synthetic-signed-thinking"); expect(JSON.stringify(firstRows)).toContain("synthetic durable prose");
    expect(firstRows.at(-1)?.["condenseMarker"]).toBe(true);
    expect(String(firstRows.at(-1)?.message?.["content"])).toContain("THINKING inline: t0 “synthetic first prompt”");
    for (const row of firstRows) if (row.parentUuid) expect(firstRows.some((candidate) => candidate.uuid === row.parentUuid)).toBe(true);

    await appendGeneration(first.transcriptPath, "generation-two-keyword"); const second = await analyzeAndBuild(first.transcriptPath);
    await appendGeneration(second.transcriptPath, "generation-three-keyword"); const third = await analyzeAndBuild(second.transcriptPath);
    expect(third.generation).toBe(3);
    const manifest = await loadManifest(third.sessionId); expect(manifest?.contentIds.length).toBeGreaterThanOrEqual(3);
    for (const keyword of ["generation-one-keyword", "generation-two-keyword", "generation-three-keyword"]) {
      const found = await searchOmittedContent({ query: keyword, config: DEFAULT_CONFIG, sessionId: third.sessionId });
      expect(found.matches.length).toBeGreaterThan(0);
    }
    const raw = await rawRows(third.transcriptPath);
    expect(raw.some((entry) => entry["type"] === "custom-title" && entry["condenseGeneration"] === 3)).toBe(true);
    expect(raw.some((entry) => entry["type"] === "agent-name")).toBe(true);
  }, 120000);
});
