import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import type { ForkedSession, HostAdapter, SessionIdentity, SessionSnapshot } from "../src/host";
import { sha256 } from "../src/protocol";
import { analyzeCurrentSession, inspectAnalysis, prepareBuild } from "../src/workflow";
import type { JsonRecord, TranscriptRow } from "../src/transcript";

let root = "";
let snapshot: SessionSnapshot;
let forkCalls = 0;

class FakeAdapter implements HostAdapter {
  readonly host = "claude-code" as const;
  locateCurrentSession(): SessionIdentity { return snapshot.identity; }
  async snapshot(): Promise<SessionSnapshot> { return structuredClone(snapshot); }
  async fork(): Promise<ForkedSession> { forkCalls++; throw new Error("prepare must not fork"); }
  async cleanupFork(): Promise<void> {}
}

function row(type: "user" | "assistant", parentUuid: string | null, content: unknown): TranscriptRow {
  return {
    type,
    uuid: randomUUID(),
    parentUuid,
    sessionId: "00000000-0000-0000-0000-000000000001",
    timestamp: new Date().toISOString(),
    message: { role: type, content },
  } as TranscriptRow;
}

beforeEach(async () => {
  root = await mkdtemp("/tmp/condense-workflow-");
  process.env["CONDENSE_DATA_HOME"] = join(root, "data");
  process.env["CLAUDE_CODE_SESSION_ID"] = "00000000-0000-0000-0000-000000000001";
  const firstUser = row("user", null, "old work");
  const uses = Array.from({ length: 45 }, (_, index) => ({ type: "tool_use", id: `tool-${index}`, name: "Bash", input: { command: `command ${index}` } }));
  const assistant = row("assistant", firstUser.uuid, uses);
  const results = row("user", assistant.uuid, uses.map((_, index) => ({ type: "tool_result", tool_use_id: `tool-${index}`, content: `result ${index} ${"x".repeat(1200)}` })));
  const thinking = row("assistant", results.uuid, [{ type: "thinking", thinking: "reasoning", signature: "signed" }, { type: "text", text: "done" }]);
  const recentUser = row("user", thinking.uuid, "recent work");
  const recentAssistant = row("assistant", recentUser.uuid, [{ type: "text", text: "ready" }]);
  const entries = [firstUser, assistant, results, thinking, recentUser, recentAssistant];
  const transcriptPath = join(root, "00000000-0000-0000-0000-000000000001.jsonl");
  await Bun.write(transcriptPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  snapshot = {
    identity: { host: "claude-code", sessionId: firstUser.sessionId, transcriptPath, projectCwd: root },
    cutoffUuid: recentAssistant.uuid,
    operationUserUuid: randomUUID(),
    storageEntries: entries as JsonRecord[],
    contextEntries: entries,
    storageDigest: sha256(entries),
    contextDigest: sha256(entries),
  };
  forkCalls = 0;
});

afterEach(async () => {
  delete process.env["CONDENSE_DATA_HOME"];
  delete process.env["CLAUDE_CODE_SESSION_ID"];
  await rm(root, { recursive: true, force: true });
});

test("analyze and inspect paginate within the configured budget", async () => {
  const adapter = new FakeAdapter();
  const config = { ...DEFAULT_CONFIG, analysis: { maxPageChars: 4000 }, policies: { ...DEFAULT_CONFIG.policies }, retrieval: { ...DEFAULT_CONFIG.retrieval } };
  const first = await analyzeCurrentSession(adapter, config);
  expect(JSON.stringify(first).length).toBeLessThanOrEqual(4000);
  expect(first).not.toHaveProperty("projection");
  expect(first.more).toBeDefined();
  const second = await inspectAnalysis(adapter, { receipt: first.receipt, cursor: first.more!.cursor });
  expect(JSON.stringify(second).length).toBeLessThanOrEqual(4000);
  const firstRefs = new Set([...first.reviewToKeep, ...first.reviewToDrop].map((candidate) => String(candidate[0])));
  const secondRefs = [...second.reviewToKeep, ...second.reviewToDrop].map((candidate) => String(candidate[0]));
  expect(secondRefs.some((ref) => firstRefs.has(ref))).toBe(false);
  const detail = await inspectAnalysis(adapter, { receipt: first.receipt, refs: [String(first.reviewToKeep[0]![0])] });
  expect(JSON.stringify(detail).length).toBeLessThanOrEqual(4000);
});

test("prepare freezes a non-mutating plan and reports complete thinking size", async () => {
  const adapter = new FakeAdapter();
  const config = { ...DEFAULT_CONFIG, policies: { ...DEFAULT_CONFIG.policies, thinking: "drop-all" as const }, analysis: { ...DEFAULT_CONFIG.analysis }, retrieval: { ...DEFAULT_CONFIG.retrieval } };
  const analysis = await analyzeCurrentSession(adapter, config);
  const prepared = await prepareBuild(adapter, { receipt: analysis.receipt });
  expect(prepared.plan).toMatch(/^bp_/);
  expect(prepared.thinking.dropped).toBe(1);
  expect(prepared.warnings[0]).toContain("unrecoverable");
  expect(prepared.impactChars.source).toBeGreaterThan(prepared.impactChars.projected);
  expect(forkCalls).toBe(0);
});
