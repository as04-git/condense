import { DEFAULT_CONFIG, type CondenseConfig, type PolicyClass } from "./config";
import { injectionMutation, mutateToolInputWithMeasure, thinkingDropMeasure, toolOutputMutation } from "./planner";
import { actionForMode, type CandidateManifestItem } from "./protocol";
import { bigInputSize, injectedInfo, isCondenseNotice } from "./prune";
import {
  buildAssistantTurns,
  isRecord,
  isToolResultRow,
  type JsonRecord,
  type TranscriptRow,
  type Turn,
} from "./transcript";
import type { AnalysisRecord } from "./state";

const OUTPUT_FLOOR_CHARS = 1000;
const INITIAL_EVIDENCE_CHARS = 160;
const DEEP_EVIDENCE_CHARS = 1200;
const PLACEHOLDER_ID = `c3_${"0".repeat(22)}`;

type AttachmentClass = Exclude<PolicyClass, "thinking">;
type Op = { id: string; turn: number; sequence: number; name: string; target: string };

export type Attachment = CandidateManifestItem & {
  class: AttachmentClass;
  age: number;
  priority: number;
  newerOnSameTarget: boolean;
  newerOnSameTargetBy: string | null;
};

export type ThinkingCandidate = CandidateManifestItem & {
  class: "thinking";
  age: number;
  uuid: string;
  blockIndex: number;
  priority: number;
};

export type AnalyzeTurn = {
  turn: number;
  age: number;
  prompt: string;
};

export type AnalyzeInternal = {
  scope: string;
  rankableAttachments: Attachment[];
  rankableThinking: ThinkingCandidate[];
  candidateManifest: CandidateManifestItem[];
  perTurn: AnalyzeTurn[];
};

function stringify(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === undefined || content === null) return "";
  if (Array.isArray(content)) {
    return content
      .map((block) => (isRecord(block) && typeof block["text"] === "string" ? block["text"] : stringify(block)))
      .join("\n");
  }
  return JSON.stringify(content);
}

function flat(text: string, limit: number): string {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length <= limit ? value : `${value.slice(0, limit - 1).trim()}…`;
}

function firstLine(text: string, limit = 100): string {
  return flat(text.trim().split("\n")[0] ?? "", limit);
}

function promptFor(turn: Turn): string {
  const parts: string[] = [];
  for (const row of turn.userRows) {
    if (!isRecord(row.message)) continue;
    const content = row.message["content"];
    if (typeof content === "string") parts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) if (isRecord(block) && typeof block["text"] === "string") parts.push(block["text"]);
    }
  }
  return firstLine(parts.join("\n"));
}

function toolTarget(name: string, input: unknown): string | null {
  if (!isRecord(input)) return null;
  const path = input["file_path"] ?? input["notebook_path"];
  return ["Read", "Edit", "Write", "NotebookEdit"].includes(name) && typeof path === "string" ? `file:${path}` : null;
}

function newerTargets(ops: Op[]): Map<string, Op> {
  const grouped = new Map<string, Op[]>();
  for (const op of ops) grouped.set(op.target, [...(grouped.get(op.target) ?? []), op]);
  const result = new Map<string, Op>();
  for (const values of grouped.values()) {
    values.sort((a, b) => a.turn - b.turn || a.sequence - b.sequence);
    const latest = values.at(-1);
    if (latest) for (const earlier of values.slice(0, -1)) result.set(earlier.id, latest);
  }
  return result;
}

function isAgentResult(toolName: string, text: string): boolean {
  return (
    /^\s*<task-notification\b/.test(text) ||
    (["Agent", "Task", "TaskOutput"].includes(toolName) && /<(?:summary|result)>/.test(text))
  );
}

function outputDescription(name: string, text: string, input: JsonRecord | undefined, agent: boolean): string {
  if (agent) return `agent-result omitted${firstLine(text, 70) ? `: ${firstLine(text, 70)}` : ""}`;
  const path = input?.["file_path"] ?? input?.["notebook_path"];
  if (typeof path === "string" && ["Read", "Edit", "Write", "NotebookEdit"].includes(name))
    return `${name} output omitted (${path})`;
  if (name === "Bash" && typeof input?.["command"] === "string")
    return `Bash output omitted (${firstLine(input["command"], 60)})`;
  return `${name} output omitted`;
}

function failureEvidence(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => /\b(error|failed|failure|exception|fatal|panic)\b/i.test(line))
    .slice(-3)
    .map((line) => firstLine(line, 180));
}

function candidateEvidence(text: string, failures: string[], limit: number): string {
  const evidence = failures.length
    ? failures.join(" | ")
    : `${flat(text, Math.floor(limit / 2))} ⟂ ${flat(text.slice(-limit), Math.floor(limit / 2))}`;
  return flat(evidence, limit);
}

