import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { runBuild } from "../src/build";
import { DEFAULT_CONFIG, type RetentionMode } from "../src/config";
import type { ForkedSession, HostAdapter, SessionIdentity, SessionPresentation, SessionSnapshot } from "../src/host";
import { sha256 } from "../src/protocol";
import { loadAnalysisRecord, loadPreparedRecord, withPlanLock } from "../src/state";
import { analyzeCurrentSession, inspectAnalysis, prepareBuild } from "../src/workflow";
import { isTranscriptRow, writeTranscriptEntries, type JsonRecord, type TranscriptRow } from "../src/transcript";
import { testTmpdir } from "./temp";

let root = "";
let snapshot: SessionSnapshot;
let forkCalls = 0;

class FakeAdapter implements HostAdapter {
  readonly host = "claude-code" as const;
  locateCurrentSession(): SessionIdentity {
    return snapshot.identity;
  }
  async snapshot(): Promise<SessionSnapshot> {
    return structuredClone(snapshot);
  }
  async preparePresentation(_snapshot: SessionSnapshot, titleOverride?: string): Promise<SessionPresentation> {
    return { generation: 1, title: `🗜 condense #1 — ${titleOverride || "test"}` };
  }
  async fork(_source: SessionSnapshot, _title: string): Promise<ForkedSession> {
    forkCalls++;
    throw new Error("prepare must not fork");
  }
  async cleanupFork(_fork: ForkedSession): Promise<void> {}
  async publish(_fork: ForkedSession, _storageEntries: JsonRecord[]): Promise<void> {
    throw new Error("prepare must not publish");
  }
  titleEntries(fork: ForkedSession, presentation: SessionPresentation): JsonRecord[] {
    return [
      {
        type: "custom-title",
        customTitle: presentation.title,
        condenseGeneration: presentation.generation,
        sessionId: fork.sessionId,
      },
      { type: "agent-name", agentName: presentation.title, sessionId: fork.sessionId },
    ];
  }
  markerEntry(fork: ForkedSession, parentUuid: string, text: string): TranscriptRow {
    const latest = Math.max(...fork.messageRows.map((entry) => Date.parse(entry.timestamp) || 0));
    return {
      type: "user",
      uuid: randomUUID(),
      parentUuid,
      sessionId: fork.sessionId,
      condenseMarker: true,
      timestamp: new Date(latest + 1000).toISOString(),
      message: { role: "user", content: text },
    } as TranscriptRow;
  }
  resumeCommand(sessionId: string): string {
    return `/resume ${sessionId}`;
  }
}

class BuildAdapter extends FakeAdapter {
  readonly forks: string[] = [];
  readonly cleaned: string[] = [];

