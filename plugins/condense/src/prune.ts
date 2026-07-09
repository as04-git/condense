// prune.ts — tool-INPUT candidacy + pruning for condense.
//
// condense does NOT use size thresholds to DECIDE what to shed — the model's
// ranking does that. This module only:
//   (a) identifies which tool_use inputs are big enough to be worth ranking
//       (a floor, so tiny inputs like a filepath never clutter the candidate
//       list or get a Content-ID), and
//   (b) force-prunes a specific tool_use's big input to a retrievable
//       Content-ID once the caller (build.ts, per the chosen mode) has decided
//       to shed it.
// Tool OUTPUTS are handled entirely in build.ts (applyToolOutputMode); there is
// no output pruning here and no threshold governs any keep/drop decision.

import { allocateOmission, inputOmissionNotice, noticeOverhead } from "./omission";
import { isRecord, type JsonRecord } from "./transcript";

type OmissionCache = Parameters<typeof allocateOmission>[0];

// Below this a tool input isn't worth turning into a Content-ID; such inputs
// are always kept verbatim and never appear as ranking candidates.
const INPUT_FLOOR_CHARS = 1024;

// Per-tool big-input field map. Tools not listed have no large input worth
// pruning (their inputs — filepaths, patterns, small args — stay verbatim).
// descriptionFn receives the tool's input so it can extract identifying context
// (file path, agent description, etc.) for the omission notice.
type InputSpec =
  | { kind: "omit"; fields: string[]; descriptionFn: (input: JsonRecord) => string }
  | { kind: "truncate"; field: string; keep: number; descriptionFn: (input: JsonRecord) => string };

function filePath(input: JsonRecord): string {
  const p = input["file_path"] ?? input["notebook_path"];
  return typeof p === "string" ? ` (${p})` : "";
}
function firstLine(s: unknown, max = 80): string {
  if (typeof s !== "string" || !s.trim()) return "";
  const line = s.trim().split("\n")[0]?.trim() ?? "";
  return line.length <= max ? line : `${line.slice(0, max).trim()}…`;
}

const INPUT_SPECS: Record<string, InputSpec> = {
  Write: {
    kind: "omit",
    fields: ["content"],
    descriptionFn: (i) => `Write input omitted${filePath(i)}; reread file`,
  },
  Edit: {
    kind: "omit",
    fields: ["old_string", "new_string"],
    descriptionFn: (i) => `Edit strings omitted${filePath(i)}; reread file`,
  },
  NotebookEdit: {
    kind: "omit",
    fields: ["new_source"],
    descriptionFn: (i) => `NotebookEdit source omitted${filePath(i)}; reread notebook`,
  },
  Agent: {
    kind: "omit",
    fields: ["prompt"],
    descriptionFn: (i) => {
      const d = typeof i["description"] === "string" ? ` "${i["description"]}"` : "";
      const h = firstLine(i["prompt"]);
      return `Agent prompt${d} omitted${h ? `: "${h}"` : ""}`;
    },
  },
  Workflow: {
    kind: "omit",
    fields: ["script"],
    descriptionFn: (i) => {
      const n = typeof i["name"] === "string" ? ` "${i["name"]}"` : "";
      return `Workflow script${n} omitted`;
    },
  },
  SendMessage: {
    kind: "omit",
    fields: ["message"],
    descriptionFn: (i) => {
      const to = typeof i["to"] === "string" ? ` to:${i["to"]}` : "";
      return `SendMessage${to} omitted`;
    },
  },
  ReportFindings: {
    kind: "omit",
    fields: ["findings"],
    descriptionFn: (i) => {
      const n = Array.isArray(i["findings"]) ? `(${i["findings"].length})` : "";
      return `ReportFindings${n} omitted`;
    },
  },
  Bash: {
    kind: "truncate",
    field: "command",
    keep: 512,
    descriptionFn: () => "Bash cmd truncated",
  },
};

function toolInput(block: unknown): { name: string; input: JsonRecord } | null {
  if (!isRecord(block) || block["type"] !== "tool_use") return null;
  const name = typeof block["name"] === "string" ? block["name"] : null;
  const input = block["input"];
  // AskUserQuestion inputs are small + interaction-critical; never prune.
  if (!name || name === "AskUserQuestion" || !isRecord(input)) return null;
  return { name, input };
}

function specSize(spec: InputSpec, input: JsonRecord): number {
  const fields = spec.kind === "omit" ? spec.fields : [spec.field];
  return fields.reduce((n, f) => n + stringifyContent(input[f]).length, 0);
}