function labelFor(name: string, input: JsonRecord | undefined, suffix: string): string {
  const path = input?.["file_path"] ?? input?.["notebook_path"];
  if (typeof path === "string") return `${suffix} ${name} ${path}`;
  if (name === "Bash" && typeof input?.["command"] === "string")
    return `${suffix} Bash ${firstLine(input["command"], 80)}`;
  return `${suffix} ${name}`;
}

function rankable(turn: number, turnCount: number, keepTurns: number): boolean {
  return turn < turnCount - keepTurns;
}

function defaultKeep(mode: CondenseConfig["policies"][PolicyClass]): boolean {
  return mode === "keep-all" || mode === "drop-ranked";
}

function priorityFor(
  action: "keep" | "drop" | "none",
  options: {
    errored?: boolean;
    agent?: boolean;
    reconstructible?: boolean;
    superseded?: boolean;
    latestEligible?: boolean;
    thinking?: boolean;
  },
): number {
  if (action === "keep") {
    if (options.errored || options.agent || (!options.reconstructible && options.latestEligible)) return 0;
    if (!options.reconstructible) return 1;
    return options.superseded ? 3 : 2;
  }
  if (action === "drop") {
    if (options.superseded && options.reconstructible) return 0;
    if (options.reconstructible) return 1;
    if (options.agent || options.thinking) return 3;
    return 2;
  }
  return 4;
}

