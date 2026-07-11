import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readdir, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import type { Attachment, AnalyzeInternal } from "./analyze";
import type { CondenseConfig } from "./config";
import type { DecisionInput, SessionIdentity, TokenProjection } from "./host";
import type { PlannedMutation } from "./planner";
import type { CandidateManifestItem } from "./protocol";
import { durableRename } from "./durable";
import { isRecord, type JsonRecord } from "./transcript";

const RECORD_VERSION = 1;
const TTL_MS = 24 * 60 * 60 * 1000;

type LockRecord = {
  version: 1;
  pid: number;
  hostname: string;
  token: string;
  createdAt: string;
};

export type StoredSource = {
  identity: SessionIdentity;
  cutoffUuid: string;
  operationUserUuid: string;
  storageDigest: string;
  contextDigest: string;
};

export type AnalysisRecord = {
  version: 1;
  type: "analysis";
  handle: string;
  createdAt: string;
  producer: "condense@0.3.2";
  selectionAlgorithm: "claude-active-context-v1";
  source: StoredSource;
  config: CondenseConfig;
  candidates: CandidateManifestItem[];
  attachments: Attachment[];
  thinking: AnalyzeInternal["rankableThinking"];
  turns: AnalyzeInternal["perTurn"];
  automatic: Array<["inline" | "omit", string, number]>;
};

export type PreparedStats = {
  thinking: { kept: number; dropped: number; droppedTurns: Array<[number, string]> };
  externalized: { toolInputs: number; toolOutputs: number; agentResults: number; skills: number; injections: number };
  inline: { toolInputs: number; toolOutputs: number; agentResults: number; skills: number; injections: number };
  impactChars: { source: number; projected: number; removed: number };
  warnings: string[];
  tokenProjection?: TokenProjection;
};

export type PreparedRecord = {
  version: 1;
  type: "prepared";
  handle: string;
  analysisHandle: string;
  createdAt: string;
  producer: "condense@0.3.2";
  selectionAlgorithm: "claude-active-context-v1";
  source: StoredSource;
  config: CondenseConfig;
  decision: DecisionInput;
  omissions: Record<string, string>;
  generation: number;
  title: string;
  plannedContextDigest: string;
  plannedMutations: PlannedMutation[];
  stats: PreparedStats;
};

export type PendingRecord = AnalysisRecord | PreparedRecord;

function dataRoot(): string {
  return (
    process.env["CONDENSE_DATA_HOME"] ||
    join(process.env["XDG_DATA_HOME"] || join(homedir(), ".local", "share"), "condense")
  );
}

function pendingDir(): string {
  return join(dataRoot(), "pending");
}

function recordPath(handle: string): string {
  return join(pendingDir(), `${handle}.json`);
}

function randomHandle(prefix: "cr" | "bp"): string {
  return `${prefix}_${randomBytes(16).toString("base64url")}`;
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await durableRename(temporary, path);
  await chmod(path, 0o600);
}

function assertSource(value: unknown): asserts value is StoredSource {
  if (
    !isRecord(value) ||
    !isRecord(value["identity"]) ||
    (value["identity"]["host"] !== "claude-code" && value["identity"]["host"] !== "codex") ||
    typeof value["identity"]["sessionId"] !== "string" ||
    typeof value["identity"]["transcriptPath"] !== "string" ||
    typeof value["identity"]["projectCwd"] !== "string" ||
    typeof value["cutoffUuid"] !== "string" ||
    typeof value["operationUserUuid"] !== "string" ||
    typeof value["storageDigest"] !== "string" ||
    typeof value["contextDigest"] !== "string"
  ) {
    throw new Error("Malformed condense pending-record source");
  }
}

function parseRecord(raw: unknown, expected: PendingRecord["type"]): PendingRecord {
  if (
    !isRecord(raw) ||
    raw["version"] !== RECORD_VERSION ||
    raw["type"] !== expected ||
    typeof raw["handle"] !== "string" ||
    typeof raw["createdAt"] !== "string" ||
    raw["producer"] !== "condense@0.3.2" ||
    raw["selectionAlgorithm"] !== "claude-active-context-v1" ||
    (expected === "prepared" &&
      (typeof raw["plannedContextDigest"] !== "string" || !Array.isArray(raw["plannedMutations"])))
  ) {
    throw new Error(
      `Unsupported or malformed ${expected} record; rerun ${expected === "analysis" ? "analyze" : "prepare"}.`,
    );
  }
  assertSource(raw["source"]);
  const created = Date.parse(raw["createdAt"]);
  if (!Number.isFinite(created) || Date.now() - created > TTL_MS) {
    throw new Error(
      `${expected === "analysis" ? "Analysis receipt" : "Prepared plan"} expired; rerun ${expected === "analysis" ? "analyze" : "prepare"}.`,
    );
  }
  return raw as PendingRecord;
}

export async function saveAnalysisRecord(
  input: Omit<AnalysisRecord, "version" | "type" | "handle" | "createdAt" | "producer" | "selectionAlgorithm">,
): Promise<AnalysisRecord> {
  const record: AnalysisRecord = {
    version: 1,
    type: "analysis",
    handle: randomHandle("cr"),
    createdAt: new Date().toISOString(),
    producer: "condense@0.3.2",
    selectionAlgorithm: "claude-active-context-v1",
    ...input,
  };
  await atomicJson(recordPath(record.handle), record);
  await collectExpiredRecords();
  return record;
}

