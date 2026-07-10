import { bigInputSize, injectedInfo, isCondenseNotice } from "./prune";
import { DEFAULT_CONFIG, type CondenseConfig, type PolicyClass } from "./config";
import {
  actionForMode, configPolicies, digestCandidates, digestSource, encodeReceipt,
  type CandidateManifestItem,
} from "./protocol";
import {
  buildAssistantTurns, isRecord, isToolResultRow, type JsonRecord,
  type TranscriptRow, type Turn,
} from "./transcript";

type Tier = "prime-prune" | "review" | "likely-keep";
type Op = { id: string; turn: number; seq: number; name: string; target: string };
type ThinkingStat = { ref: string; turn: number; uuid: string; blockIndex: number; signatureSize: number };
type TurnStat = {
  turn: number; age: number; userPrompt: string; prose: number; thinkingSig: number;
  thinkingBlocks: number; toolInput: number; toolOutput: number; toolCalls: number;
};
type BlockKind = "prose" | "thinking" | "tool_input" | "tool_output" | "human_prompt" | "injected" | "other";

export type Attachment = {
  ref: string;
  class: Exclude<PolicyClass, "thinking">;
  action: "keep" | "drop" | "none";
  kind: "tool-output" | "tool-input" | "agent-result" | "skill" | "injected";
  turn: number;
  size: number;
  head: string;
  tail: string;
  toolName?: string;
  path?: string;
  command?: string;
  errored?: boolean;
  failureLines?: string[];
  skill?: string;
};

export type AnalyzeResult = ReturnType<typeof analyzeInternal> & { candidateManifest: CandidateManifestItem[] };

const OUTPUT_FLOOR_CHARS = 1000;
const PREVIEW_CHARS = 240;

function blockText(block: unknown): number {
  if (!isRecord(block)) return typeof block === "string" ? block.length : 0;
  if (block["type"] === "text") return String(block["text"] ?? "").length;
  if (block["type"] === "thinking") return String(block["signature"] ?? "").length;
  if (block["type"] === "tool_use") return JSON.stringify(block["input"] ?? {}).length + String(block["name"] ?? "").length;
  if (block["type"] === "tool_result") return stringify(block["content"]).length;
  return JSON.stringify(block).length;
}

export function stringify(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === undefined || content === null) return "";
  if (Array.isArray(content)) return content.map((b) => isRecord(b) && typeof b["text"] === "string" ? b["text"] : stringify(b)).join("\n");
  return JSON.stringify(content);
}

function flatPreview(text: string, fromTail = false): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= PREVIEW_CHARS) return flat;
  return fromTail ? `…${flat.slice(-PREVIEW_CHARS)}` : `${flat.slice(0, PREVIEW_CHARS)}…`;
}

function firstLine(text: string, max = 100): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.length <= max ? line : `${line.slice(0, max).trim()}…`;
}

function userPromptText(turn: Turn): string {
  const parts: string[] = [];
  for (const row of turn.userRows) {
    if (!isRecord(row.message)) continue;
    const content = row.message["content"];
    if (typeof content === "string") parts.push(content);
    else if (Array.isArray(content)) for (const block of content) if (isRecord(block) && typeof block["text"] === "string") parts.push(block["text"]);
  }
  return firstLine(parts.join("\n"));
}

function toolTarget(name: string, input: unknown): string | null {
  if (!isRecord(input)) return null;
  const path = input["file_path"] ?? input["notebook_path"];
  if (["Read", "Edit", "Write", "NotebookEdit"].includes(name) && typeof path === "string") return `file:${path}`;
  return null;
}

function computeNewerOnSameTarget(ops: Op[]): Map<string, { turn: number; tool: string }> {
  const grouped = new Map<string, Op[]>();
  for (const op of ops) grouped.set(op.target, [...(grouped.get(op.target) ?? []), op]);
  const result = new Map<string, { turn: number; tool: string }>();
  for (const list of grouped.values()) {
    list.sort((a, b) => a.turn - b.turn || a.seq - b.seq);
    const last = list.at(-1);
    if (!last) continue;
    for (const earlier of list.slice(0, -1)) result.set(earlier.id, { turn: last.turn, tool: last.name });
  }
  return result;
}

function metadata(name: string, input: unknown): { path?: string; command?: string } {
  if (!isRecord(input)) return {};
  const path = input["file_path"] ?? input["notebook_path"];
  const command = input["command"];
  return {
    path: typeof path === "string" ? path : undefined,
    command: typeof command === "string" ? firstLine(command, 120) : undefined,
  };
}

function isAgentResult(toolName: string, raw: string): boolean {
  return /^\s*<task-notification\b/.test(raw)
    || (["Agent", "Task", "TaskOutput"].includes(toolName) && /<(?:summary|result)>/.test(raw));
}

