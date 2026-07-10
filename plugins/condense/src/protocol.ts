import { createHash } from "node:crypto";
import { RETENTION_MODES, type CondenseConfig, type PolicyClass, type RetentionMode } from "./config";
import { isRecord, type TranscriptRow } from "./transcript";

export type CandidateAction = "keep" | "drop" | "none";
export type CandidateManifestItem = {
  ref: string;
  class: PolicyClass;
  action: CandidateAction;
  turn: number;
  size: number;
};

export type ReceiptPayload = {
  sessionId: string;
  cutoffUuid: string;
  keepTurns: number;
  policies: Record<PolicyClass, RetentionMode>;
  sourceDigest: string;
  candidateDigest: string;
};

export type BuildDecision = { receipt: string; keep: string[]; drop: string[]; title?: string };

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex");
}

export function digestSource(rows: TranscriptRow[], cutoffUuid: string): string {
  const index = rows.findIndex((row) => row.uuid === cutoffUuid);
  if (index < 0) throw new Error(`cutoff row ${cutoffUuid} is not present in the active transcript`);
  return sha256(rows.slice(0, index + 1));
}

export function digestCandidates(items: CandidateManifestItem[]): string {
  return sha256([...items].sort((a, b) => a.ref.localeCompare(b.ref)));
}

export function actionForMode(mode: RetentionMode): CandidateAction {
  if (mode === "keep-ranked") return "keep";
  if (mode === "drop-ranked") return "drop";
  return "none";
}

export function encodeReceipt(payload: ReceiptPayload): string {
  return Buffer.from(stableStringify(payload), "utf8").toString("base64url");
}

export function decodeReceipt(receipt: string): ReceiptPayload {
  if (!receipt || typeof receipt !== "string") throw new Error("build requires a receipt string from analyze");
  let value: unknown;
  try { value = JSON.parse(Buffer.from(receipt, "base64url").toString("utf8")); }
  catch { throw new Error("invalid analyze receipt"); }
  if (!isRecord(value) || typeof value["sessionId"] !== "string" || typeof value["cutoffUuid"] !== "string"
      || typeof value["keepTurns"] !== "number" || !isRecord(value["policies"])
      || typeof value["sourceDigest"] !== "string" || typeof value["candidateDigest"] !== "string") {
    throw new Error("invalid analyze receipt shape");
  }
  const policies = value["policies"] as Record<string, unknown>;
  const expectedPolicyKeys: PolicyClass[] = ["thinking", "tools", "agentResults", "skills", "injections"];
  const policyKeys = Object.keys(policies);
  if (policyKeys.length !== expectedPolicyKeys.length || expectedPolicyKeys.some((key) => !(key in policies))) throw new Error("invalid analyze receipt policies");
  for (const key of expectedPolicyKeys) if (!(RETENTION_MODES as readonly unknown[]).includes(policies[key])) throw new Error(`invalid analyze receipt policy ${key}`);
  if (!Number.isInteger(value["keepTurns"]) || value["keepTurns"] < 0) throw new Error("invalid analyze receipt keepTurns");
  if (!/^[0-9a-f]{64}$/.test(value["sourceDigest"]) || !/^[0-9a-f]{64}$/.test(value["candidateDigest"])) throw new Error("invalid analyze receipt digest");
  return value as ReceiptPayload;
}

export function parseBuildDecision(value: unknown): BuildDecision {
  if (!isRecord(value)) throw new Error("build decision must be a JSON object");
  const allowed = new Set(["receipt", "keep", "drop", "title"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unknown build field "${key}"`);
  const refs = (key: "keep" | "drop"): string[] => {
    const raw = value[key] ?? [];
    if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) throw new Error(`${key} must be an array of refs`);
    if (new Set(raw).size !== raw.length) throw new Error(`${key} contains duplicate refs`);
    return raw as string[];
  };
  const keep = refs("keep");
  const drop = refs("drop");
  const overlap = keep.find((ref) => drop.includes(ref));
  if (overlap) throw new Error(`ref ${overlap} appears in both keep and drop`);
  const title = value["title"];
  if (typeof value["receipt"] !== "string" || !value["receipt"].trim()) throw new Error("build requires a receipt string from analyze");
  if (title !== undefined && (typeof title !== "string" || !title.trim())) throw new Error("title must be a non-empty string");
  return { receipt: value["receipt"], keep, drop, title: typeof title === "string" ? title.trim() : undefined };
}

export function configPolicies(config: CondenseConfig): ReceiptPayload["policies"] {
  return { ...config.policies };
}
