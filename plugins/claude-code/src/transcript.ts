import { chmod, open, readFile } from "node:fs/promises";
import { durableRename } from "./durable";

export type JsonRecord = Record<string, unknown>;
export type RawTranscriptEntry = JsonRecord;

export type TranscriptRow = JsonRecord & {
  type: "user" | "assistant" | "attachment" | "system";
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  message?: JsonRecord;
  subtype?: string;
  isSidechain?: boolean;
};

export type TranscriptCopy = {
  sessionId: string;
  transcriptPath: string;
};

export type Turn = {
  userRows: TranscriptRow[];
  rows: TranscriptRow[];
};

export async function readActiveTranscriptRows(transcriptPath: string): Promise<TranscriptRow[]> {
  const rows = await readTranscriptRows(transcriptPath);
  return selectActiveTranscriptRows(rows);
}

export function selectActiveTranscriptRows(rows: TranscriptRow[]): TranscriptRow[] {
  const lastBoundaryIndex = rows.findLastIndex(isCompactBoundary);
  return buildActiveChain(lastBoundaryIndex === -1 ? rows : rows.slice(lastBoundaryIndex + 1));
}

export async function writeTranscriptEntries(transcriptPath: string, entries: JsonRecord[]): Promise<void> {
  const temporary = `${transcriptPath}.condense-${process.pid}-${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporary, 0o600);
  await durableRename(temporary, transcriptPath);
}

export async function readTranscriptRows(transcriptPath: string): Promise<TranscriptRow[]> {
  const entries = await readTranscriptEntries(transcriptPath);
  return entries.filter(isTranscriptRow);
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

export function buildAssistantTurns(rows: TranscriptRow[]): Turn[] {
  const turns: Turn[] = [];
  let currentTurn: Turn | null = null;
  let assistantStarted = false;

  for (const row of rows) {
    if (row["condenseMarker"] === true) continue;
    if (isHumanUserRow(row)) {
      if (!currentTurn || assistantStarted) {
        currentTurn = { userRows: [], rows: [] };
        turns.push(currentTurn);
        assistantStarted = false;
      }
      currentTurn.userRows.push(row);
      currentTurn.rows.push(row);
      continue;
    }

    if (!currentTurn) {
      continue;
    }

    currentTurn.rows.push(row);
    if (row.type === "assistant" || isToolResultRow(row)) {
      assistantStarted = true;
    }
  }

  return turns.filter((turn) => turn.rows.some((row) => row.type === "assistant" || isToolResultRow(row)));
}

function buildActiveChain(rows: TranscriptRow[]): TranscriptRow[] {
  const rowsByUuid = new Map(rows.map((row) => [row.uuid, row]));
  const parentUuids = new Set(rows.map((row) => row.parentUuid).filter((uuid): uuid is string => uuid !== null));
  const terminalRows = rows.filter((row) => !parentUuids.has(row.uuid));
  const hasUserAssistantChild = new Set<string>();
  for (const row of rows) {
    if (row.parentUuid !== null && (row.type === "user" || row.type === "assistant")) {
      hasUserAssistantChild.add(row.parentUuid);
    }
  }

  let leaf: TranscriptRow | undefined;
  for (const terminal of terminalRows) {
    const seen = new Set<string>();
    let current: TranscriptRow | undefined = terminal;
    while (current) {
      if (seen.has(current.uuid)) {
        throw new Error("Cycle detected in transcript parentUuid chain.");
      }
      seen.add(current.uuid);
      if (current.type === "user" || current.type === "assistant") {
        if (
          !hasUserAssistantChild.has(current.uuid) &&
          (!leaf || current.timestamp.localeCompare(leaf.timestamp) > 0)
        ) {
          leaf = current;
        }
        break;
      }
      current = current.parentUuid ? rowsByUuid.get(current.parentUuid) : undefined;
    }
  }
  if (!leaf) {
    return [];
  }

  const chain: TranscriptRow[] = [];
  const seen = new Set<string>();
  let current: TranscriptRow | undefined = leaf;
  while (current) {
    if (seen.has(current.uuid)) {
      throw new Error("Cycle detected in transcript parentUuid chain.");
    }
    seen.add(current.uuid);
    chain.push(current);
    current = current.parentUuid ? rowsByUuid.get(current.parentUuid) : undefined;
  }

  return recoverParallelToolRows(rows, chain.reverse(), seen);
}

function recoverParallelToolRows(rows: TranscriptRow[], chain: TranscriptRow[], seen: Set<string>): TranscriptRow[] {
  const inserts = new Map<string, TranscriptRow[]>();
  const processedMessageIds = new Set<string>();
  const assistantRows = chain.filter((row) => row.type === "assistant");
  const anchorByMessageId = new Map<string, TranscriptRow>();
  for (const assistant of assistantRows) {
    const messageId = getMessageId(assistant);
    if (messageId) {
      anchorByMessageId.set(messageId, assistant);
    }
  }

  for (const assistant of assistantRows) {
    const messageId = getMessageId(assistant);
    if (!messageId || processedMessageIds.has(messageId)) {
      continue;
    }
    processedMessageIds.add(messageId);

    const siblings = rows.filter(
      (row) => row.type === "assistant" && getMessageId(row) === messageId && !seen.has(row.uuid),
    );
    const toolResults = rows.filter(
      (row) =>
        isToolResultRow(row) &&
        row.parentUuid !== null &&
        (row.parentUuid === assistant.uuid || siblings.some((sibling) => sibling.uuid === row.parentUuid)) &&
        !seen.has(row.uuid),
    );

    if (siblings.length > 0 || toolResults.length > 0) {
      siblings.sort(compareByTimestamp);
      toolResults.sort(compareByTimestamp);
      const anchor = anchorByMessageId.get(messageId) ?? assistant;
      inserts.set(anchor.uuid, [...siblings, ...toolResults]);
      for (const row of [...siblings, ...toolResults]) {
        seen.add(row.uuid);
      }
    }
  }

  return chain.flatMap((row) => [row, ...(inserts.get(row.uuid) ?? [])]);
}

function compareByTimestamp(a: TranscriptRow, b: TranscriptRow): number {
  return a.timestamp.localeCompare(b.timestamp);
}

function isCompactBoundary(row: TranscriptRow): boolean {
  const condense = row["condense"];
  return isRecord(condense) && condense["boundary"] === true;
}

export function isToolResultRow(row: TranscriptRow): boolean {
  if (row.type !== "user" || !isRecord(row.message)) {
    return false;
  }
  const content = row.message["content"];
  return Array.isArray(content) && content.some((block) => isRecord(block) && block["type"] === "tool_result");
}

export function isHumanUserRow(row: TranscriptRow): boolean {
  return row.type === "user" && row["condenseMarker"] !== true && !isToolResultRow(row) && row.isMeta !== true;
}

function getMessageId(row: TranscriptRow): string | null {
  return isRecord(row.message) && typeof row.message["id"] === "string" ? row.message["id"] : null;
}

export function isTranscriptRow(value: unknown): value is TranscriptRow {
  return (
    isRecord(value) &&
    typeof value["uuid"] === "string" &&
    (value["type"] === "user" ||
      value["type"] === "assistant" ||
      value["type"] === "attachment" ||
      value["type"] === "system")
  );
}

export async function readTranscriptEntries(transcriptPath: string): Promise<JsonRecord[]> {
  const content = await readFile(transcriptPath, "utf8");
  const lines = content.split("\n").filter((line) => line.trim() !== "");
  const entries: JsonRecord[] = [];
  lines.forEach((line, i) => {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) entries.push(parsed);
    } catch (err) {
      // The current session is live and may be mid-append: tolerate a single
      // unparseable trailing line. Any other parse error is a real corruption.
      if (i === lines.length - 1) return;
      throw err;
    }
  });
  return entries;
}