function failureLines(text: string): string[] {
  return text.split("\n").filter((line) => /\b(error|failed|failure|exception|fatal|panic)\b/i.test(line)).slice(-3).map((line) => firstLine(line, 160));
}

function analyzeInternal(
  rows: TranscriptRow[],
  config: CondenseConfig,
  context: { sessionId: string; cutoffUuid: string },
) {
  const cutoffIndex = rows.findIndex((row) => row.uuid === context.cutoffUuid);
  if (cutoffIndex < 0) throw new Error(`cutoff ${context.cutoffUuid} not found`);
  const sourceRows = rows.slice(0, cutoffIndex + 1);
  const turns = buildAssistantTurns(sourceRows);
  const count = turns.length;
  const attachments: Attachment[] = [];
  const thinkingBlocks: ThinkingStat[] = [];
  const turnStats: TurnStat[] = [];
  const typeTotals: Record<BlockKind, number> = { prose: 0, thinking: 0, tool_input: 0, tool_output: 0, human_prompt: 0, injected: 0, other: 0 };
  const toolNames = new Map<string, string>();
  const toolInputs = new Map<string, JsonRecord>();
  const ops: Op[] = [];
  let seq = 0;

  turns.forEach((turn, ti) => {
    for (const row of turn.rows) {
      if (!isRecord(row.message) || !Array.isArray(row.message["content"])) continue;
      for (const block of row.message["content"]) {
        if (!isRecord(block) || block["type"] !== "tool_use" || typeof block["id"] !== "string") continue;
        const name = String(block["name"] ?? "?");
        toolNames.set(block["id"], name);
        if (isRecord(block["input"])) toolInputs.set(block["id"], block["input"]);
        const target = toolTarget(name, block["input"]);
        if (target) ops.push({ id: block["id"], turn: ti, seq: seq++, name, target });
      }
    }
  });
  const newer = computeNewerOnSameTarget(ops);

  turns.forEach((turn, ti) => {
    const stat: TurnStat = { turn: ti, age: count - 1 - ti, userPrompt: userPromptText(turn), prose: 0, thinkingSig: 0, thinkingBlocks: 0, toolInput: 0, toolOutput: 0, toolCalls: 0 };
    for (const row of turn.rows) {
      if (!isRecord(row.message)) continue;
      const content = row.message["content"];
      const blocks = Array.isArray(content) ? content : [content];
      if (row.type === "assistant") {
        blocks.forEach((block, blockIndex) => {
          if (isRecord(block) && block["type"] === "thinking") {
            const signatureSize = String(block["signature"] ?? "").length;
            stat.thinkingSig += signatureSize; stat.thinkingBlocks++; typeTotals.thinking += signatureSize;
            thinkingBlocks.push({ ref: `t:${row.uuid}#${blockIndex}`, turn: ti, uuid: row.uuid, blockIndex, signatureSize });
          } else if (isRecord(block) && block["type"] === "tool_use") {
            const size = blockText(block); stat.toolInput += size; stat.toolCalls++; typeTotals.tool_input += size;
            const inputSize = bigInputSize(block);
            const id = typeof block["id"] === "string" ? block["id"] : null;
            if (inputSize && id) {
              const name = String(block["name"] ?? "?"); const raw = stringify(block["input"]);
              attachments.push({ ref: `i:${id}`, class: "tools", action: actionForMode(config.policies.tools), kind: "tool-input", turn: ti, size: inputSize, head: flatPreview(raw), tail: flatPreview(raw, true), toolName: name, ...metadata(name, block["input"]) });
            }
          } else { const size = blockText(block); stat.prose += size; typeTotals.prose += size; }
        });
      } else if (row.type === "user" && isToolResultRow(row)) {
        for (const block of blocks) {
          if (!isRecord(block) || block["type"] !== "tool_result") { typeTotals.tool_output += blockText(block); continue; }
          const raw = stringify(block["content"]); const size = raw.length; stat.toolOutput += size; typeTotals.tool_output += size;
          const id = typeof block["tool_use_id"] === "string" ? block["tool_use_id"] : null;
          if (!id || !raw || size < OUTPUT_FLOOR_CHARS || isCondenseNotice(raw)) continue;
          const name = toolNames.get(id) ?? "?"; const agent = isAgentResult(name, raw); const cls = agent ? "agentResults" : "tools";
          attachments.push({ ref: `o:${id}`, class: cls, action: actionForMode(config.policies[cls]), kind: agent ? "agent-result" : "tool-output", turn: ti, size, head: flatPreview(raw), tail: flatPreview(raw, true), toolName: name, errored: block["is_error"] === true, failureLines: failureLines(raw), ...metadata(name, toolInputs.get(id)) });
        }
      } else if (row.type === "user") {
        const size = blocks.reduce((sum, block) => sum + blockText(block), 0);
        const injected = injectedInfo(row);
        if (injected) {
          typeTotals.injected += size; const cls = injected.skill ? "skills" : "injections"; const raw = stringify(content);
          attachments.push({ ref: `s:${row.uuid}`, class: cls, action: actionForMode(config.policies[cls]), kind: injected.skill ? "skill" : "injected", turn: ti, size: injected.size, head: flatPreview(raw), tail: flatPreview(raw, true), skill: injected.skill ?? undefined });
        } else typeTotals.human_prompt += size;
      }
    }
    turnStats.push(stat);
  });

  const rankable = (turn: number) => turn < count - config.keepTurns;
  const enriched = attachments.filter((item) => rankable(item.turn)).map((item) => {
    const id = /^[oi]:/.test(item.ref) ? item.ref.slice(2) : null;
    const later = id ? newer.get(id) : undefined;
    const age = count - 1 - item.turn;
    const tier: Tier = item.kind === "skill" || (later && item.toolName === "Read") ? "prime-prune" : item.kind === "agent-result" ? "likely-keep" : "review";
    return { ...item, age, newerOnSameTarget: Boolean(later), newerOnSameTargetBy: later ? `${later.tool}@turn${later.turn}` : null, tier, pruneScore: (tier === "prime-prune" ? 1e9 : 0) + item.size + age * 100 };
  }).sort((a, b) => b.pruneScore - a.pruneScore);
  const rankedThinking = thinkingBlocks.filter((item) => rankable(item.turn)).map((item) => ({ ...item, action: actionForMode(config.policies.thinking), age: count - 1 - item.turn }));
  const candidateManifest: CandidateManifestItem[] = [
    ...enriched.map((item) => ({ ref: item.ref, class: item.class, action: item.action, turn: item.turn, size: item.size })),
    ...rankedThinking.map((item) => ({ ref: item.ref, class: "thinking" as const, action: item.action, turn: item.turn, size: item.signatureSize })),
  ];
  const grand = Math.max(1, Object.values(typeTotals).reduce((a, b) => a + b, 0));
  const recoverable = enriched.reduce((sum, item) => sum + item.size, 0);
  const thinkingReclaim = rankedThinking.reduce((sum, item) => sum + item.signatureSize, 0);
  const minimum = Math.max(0, grand - recoverable - thinkingReclaim);
  const receipt = encodeReceipt({ sessionId: context.sessionId, cutoffUuid: context.cutoffUuid, keepTurns: config.keepTurns, policies: configPolicies(config), sourceDigest: digestSource(rows, context.cutoffUuid), candidateDigest: digestCandidates(candidateManifest) });
  return {
    receipt,
    effectiveConfig: { keepTurns: config.keepTurns, policies: config.policies },
    summary: { turns: count, keepTurns: config.keepTurns, rankableTurns: Math.max(0, count - config.keepTurns), totalChars: grand, approxTokens: Math.round(grand / 4), protectedProseChars: typeTotals.prose + typeTotals.human_prompt, minimumPostCondenseChars: minimum, maximumReclaimPct: Math.round(((grand - minimum) / grand) * 1000) / 10 },
    typeBreakdown: Object.fromEntries(Object.entries(typeTotals).map(([key, chars]) => [key, { chars, pct: Math.round((chars / grand) * 1000) / 10 }])),
    projectedReclaim: { attachmentsChars: recoverable, thinkingSignatureChars: thinkingReclaim },
    perTurn: turnStats.map((item) => ({ turn: item.turn, age: item.age, prompt: item.userPrompt, prose: item.prose, thinkingBlocks: item.thinkingBlocks, toolCalls: item.toolCalls, toolInput: item.toolInput, toolOutput: item.toolOutput })),
    rankableAttachments: enriched,
    rankableThinking: rankedThinking,
    candidateManifest,
  };
}

export function runAnalyze(rows: TranscriptRow[], configOrKeepTurns: CondenseConfig | number = DEFAULT_CONFIG, context?: { sessionId: string; cutoffUuid: string }): AnalyzeResult {
  const config = typeof configOrKeepTurns === "number" ? { ...DEFAULT_CONFIG, policies: { ...DEFAULT_CONFIG.policies }, retrieval: { ...DEFAULT_CONFIG.retrieval }, keepTurns: configOrKeepTurns } : configOrKeepTurns;
  const fallback = rows.at(-1);
  if (!fallback && !context) throw new Error("Cannot analyze an empty transcript");
  const resolved = context ?? { sessionId: fallback?.sessionId ?? "unknown", cutoffUuid: fallback?.uuid ?? "" };
  const result = analyzeInternal(rows, config, resolved);
  Object.defineProperty(result, "candidateManifest", { value: result.candidateManifest, enumerable: false });
  return result as AnalyzeResult;
}