export async function savePreparedRecord(
  input: Omit<PreparedRecord, "version" | "type" | "handle" | "createdAt" | "producer" | "selectionAlgorithm">,
): Promise<PreparedRecord> {
  const record: PreparedRecord = {
    version: 1,
    type: "prepared",
    handle: randomHandle("bp"),
    createdAt: new Date().toISOString(),
    producer: "condense@0.3.2",
    selectionAlgorithm: "claude-active-context-v1",
    ...input,
  };
  await atomicJson(recordPath(record.handle), record);
  return record;
}

export async function loadAnalysisRecord(handle: string): Promise<AnalysisRecord> {
  if (!/^cr_[A-Za-z0-9_-]{22}$/.test(handle)) throw new Error("Invalid analysis receipt; rerun analyze.");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(recordPath(handle), "utf8"));
  } catch {
    throw new Error("Analysis receipt was not found; rerun analyze.");
  }
  return parseRecord(raw, "analysis") as AnalysisRecord;
}

export async function loadPreparedRecord(handle: string): Promise<PreparedRecord> {
  if (!/^bp_[A-Za-z0-9_-]{22}$/.test(handle)) throw new Error("Invalid prepared plan; rerun prepare.");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(recordPath(handle), "utf8"));
  } catch {
    throw new Error("Prepared plan was not found; rerun prepare.");
  }
  return parseRecord(raw, "prepared") as PreparedRecord;
}

export async function removePending(handle: string): Promise<void> {
  await unlink(recordPath(handle)).catch(() => undefined);
}

function parseLockRecord(value: unknown): LockRecord | null {
  if (
    !isRecord(value) ||
    value["version"] !== 1 ||
    !Number.isInteger(value["pid"]) ||
    Number(value["pid"]) < 1 ||
    typeof value["hostname"] !== "string" ||
    typeof value["token"] !== "string" ||
    typeof value["createdAt"] !== "string"
  ) {
    return null;
  }
  return value as LockRecord;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error["code"] === "EPERM";
  }
}

async function reclaimAbandonedLock(path: string): Promise<boolean> {
  let lock: LockRecord | null = null;
  let age = 0;
  try {
    lock = parseLockRecord(JSON.parse(await readFile(path, "utf8")));
    age = Date.now() - (await stat(path)).mtimeMs;
  } catch (error) {
    if (isRecord(error) && error["code"] === "ENOENT") return true;
    try {
      age = Date.now() - (await stat(path)).mtimeMs;
    } catch {
      return true;
    }
  }
  const abandoned = lock?.hostname === hostname() ? !processIsAlive(lock.pid) : age > TTL_MS;
  if (!abandoned) return false;
  const quarantine = `${path}.stale-${randomBytes(8).toString("base64url")}`;
  try {
    await rename(path, quarantine);
    await unlink(quarantine).catch(() => undefined);
    return true;
  } catch (error) {
    return isRecord(error) && error["code"] === "ENOENT";
  }
}

async function acquireRecordLock(path: string, conflictMessage: string): Promise<LockRecord> {
  const record: LockRecord = {
    version: 1,
    pid: process.pid,
    hostname: hostname(),
    token: randomBytes(16).toString("base64url"),
    createdAt: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    let lock;
    try {
      lock = await open(path, "wx", 0o600);
      await lock.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await lock.sync();
      await lock.close();
      return record;
    } catch (error) {
      await lock?.close().catch(() => undefined);
      if (!isRecord(error) || error["code"] !== "EEXIST") {
        await unlink(path).catch(() => undefined);
        throw error;
      }
      if (attempt > 0 || !(await reclaimAbandonedLock(path))) throw new Error(conflictMessage);
    }
  }
  throw new Error(conflictMessage);
}

async function releaseRecordLock(path: string, token: string): Promise<void> {
  try {
    const current = parseLockRecord(JSON.parse(await readFile(path, "utf8")));
    if (current?.token === token) await unlink(path);
  } catch {
    // The lock is already gone or was replaced. Never remove an unknown owner.
  }
}

async function withRecordLock<T>(handle: string, conflictMessage: string, action: () => Promise<T>): Promise<T> {
  const path = `${recordPath(handle)}.lock`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = await acquireRecordLock(path, conflictMessage);
  try {
    return await action();
  } finally {
    await releaseRecordLock(path, lock.token);
  }
}

export async function withPlanLock<T>(handle: string, action: () => Promise<T>): Promise<T> {
  return withRecordLock(handle, "This prepared plan is already being built.", action);
}

export async function withReceiptLock<T>(handle: string, action: () => Promise<T>): Promise<T> {
  return withRecordLock(handle, "This analysis receipt is already being prepared or built.", action);
}

async function collectExpiredRecords(): Promise<void> {
  let names: string[];
  try {
    names = await readdir(pendingDir());
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        const path = join(pendingDir(), name);
        try {
          if (Date.now() - (await stat(path)).mtimeMs > TTL_MS) await rm(path, { force: true });
        } catch {
          // Opportunistic collection must never break the active workflow.
        }
      }),
  );
}

export function sourceFromRecord(value: unknown): StoredSource {
  assertSource(value);
  return value;
}

export function recordDebugShape(record: PendingRecord): JsonRecord {
  return { type: record.type, handle: record.handle, createdAt: record.createdAt, source: record.source };
}