export function runAnalyze(
  rows: TranscriptRow[],
  configOrKeepTurns: CondenseConfig | number = DEFAULT_CONFIG,
): AnalyzeInternal {
  const config =
    typeof configOrKeepTurns === "number"
      ? {
          ...DEFAULT_CONFIG,
          keepTurns: configOrKeepTurns,
          policies: { ...DEFAULT_CONFIG.policies },
          analysis: { ...DEFAULT_CONFIG.analysis },
          retrieval: { ...DEFAULT_CONFIG.retrieval },
        }
      : configOrKeepTurns;
  const turns = buildAssistantTurns(rows);
  const count = turns.length;
  const toolNames = new Map<string, string>();
  const toolInputs = new Map<string, JsonRecord>();
  const ops: Op[] = [];
  let sequence = 0;

  turns.forEach((turn, turnIndex) => {
    for (const row of turn.rows) {
      if (!isRecord(row.message) || !Array.isArray(row.message["content"])) continue;
      for (const block of row.message["content"]) {
        if (!isRecord(block) || block["type"] !== "tool_use" || typeof block["id"] !== "string") continue;
        const name = String(block["name"] ?? "?");
        toolNames.set(block["id"], name);
        if (isRecord(block["input"])) toolInputs.set(block["id"], block["input"]);
        const target = toolTarget(name, block["input"]);
        if (target) ops.push({ id: block["id"], turn: turnIndex, sequence: sequence++, name, target });
      }
    }
  });
  const newer = newerTargets(ops);
  const attachments: Attachment[] = [];
  const thinking: ThinkingCandidate[] = [];

  turns.forEach((turn, turnIndex) => {
    const age = count - 1 - turnIndex;
    for (const row of turn.rows) {
      if (!isRecord(row.message) || !Array.isArray(row.message["content"])) continue;
      const content = row.message["content"];
      if (row.type === "assistant") {
        content.forEach((block, blockIndex) => {
          if (!isRecord(block)) return;
          if (block["type"] === "thinking" && rankable(turnIndex, count, config.keepTurns)) {
            const action = actionForMode(config.policies.thinking);
            const size = thinkingDropMeasure(block).netChars;
            const ref = `t:${row.uuid}#${blockIndex}`;
            thinking.push({
              ref,
              class: "thinking",
              action,
              defaultKeep: defaultKeep(config.policies.thinking),
              turn: turnIndex,
              size,
              netChars: size,
              kind: "thinking",
              label: `thinking block ${blockIndex + 1}`,
              notice: "",
              signals: "unrecoverable",
              evidence: "prompt-anchored reasoning",
              deepEvidence:
                "Thinking content is intentionally not echoed; use the turn prompt and current-session memory.",
              age,
              uuid: row.uuid,
              blockIndex,
              priority: priorityFor(action, { thinking: true }),
            });
          } else if (block["type"] === "tool_use" && rankable(turnIndex, count, config.keepTurns)) {
            const size = bigInputSize(block);
            if (!size || typeof block["id"] !== "string") return;
            const clone = structuredClone(block) as JsonRecord;
            const mutation = mutateToolInputWithMeasure(clone, PLACEHOLDER_ID);
            if (!mutation) return;
            const name = String(block["name"] ?? "?");
            const input = isRecord(block["input"]) ? block["input"] : undefined;
            const action = actionForMode(config.policies.tools);
            const raw = stringify(input);
            const ref = `i:${block["id"]}`;
            const netChars = mutation.netChars;
            if (netChars <= 0) return;
            attachments.push({
              ref,
              class: "tools",
              action,
              defaultKeep: defaultKeep(config.policies.tools),
              turn: turnIndex,
              size,
              netChars,
              kind: "tool-input",
              label: labelFor(name, input, "input"),
              notice: "",
              signals: name === "Bash" ? "partially-retained" : "recoverable",
              evidence: candidateEvidence(raw, [], INITIAL_EVIDENCE_CHARS),
              deepEvidence: candidateEvidence(raw, [], DEEP_EVIDENCE_CHARS),
              age,
              priority: priorityFor(action, {
                reconstructible: ["Write", "Edit", "NotebookEdit"].includes(name),
                latestEligible: age === config.keepTurns,
              }),
              newerOnSameTarget: false,
              newerOnSameTargetBy: null,
            });
          }
        });
      } else if (isToolResultRow(row)) {
        for (const block of content) {
          if (!isRecord(block) || block["type"] !== "tool_result" || !rankable(turnIndex, count, config.keepTurns))
            continue;
          const raw = stringify(block["content"]);
          if (
            !raw ||
            raw.length < OUTPUT_FLOOR_CHARS ||
            isCondenseNotice(raw) ||
            typeof block["tool_use_id"] !== "string"
          )
            continue;
          const id = block["tool_use_id"];
          const name = toolNames.get(id) ?? "?";
          const input = toolInputs.get(id);
          const agent = isAgentResult(name, raw);
          const candidateClass: AttachmentClass = agent ? "agentResults" : "tools";
          const action = actionForMode(config.policies[candidateClass]);
          const description = outputDescription(name, raw, input, agent);
          const netChars = toolOutputMutation(block["content"], description, PLACEHOLDER_ID).netChars;
          if (netChars <= 0) continue;
          const later = newer.get(id);
          const reconstructible = ["Read", "Edit", "Write", "NotebookEdit"].includes(name);
          const failures = failureEvidence(raw);
          const signals = [
            block["is_error"] === true ? "error" : "",
            agent ? "agent-result" : "",
            later ? `superseded:${later.name}@t${later.turn}` : "",
            reconstructible ? "reconstructible" : "recoverable",
          ]
            .filter(Boolean)
            .join("|");
          attachments.push({
            ref: `o:${id}`,
            class: candidateClass,
            action,
            defaultKeep: defaultKeep(config.policies[candidateClass]),
            turn: turnIndex,
            size: raw.length,
            netChars,
            kind: agent ? "agent-result" : "tool-output",
            label: labelFor(name, input, "output"),
            notice: description,
            signals,
            evidence: candidateEvidence(raw, failures, INITIAL_EVIDENCE_CHARS),
            deepEvidence: candidateEvidence(raw, failures, DEEP_EVIDENCE_CHARS),
            age,
            priority: priorityFor(action, {
              errored: block["is_error"] === true,
              agent,
              reconstructible,
              superseded: Boolean(later),
              latestEligible: age === config.keepTurns,
            }),
            newerOnSameTarget: Boolean(later),
            newerOnSameTargetBy: later ? `${later.name}@t${later.turn}` : null,
          });
        }
      } else if (row.type === "user" && rankable(turnIndex, count, config.keepTurns)) {
        const injection = injectedInfo(row);
        if (!injection) continue;
        const candidateClass: AttachmentClass = injection.skill ? "skills" : "injections";
        const action = actionForMode(config.policies[candidateClass]);
        const raw = stringify(content);
        const description = injection.skill
          ? `skill ${injection.skill} omitted; re-invoke /${injection.skill}`
          : "injected content omitted";
        const netChars = injectionMutation(content, description, injection.size, PLACEHOLDER_ID).netChars;
        if (netChars <= 0) continue;
        attachments.push({
          ref: `s:${row.uuid}`,
          class: candidateClass,
          action,
          defaultKeep: defaultKeep(config.policies[candidateClass]),
          turn: turnIndex,
          size: injection.size,
          netChars,
          kind: injection.skill ? "skill" : "injected",
          label: injection.skill ? `skill /${injection.skill}` : "injected content",
          notice: description,
          signals: injection.skill ? "re-invokable|recoverable" : "recoverable",
          evidence: candidateEvidence(raw, [], INITIAL_EVIDENCE_CHARS),
          deepEvidence: candidateEvidence(raw, [], DEEP_EVIDENCE_CHARS),
          age,
          priority: priorityFor(action, { reconstructible: Boolean(injection.skill) }),
          newerOnSameTarget: false,
          newerOnSameTargetBy: null,
        });
      }
    }
  });

  attachments.sort(
    (a, b) =>
      a.action.localeCompare(b.action) ||
      a.priority - b.priority ||
      b.netChars - a.netChars ||
      a.ref.localeCompare(b.ref),
  );
  thinking.sort(
    (a, b) =>
      a.action.localeCompare(b.action) ||
      a.priority - b.priority ||
      b.netChars - a.netChars ||
      a.ref.localeCompare(b.ref),
  );
  const attachmentManifest: CandidateManifestItem[] = attachments.map(
    ({ age: _age, priority: _priority, newerOnSameTarget: _newer, newerOnSameTargetBy: _newerBy, ...candidate }) =>
      candidate,
  );
  const thinkingManifest: CandidateManifestItem[] = thinking.map(
    ({ age: _age, priority: _priority, uuid: _uuid, blockIndex: _blockIndex, ...candidate }) => candidate,
  );
  const candidateManifest = [...attachmentManifest, ...thinkingManifest];
  return {
    scope: `${count} turns; last ${config.keepTurns} untouched`,
    rankableAttachments: attachments,
    rankableThinking: thinking,
    candidateManifest,
    perTurn: turns.map((turn, turnIndex) => ({ turn: turnIndex, age: count - 1 - turnIndex, prompt: promptFor(turn) })),
  };
}