  override async fork(source: SessionSnapshot, _title: string): Promise<ForkedSession> {
    forkCalls++;
    const sessionId = randomUUID();
    const transcriptPath = join(root, `${sessionId}.jsonl`);
    const oldToNew = new Map<string, string>();
    for (const entry of source.storageEntries) if (isTranscriptRow(entry)) oldToNew.set(entry.uuid, randomUUID());
    const storageEntries = source.storageEntries.map((entry) => {
      if (!isTranscriptRow(entry)) return structuredClone(entry);
      const uuid = oldToNew.get(entry.uuid)!;
      return {
        ...structuredClone(entry),
        uuid,
        parentUuid: entry.parentUuid ? (oldToNew.get(entry.parentUuid) ?? null) : null,
        sessionId,
        forkedFrom: { sessionId: source.identity.sessionId, messageUuid: entry.uuid },
      } as TranscriptRow;
    });
    await writeFile(transcriptPath, `${storageEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    this.forks.push(transcriptPath);
    return {
      sessionId,
      transcriptPath,
      storageEntries,
      // Real SDK forks may reorder parallel message rows. Build correctness
      // must depend on ref identity, not serialization order.
      messageRows: storageEntries.filter(isTranscriptRow).reverse(),
      oldToNew,
    };
  }

  override async cleanupFork(fork: ForkedSession): Promise<void> {
    this.cleaned.push(fork.transcriptPath);
    await rm(fork.transcriptPath, { force: true });
  }

  override async publish(fork: ForkedSession, storageEntries: JsonRecord[]): Promise<void> {
    await writeTranscriptEntries(fork.transcriptPath, storageEntries);
  }
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
  root = await mkdtemp(join(testTmpdir(), "condense-workflow-"));
  process.env["CONDENSE_DATA_HOME"] = join(root, "data");
  process.env["CLAUDE_CODE_SESSION_ID"] = "00000000-0000-0000-0000-000000000001";
  const firstUser = row("user", null, "old work");
  const uses = Array.from({ length: 45 }, (_, index) => ({
    type: "tool_use",
    id: `tool-${index}`,
    name: "Bash",
    input: { command: `command ${index}` },
  }));
  const assistant = row("assistant", firstUser.uuid, uses);
  const results = row(
    "user",
    assistant.uuid,
    uses.map((_, index) => ({
      type: "tool_result",
      tool_use_id: `tool-${index}`,
      content: `result ${index} ${"x".repeat(1200)}`,
    })),
  );
  const thinking = row("assistant", results.uuid, [
    { type: "thinking", thinking: "reasoning", signature: "signed" },
    { type: "text", text: "done" },
  ]);
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
  const config = {
    ...DEFAULT_CONFIG,
    analysis: { maxPageChars: 4000 },
    policies: { ...DEFAULT_CONFIG.policies },
    retrieval: { ...DEFAULT_CONFIG.retrieval },
  };
  const first = await analyzeCurrentSession(adapter, config);
  expect(JSON.stringify(first).length).toBeLessThanOrEqual(4000);
  expect(first).not.toHaveProperty("projection");
  expect(first.more).toBeDefined();
  const seen = new Set([...first.reviewToKeep, ...first.reviewToDrop].map((candidate) => String(candidate[0])));
  let cursor = first.more?.cursor;
  while (cursor) {
    const page = await inspectAnalysis(adapter, { receipt: first.receipt, cursor });
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(4000);
    for (const candidate of [...page.reviewToKeep, ...page.reviewToDrop]) {
      const ref = String(candidate[0]);
      expect(seen.has(ref)).toBe(false);
      seen.add(ref);
    }
    cursor = page.more?.cursor;
  }
  const stored = await loadAnalysisRecord(first.receipt);
  expect(seen.size).toBe(stored.candidates.filter((candidate) => candidate.action !== "none").length);
  if (process.platform !== "win32" && ((await stat(root)).mode & 0o777) !== 0o777) {
    expect((await stat(join(root, "data", "pending"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "data", "pending", `${first.receipt}.json`))).mode & 0o777).toBe(0o600);
  }
  const detail = await inspectAnalysis(adapter, { receipt: first.receipt, refs: [String(first.reviewToKeep[0]![0])] });
  expect(JSON.stringify(detail).length).toBeLessThanOrEqual(4000);
});

test("prepare freezes a non-mutating plan and reports complete thinking size", async () => {
  const adapter = new FakeAdapter();
  const config = {
    ...DEFAULT_CONFIG,
    policies: { ...DEFAULT_CONFIG.policies, thinking: "drop-all" as const },
    analysis: { ...DEFAULT_CONFIG.analysis },
    retrieval: { ...DEFAULT_CONFIG.retrieval },
  };
  const analysis = await analyzeCurrentSession(adapter, config);
  const prepared = await prepareBuild(adapter, { receipt: analysis.receipt });
  expect(prepared.plan).toMatch(/^bp_/);
  expect(prepared.thinking.dropped).toBe(1);
  expect(prepared.warnings[0]).toContain("unrecoverable");
  expect(prepared.impactChars.source).toBeGreaterThan(prepared.impactChars.projected);
  expect(forkCalls).toBe(0);
});

test("prepare is repeatable and pending records reject drift, expiry, and unsupported versions", async () => {
  const adapter = new FakeAdapter();
  const analysis = await analyzeCurrentSession(adapter, DEFAULT_CONFIG);
  const first = await prepareBuild(adapter, { receipt: analysis.receipt, keep: [] });
  const second = await prepareBuild(adapter, { receipt: analysis.receipt, keep: [] });
  expect(first.plan).not.toBe(second.plan);
  expect((await loadPreparedRecord(first.plan)).analysisHandle).toBe(analysis.receipt);

  snapshot.contextDigest = sha256("drifted");
  await expect(
    inspectAnalysis(adapter, { receipt: analysis.receipt, refs: [String(analysis.reviewToKeep[0]![0])] }),
  ).rejects.toThrow("Active context changed");
  snapshot.contextDigest = sha256(snapshot.contextEntries);

  snapshot.storageDigest = sha256("storage drift");
  await expect(
    inspectAnalysis(adapter, { receipt: analysis.receipt, refs: [String(analysis.reviewToKeep[0]![0])] }),
  ).rejects.toThrow("SDK fork-source prefix changed");
  snapshot.storageDigest = sha256(snapshot.storageEntries);

  const pending = join(root, "data", "pending", `${first.plan}.json`);
  const expired = JSON.parse(await readFile(pending, "utf8"));
  expired.createdAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  await writeFile(pending, JSON.stringify(expired));
  await expect(loadPreparedRecord(first.plan)).rejects.toThrow("expired");

  const analysisPath = join(root, "data", "pending", `${analysis.receipt}.json`);
  const unsupported = JSON.parse(await readFile(analysisPath, "utf8"));
  unsupported.version = 999;
  await writeFile(analysisPath, JSON.stringify(unsupported));
  await expect(loadAnalysisRecord(analysis.receipt)).rejects.toThrow("rerun analyze");
});

test("plan locks are exclusive, recover abandoned owners, and successful builds consume both handles", async () => {
  const adapter = new BuildAdapter();
  const analysis = await analyzeCurrentSession(adapter, DEFAULT_CONFIG);
  const prepared = await prepareBuild(adapter, { receipt: analysis.receipt, keep: [] });
  let release!: () => void;
  let acquired!: () => void;
  const lockAcquired = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const held = withPlanLock(
    prepared.plan,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
        acquired();
      }),
  );
  await lockAcquired;
  await expect(withPlanLock(prepared.plan, async () => undefined)).rejects.toThrow("already being built");
  release();
  await held;

  const lockPath = join(root, "data", "pending", `${prepared.plan}.json.lock`);
  await writeFile(
    lockPath,
    JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      hostname: hostname(),
      token: "abandoned",
      createdAt: new Date().toISOString(),
    }),
  );
  let recovered = false;
  await withPlanLock(prepared.plan, async () => {
    recovered = true;
  });
  expect(recovered).toBe(true);
  expect(await Bun.file(lockPath).exists()).toBe(false);

  const result = await runBuild(adapter, { plan: prepared.plan });
  expect(result.finalChars).toBe(prepared.impactChars.projected);
  await expect(loadPreparedRecord(prepared.plan)).rejects.toThrow("not found");
  await expect(loadAnalysisRecord(analysis.receipt)).rejects.toThrow("not found");
});

test("prepared projections equal built active context across every policy mode and mixed decisions", async () => {
  const modes: RetentionMode[] = ["keep-all", "keep-ranked", "drop-ranked", "drop-all"];
  for (const [index, mode] of modes.entries()) {
    const adapter = new BuildAdapter();
    const config = {
      ...DEFAULT_CONFIG,
      policies: {
        thinking: modes[(index + 1) % modes.length]!,
        tools: mode,
        agentResults: modes[(index + 2) % modes.length]!,
        skills: modes[(index + 3) % modes.length]!,
        injections: mode,
      },
      analysis: { ...DEFAULT_CONFIG.analysis },
      retrieval: { ...DEFAULT_CONFIG.retrieval },
    };
    const analysis = await analyzeCurrentSession(adapter, config);
    const record = await loadAnalysisRecord(analysis.receipt);
    const keep = record.candidates
      .filter((candidate, at) => candidate.action === "keep" && at % 2 === 0)
      .map((c) => c.ref);
    const drop = record.candidates
      .filter((candidate, at) => candidate.action === "drop" && at % 2 === 1)
      .map((c) => c.ref);
    const prepared = await prepareBuild(adapter, { receipt: analysis.receipt, keep, drop });
    const built = await runBuild(adapter, { plan: prepared.plan });
    expect(built.finalChars).toBe(prepared.impactChars.projected);
    expect(built.removedChars).toBe(prepared.impactChars.removed);
  }
});

test("every failed publication stage cleans the SDK fork and retains the prepared plan", async () => {
  const stages = ["objects", "manifest", "transcript"] as const;
  for (const stage of stages) {
    const adapter = new BuildAdapter();
    const analysis = await analyzeCurrentSession(adapter, DEFAULT_CONFIG);
    const prepared = await prepareBuild(adapter, { receipt: analysis.receipt, keep: [] });
    const fail = async () => {
      throw new Error(`${stage} publication failed`);
    };
    await expect(
      runBuild(
        adapter,
        { plan: prepared.plan },
        {
          saveObjects: stage === "objects" ? fail : async () => undefined,
          saveLineageManifest: stage === "manifest" ? fail : async () => undefined,
          publishSession: stage === "transcript" ? fail : async () => undefined,
        },
      ),
    ).rejects.toThrow(`${stage} publication failed`);
    const forkPath = adapter.forks.at(-1)!;
    expect(adapter.cleaned).toEqual([forkPath]);
    expect(await Bun.file(forkPath).exists()).toBe(false);
    expect((await loadPreparedRecord(prepared.plan)).handle).toBe(prepared.plan);
    expect((await loadAnalysisRecord(analysis.receipt)).handle).toBe(analysis.receipt);
  }
});