// Prunable big-input size of a tool_use block, or 0 if it is not a candidate
// (unknown tool, no big field, or under the floor). Shared by analyze + build
// so both agree on exactly which inputs are rankable.
export function bigInputSize(block: unknown): number {
  const ti = toolInput(block);
  if (!ti) return 0;
  const spec = INPUT_SPECS[ti.name];
  if (!spec) return 0;
  const size = specSize(spec, ti.input);
  return size >= INPUT_FLOOR_CHARS ? size : 0;
}

// Force-prune a tool_use block's big input to a retrievable Content-ID. Returns
// the pruned size, or 0 if the block was not a prunable candidate. No threshold
// governs the decision here — the caller already ranked this input for removal.
export function pruneToolInput(
  block: JsonRecord,
  cache: OmissionCache,
  sessionId: string,
): number {
  const ti = toolInput(block);
  if (!ti) return 0;
  const spec = INPUT_SPECS[ti.name];
  if (!spec) return 0;
  const size = specSize(spec, ti.input);
  if (size < INPUT_FLOOR_CHARS) return 0;
  const desc = spec.descriptionFn(ti.input);
  if (noticeOverhead(desc) >= size) return 0;

  if (spec.kind === "truncate") {
    const command = stringifyContent(ti.input[spec.field]);
    const contentId = allocateOmission(cache, sessionId, command);
    ti.input[spec.field] = `${command.slice(0, spec.keep)}\n[REST OMITTED BY CONDENSE]`;
    ti.input[`${spec.field}_omission_notice`] = inputOmissionNotice(
      desc,
      command.length,
      contentId,
    );
    return size;
  }

  const combined = spec.fields.map((f) => stringifyContent(ti.input[f])).join("\n");
  const contentId = allocateOmission(cache, sessionId, combined);
  for (const f of spec.fields) ti.input[f] = "[Omitted by condense]";
  ti.input[`${spec.fields.join("_")}_omission_notice`] = inputOmissionNotice(
    desc,
    combined.length,
    contentId,
  );
  return size;
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === undefined || content === null) return "";
  return JSON.stringify(content);
}

// Already-pruned content carries this marker. Re-condensing must NOT re-prune a
// notice (that would nest notice→notice→original and force multi-hop retrieval);
// the existing notice already points at the original Content-ID or skill.
export function isCondenseNotice(text: string): boolean {
  return text.includes("omitted by condense") || text.includes("[condense:");
}

// True if this tool_use block's input was already pruned by an earlier condense
// (it carries a "<field>_omission_notice" key). Used to classify inputs as
// pre-pruned rather than genuinely-kept in the marker tallies.
export function hasPrunedInput(block: unknown): boolean {
  const ti = toolInput(block);
  if (!ti) return false;
  return Object.keys(ti.input).some((k) => k.endsWith("_omission_notice"));
}

// --- Injected user-role content (skill dumps, command output, structured
// injections) -------------------------------------------------------------
// Discriminator (verified empirically across real sessions): genuine user
// messages — typed OR pasted, however long, with or without images — are
// ALWAYS `isMeta` absent. Injected/system content (skill dumps, /command
// output, session-context, post-compaction notices) is ALWAYS `isMeta === true`.
// So requiring isMeta===true never touches real user prose. We additionally
// require list content + a text floor: this scopes candidates to the big
// skill/injection dumps (the reclaim wins) while the small isMeta boundary
// notice stays under the floor. (String isMeta injections like /context output
// are left for a future enhancement — safe, just not yet reclaimed.)

const INJECT_FLOOR_CHARS = 4000;

// Skill invocations emit a user message whose first text block starts with this
// marker; the last path segment is the skill name (re-invokable to reload).
// Capture the rest of the line (not just non-space) so paths with spaces work.
const SKILL_MARKER = /^Base directory for this skill:\s*(.+)/;

export function injectedInfo(
  row: unknown,
): { size: number; skill: string | null } | null {
  if (!isRecord(row) || row["type"] !== "user") return null;
  if (row["isMeta"] !== true) return null; // genuine user prose is never isMeta
  const msg = row["message"];
  if (!isRecord(msg)) return null;
  const content = msg["content"];
  if (!Array.isArray(content)) return null; // string content = plain notice, not a big dump
  // tool_result user rows are handled by the tool-output path, not here.
  if (content.some((b) => isRecord(b) && b["type"] === "tool_result")) return null;
  const text = content
    .filter((b) => isRecord(b) && b["type"] === "text")
    .map((b) => String((b as JsonRecord)["text"] ?? ""))
    .join("\n");
  if (text.length < INJECT_FLOOR_CHARS) return null;
  const m = text.match(SKILL_MARKER);
  const skill = m ? (m[1].trim().split("/").filter(Boolean).pop() ?? null) : null;
  return { size: text.length, skill };
}
