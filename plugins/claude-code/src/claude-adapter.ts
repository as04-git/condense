import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { forkSession } from "@anthropic-ai/claude-agent-sdk";
import type { ForkedSession, HostAdapter, SessionIdentity, SessionPresentation, SessionSnapshot } from "./host";
import { sha256 } from "./protocol";
import {
  isHumanUserRow,
  isRecord,
  isTranscriptRow,
  readTranscriptEntries,
  selectActiveTranscriptRows,
  writeTranscriptEntries,
  type JsonRecord,
  type TranscriptRow,
} from "./transcript";

const SDK_MESSAGE_TYPES = new Set(["user", "assistant", "attachment", "system", "progress"]);

type CondenseBoundary = { operationUserUuid: string; cutoffUuid: string };

function isClaudeCondenseMarker(row: TranscriptRow): boolean {
  if (!isRecord(row.message) || !Array.isArray(row.message["content"])) return false;
  if (row.type === "user" && row["isMeta"] === true) {
    return row.message["content"].some(
      (block) =>
        isRecord(block) &&
        typeof block["text"] === "string" &&
        /Base directory for this skill:\s*[\s\S]*[\\/]skills[\\/]condense\b/.test(block["text"]),
    );
  }
  if (row.type === "assistant") {
    return row.message["content"].some((block) => {
      if (
        !isRecord(block) ||
        block["type"] !== "tool_use" ||
        block["name"] !== "Bash" ||
        !isRecord(block["input"]) ||
        typeof block["input"]["command"] !== "string"
      ) {
        return false;
      }
      const command = block["input"]["command"];
      return (
        /[\\/]src[\\/]condense\.ts["']?\s+analyze\b/.test(command) ||
        /[\\/]src[\\/]bootstrap\.ts["']?\s+condense\s+(?:"[^"]*"|'[^']*'|\S+)\s+analyze\b/.test(command)
      );
    });
  }
  return false;
}

export function findClaudeCondenseOperationBoundary(rows: TranscriptRow[]): CondenseBoundary {
  const byUuid = new Map(rows.map((row) => [row.uuid, row]));
  const marker = [...rows].reverse().find(isClaudeCondenseMarker);
  if (!marker) throw new Error("Could not identify the active /condense operation turn.");
  let current: TranscriptRow | undefined = marker;
  const seen = new Set<string>();
  while (current && !isHumanUserRow(current)) {
    if (seen.has(current.uuid)) throw new Error("Cycle while locating /condense operation boundary.");
    seen.add(current.uuid);
    current = current.parentUuid ? byUuid.get(current.parentUuid) : undefined;
  }
  if (!current || !current.parentUuid) throw new Error("The /condense operation has no preceding cutoff row.");
  if (!byUuid.has(current.parentUuid)) throw new Error("The /condense cutoff is not in the active transcript.");
  return { operationUserUuid: current.uuid, cutoffUuid: current.parentUuid };
}

export function validateClaudeCondenseSuffix(rows: TranscriptRow[], cutoffUuid: string): void {
  const boundary = findClaudeCondenseOperationBoundary(rows);
  if (boundary.cutoffUuid !== cutoffUuid) throw new Error("Transcript changed after analyze; run /condense again.");
  const cutoffIndex = rows.findIndex((row) => row.uuid === cutoffUuid);
  if (cutoffIndex < 0) throw new Error("Receipt cutoff is no longer in the active transcript.");
  const unexpected = rows
    .slice(cutoffIndex + 1)
    .find((row) => isHumanUserRow(row) && row.uuid !== boundary.operationUserUuid);
  if (unexpected) throw new Error("A real user message appeared after analyze; run /condense again.");
}

function projectDirectories(): string[] {
  const base = join(homedir(), ".claude", "projects");
  try {
    return readdirSync(base).map((entry) => join(base, entry));
  } catch {
    throw new Error(`Claude projects directory not found: ${base}`);
  }
}

export function encodeClaudeProjectPath(projectDir: string): string {
  return projectDir.replace(/[\\/:]/g, "-");
}

export function resolveTranscriptMatch(
  sessionId: string,
  matches: string[],
  projectDir: string | undefined,
  projectsRoot = join(homedir(), ".claude", "projects"),
): string {
  if (matches.length === 0)
    throw new Error(`Transcript for session ${sessionId} was not found under ~/.claude/projects`);
  if (matches.length === 1) return matches[0]!;
  if (projectDir) {
    const encodedProjectDirectory = join(projectsRoot, encodeClaudeProjectPath(projectDir));
    const exact = matches.filter((path) => dirname(path) === encodedProjectDirectory);
    if (exact.length === 1) return exact[0]!;
  }
  throw new Error(
    `Ambiguous session ${sessionId}: ${matches.length} transcripts exist; remove copied duplicates before condensing.`,
  );
}

function projectCwdFor(rows: TranscriptRow[], cutoffUuid: string): string {
  const cutoff = rows.find((row) => row.uuid === cutoffUuid);
  return typeof cutoff?.["cwd"] === "string" ? cutoff["cwd"] : process.cwd();
}

function sdkStorageView(entries: JsonRecord[], sessionId: string, cutoffUuid: string): JsonRecord[] {
  const messages = entries.filter(
    (entry) =>
      SDK_MESSAGE_TYPES.has(String(entry["type"] ?? "")) &&
      entry["isSidechain"] !== true &&
      typeof entry["uuid"] === "string",
  );
  const cutoffIndex = messages.findIndex((entry) => entry["uuid"] === cutoffUuid);
  if (cutoffIndex < 0) throw new Error(`cutoff row ${cutoffUuid} is not present in the SDK storage view`);
  const prefix = messages.slice(0, cutoffIndex + 1);
  const replacements = entries.filter(
    (entry) => entry["type"] === "content-replacement" && entry["sessionId"] === sessionId,
  );
  const relocated = [...entries]
    .reverse()
    .find((entry) => entry["type"] === "relocated" && entry["sessionId"] === sessionId);
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

async function rawTitleRows(path: string): Promise<JsonRecord[]> {
  return (await readFile(path, "utf8")).split("\n").flatMap((line) => {
    try {
      const row: unknown = JSON.parse(line);
      return isRecord(row) && ["custom-title", "agent-name"].includes(String(row["type"])) ? [row] : [];
    } catch {
      return [];
    }
  });
}

function parentGeneration(rows: JsonRecord[]): number {
  return rows.reduce((max, row) => {
    if (row["type"] !== "custom-title") return max;
    if (typeof row["condenseGeneration"] === "number") return Math.max(max, row["condenseGeneration"]);
    const match = typeof row["customTitle"] === "string" ? row["customTitle"].match(/^🗜 condense #(\d+) —/u) : null;
    return match?.[1] ? Math.max(max, Number(match[1])) : max;
  }, 0);
}

function firstPrompt(snapshot: SessionSnapshot): string {
  for (const row of snapshot.contextEntries) {
    if (row.type !== "user" || row["isMeta"] === true || row["condenseMarker"] === true || !isRecord(row.message))
      continue;
    const content = row.message["content"];
    if (typeof content === "string" && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const text = content
        .filter((block) => isRecord(block) && block["type"] === "text")
        .map((block) => String((block as JsonRecord)["text"] ?? ""))
        .join(" ")
        .trim();
      if (text) return text;
    }
  }
  return "session";
}

function condensedTitle(rows: JsonRecord[], snapshot: SessionSnapshot, generation: number, override?: string): string {
  let base = override ?? "";
  if (!base) {
    const parent = [...rows]
      .reverse()
      .find((row) => row["type"] === "custom-title" && typeof row["customTitle"] === "string")?.["customTitle"];
    const match = typeof parent === "string" ? parent.match(/^🗜 condense #\d+ — (.+)$/u) : null;
    base = match?.[1]?.trim() || firstPrompt(snapshot);
  }
  if (base.length > 80) base = `${base.slice(0, 80).trim()}…`;
  return `🗜 condense #${generation} — ${base}`;
}

export class ClaudeCodeAdapter implements HostAdapter {
  readonly host = "claude-code" as const;

  locateCurrentSession(): SessionIdentity {
    const sessionId = process.env["CLAUDE_CODE_SESSION_ID"];
    if (!sessionId)
      throw new Error("CLAUDE_CODE_SESSION_ID is not set — cannot locate the current session transcript.");
    const matches = projectDirectories()
      .map((directory) => join(directory, `${sessionId}.jsonl`))
      .filter(existsSync);
    const projectDir = process.env["CLAUDE_PROJECT_DIR"];
    const transcriptPath = resolveTranscriptMatch(sessionId, matches, projectDir);
    return {
      host: this.host,
      sessionId,
      transcriptPath,
      projectCwd: projectDir || process.cwd(),
    };
  }

  async snapshot(identity: SessionIdentity, expectedCutoffUuid?: string): Promise<SessionSnapshot> {
    const entries = await readTranscriptEntries(identity.transcriptPath);
    const rows = entries.filter(isTranscriptRow);
    const active = selectActiveTranscriptRows(rows);
    const boundary = findClaudeCondenseOperationBoundary(active);
    if (expectedCutoffUuid) validateClaudeCondenseSuffix(active, expectedCutoffUuid);
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

  async preparePresentation(snapshot: SessionSnapshot, titleOverride?: string): Promise<SessionPresentation> {
    const rows = await rawTitleRows(snapshot.identity.transcriptPath);
    const generation = parentGeneration(rows) + 1;
    return { generation, title: condensedTitle(rows, snapshot, generation, titleOverride) };
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

  titleEntries(fork: ForkedSession, presentation: SessionPresentation): JsonRecord[] {
    return [
      {
        type: "custom-title",
        customTitle: presentation.title,
        sessionId: fork.sessionId,
        condenseGeneration: presentation.generation,
      },
      { type: "agent-name", agentName: presentation.title, sessionId: fork.sessionId },
    ];
  }

  markerEntry(fork: ForkedSession, parentUuid: string, text: string): TranscriptRow {
    const template = fork.messageRows.find((row) => row.type === "user" || row.type === "assistant");
    if (!template) throw new Error("Could not construct the closing marker");
    const fields: JsonRecord = { ...template };
    for (const key of ["message", "uuid", "parentUuid", "type", "condenseMarker", "requestId", "isMeta", "forkedFrom"])
      delete fields[key];
    const maxMs = fork.messageRows.reduce((max, row) => {
      const parsed = Date.parse(row.timestamp);
      return Number.isFinite(parsed) ? Math.max(max, parsed) : max;
    }, 0);
    return {
      ...fields,
      type: "user",
      uuid: randomUUID(),
      parentUuid,
      sessionId: fork.sessionId,
      condenseMarker: true,
      timestamp: new Date((maxMs || Date.now()) + 1000).toISOString(),
      message: { role: "user", content: text },
    } as TranscriptRow;
  }

  resumeCommand(sessionId: string): string {
    return `/resume ${sessionId}`;
  }

  async publish(fork: ForkedSession, storageEntries: JsonRecord[]): Promise<void> {
    await writeTranscriptEntries(fork.transcriptPath, storageEntries);
  }
}
