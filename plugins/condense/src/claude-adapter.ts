import { existsSync, readdirSync, statSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { forkSession } from "@anthropic-ai/claude-agent-sdk";
import type { ForkedSession, HostAdapter, SessionIdentity, SessionSnapshot } from "./host";
import { sha256 } from "./protocol";
import {
  findCondenseOperationBoundary,
  isRecord,
  isTranscriptRow,
  readTranscriptEntries,
  selectActiveTranscriptRows,
  type JsonRecord,
  type TranscriptRow,
} from "./transcript";

const SDK_MESSAGE_TYPES = new Set(["user", "assistant", "attachment", "system", "progress"]);

function projectDirectories(): string[] {
  const base = join(homedir(), ".claude", "projects");
  try {
    return readdirSync(base).map((entry) => join(base, entry));
  } catch {
    throw new Error(`Claude projects directory not found: ${base}`);
  }
}

function projectCwdFor(rows: TranscriptRow[], cutoffUuid: string): string {
  const cutoff = rows.find((row) => row.uuid === cutoffUuid);
  return typeof cutoff?.["cwd"] === "string" ? cutoff["cwd"] : process.cwd();
}

function sdkStorageView(entries: JsonRecord[], sessionId: string, cutoffUuid: string): JsonRecord[] {
  const messages = entries.filter((entry) =>
    SDK_MESSAGE_TYPES.has(String(entry["type"] ?? ""))
    && entry["isSidechain"] !== true
    && typeof entry["uuid"] === "string"
  );
  const cutoffIndex = messages.findIndex((entry) => entry["uuid"] === cutoffUuid);
  if (cutoffIndex < 0) throw new Error(`cutoff row ${cutoffUuid} is not present in the SDK storage view`);
  const prefix = messages.slice(0, cutoffIndex + 1);
  const replacements = entries.filter((entry) => entry["type"] === "content-replacement" && entry["sessionId"] === sessionId);
  const relocated = [...entries].reverse().find((entry) => entry["type"] === "relocated" && entry["sessionId"] === sessionId);
  return relocated ? [...prefix, ...replacements, relocated] : [...prefix, ...replacements];
}

export function assertForkLineage(rows: TranscriptRow[]): void {
  for (const row of rows) {
    const forkedFrom = row["forkedFrom"];
    if (!isRecord(forkedFrom) || typeof forkedFrom["messageUuid"] !== "string") {
      throw new Error(`SDK fork row ${row.uuid} is missing forkedFrom.messageUuid`);
    }
  }
}

export class ClaudeCodeAdapter implements HostAdapter {
  readonly host = "claude-code" as const;

  locateCurrentSession(): SessionIdentity {
    const sessionId = process.env["CLAUDE_CODE_SESSION_ID"];
    if (!sessionId) throw new Error("CLAUDE_CODE_SESSION_ID is not set — cannot locate the current session transcript.");
    const matches = projectDirectories()
      .map((directory) => join(directory, `${sessionId}.jsonl`))
      .filter(existsSync);
    if (matches.length === 0) throw new Error(`Transcript for session ${sessionId} was not found under ~/.claude/projects`);
    if (matches.length > 1) {
      matches.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
      const projectDir = process.env["CLAUDE_PROJECT_DIR"];
      if (projectDir) {
        const matchingCwd = matches.filter((path) => dirname(path).includes(basename(projectDir)));
        if (matchingCwd.length === 1) return { host: this.host, sessionId, transcriptPath: matchingCwd[0]!, projectCwd: projectDir };
      }
      throw new Error(`Ambiguous session ${sessionId}: ${matches.length} transcripts exist; remove copied duplicates before condensing.`);
    }
    return { host: this.host, sessionId, transcriptPath: matches[0]!, projectCwd: process.env["CLAUDE_PROJECT_DIR"] || process.cwd() };
  }

  async snapshot(identity: SessionIdentity, expectedCutoffUuid?: string): Promise<SessionSnapshot> {
    const entries = await readTranscriptEntries(identity.transcriptPath);
    const rows = entries.filter(isTranscriptRow);
    const active = selectActiveTranscriptRows(rows);
    const boundary = findCondenseOperationBoundary(active);
    if (expectedCutoffUuid && boundary.cutoffUuid !== expectedCutoffUuid) {
      throw new Error("Transcript changed after analyze; rerun /condense.");
    }
    const cutoffIndex = active.findIndex((row) => row.uuid === boundary.cutoffUuid);
    if (cutoffIndex < 0) throw new Error("The condense cutoff is not in the active context.");
    const contextEntries = active.slice(0, cutoffIndex + 1);
    const storageEntries = sdkStorageView(entries, identity.sessionId, boundary.cutoffUuid);
    return {
      identity: { ...identity, projectCwd: projectCwdFor(active, boundary.cutoffUuid) },
      cutoffUuid: boundary.cutoffUuid,
      operationUserUuid: boundary.operationUserUuid,
      storageEntries,
      contextEntries,
      storageDigest: sha256(storageEntries),
      contextDigest: sha256(contextEntries),
    };
  }

  async fork(snapshot: SessionSnapshot, title: string): Promise<ForkedSession> {
    const result = await forkSession(snapshot.identity.sessionId, {
      dir: snapshot.identity.projectCwd,
      upToMessageId: snapshot.cutoffUuid,
      title,
    });
    const transcriptPath = join(dirname(snapshot.identity.transcriptPath), `${result.sessionId}.jsonl`);
    try {
      const storageEntries = await readTranscriptEntries(transcriptPath);
      const messageRows = storageEntries.filter(isTranscriptRow);
      assertForkLineage(messageRows);
      const oldToNew = new Map<string, string>();
      for (const row of messageRows) {
        const forkedFrom = row["forkedFrom"];
        if (isRecord(forkedFrom) && typeof forkedFrom["messageUuid"] === "string") {
          oldToNew.set(forkedFrom["messageUuid"], row.uuid);
        }
      }
      return { sessionId: result.sessionId, transcriptPath, storageEntries, messageRows, oldToNew };
    } catch (error) {
      await unlink(transcriptPath).catch(() => undefined);
      throw error;
    }
  }

  async cleanupFork(fork: Pick<ForkedSession, "transcriptPath">): Promise<void> {
    await unlink(fork.transcriptPath).catch(() => undefined);
  }
}