const COLUMNS = ["ref", "turn", "kind", "netChars", "label", "signals", "evidence"] as const;

function candidateRow(candidate: CandidateManifestItem, deep = false): unknown[] {
  return [
    candidate.ref,
    candidate.turn,
    candidate.kind,
    candidate.netChars,
    candidate.label,
    candidate.signals,
    deep ? candidate.deepEvidence : candidate.evidence,
  ];
}

function automaticRows(record: AnalysisRecord): Array<["inline" | "omit", string, number]> {
  return record.automatic;
}

function pageObject(
  record: AnalysisRecord,
  selected: CandidateManifestItem[],
  nextOffset: number | null,
  deep = false,
) {
  const turnIds = new Set(selected.map((candidate) => candidate.turn));
  const rankable = record.candidates.filter((candidate) => candidate.action !== "none");
  const remaining = nextOffset === null ? [] : rankable.slice(nextOffset);
  return {
    receipt: record.handle,
    scope: `${record.turns.length} turns; last ${record.config.keepTurns} untouched`,
    columns: COLUMNS,
    turns: record.turns.filter((turn) => turnIds.has(turn.turn)).map((turn) => [turn.turn, turn.prompt]),
    reviewToKeep: selected
      .filter((candidate) => candidate.action === "keep")
      .map((candidate) => candidateRow(candidate, deep)),
    reviewToDrop: selected
      .filter((candidate) => candidate.action === "drop")
      .map((candidate) => candidateRow(candidate, deep)),
    automatic: automaticRows(record),
    ...(nextOffset === null
      ? {}
      : {
          more: {
            cursor: `p_${nextOffset}`,
            reviewToKeep: remaining.filter((candidate) => candidate.action === "keep").length,
            reviewToDrop: remaining.filter((candidate) => candidate.action === "drop").length,
          },
        }),
  };
}

export function renderAnalysisPage(record: AnalysisRecord, offset = 0): ReturnType<typeof pageObject> {
  const rankable = record.candidates.filter((candidate) => candidate.action !== "none");
  if (!Number.isInteger(offset) || offset < 0 || offset >= Math.max(1, rankable.length))
    throw new Error("Invalid inspect cursor");
  const selected: CandidateManifestItem[] = [];
  let next: number | null = null;
  for (let index = offset; index < rankable.length; index++) {
    const candidate = rankable[index]!;
    const trial = [...selected, candidate];
    const trialNext = index + 1 < rankable.length ? index + 1 : null;
    if (
      JSON.stringify(pageObject(record, trial, trialNext)).length > record.config.analysis.maxPageChars &&
      selected.length > 0
    ) {
      next = index;
      break;
    }
    selected.push(candidate);
    next = trialNext;
  }
  return pageObject(record, selected, next);
}

export function renderRefInspection(record: AnalysisRecord, refs: string[]): ReturnType<typeof pageObject> {
  const byRef = new Map(record.candidates.map((candidate) => [candidate.ref, candidate]));
  const selected = refs.map((ref) => {
    const candidate = byRef.get(ref);
    if (!candidate) throw new Error(`Unknown candidate ref ${ref}`);
    return candidate;
  });
  let output = pageObject(record, selected, null, true);
  if (JSON.stringify(output).length > record.config.analysis.maxPageChars) {
    const bounded = selected.map((candidate) => ({
      ...candidate,
      deepEvidence: flat(
        candidate.deepEvidence,
        Math.max(120, Math.floor((record.config.analysis.maxPageChars - 1000) / selected.length)),
      ),
    }));
    output = pageObject(record, bounded, null, true);
  }
  return output;
}
