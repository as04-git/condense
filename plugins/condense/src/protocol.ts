import { createHash } from "node:crypto";
import type { PolicyClass, RetentionMode } from "./config";
import { isRecord } from "./transcript";

export type CandidateAction = "keep" | "drop" | "none";
export type CandidateManifestItem = {
  ref: string;
  class: PolicyClass;
  action: CandidateAction;
  defaultKeep: boolean;
  turn: number;
  size: number;
  netChars: number;
  kind: string;
  label: string;
  notice: string;
  signals: string;
  evidence: string;
  deepEvidence: string;
};

export type PrepareDecision = { receipt: string; keep: string[]; drop: string[]; title?: string };
export type InspectRequest = { receipt: string; cursor?: string; refs?: string[] };
export type BuildRequest = { plan: string };

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: unknown): string {
  return createHash("sha256")
    .update(typeof value === "string" ? value : stableStringify(value))
    .digest("hex");
}

export function actionForMode(mode: RetentionMode): CandidateAction {
  if (mode === "keep-ranked") return "keep";
  if (mode === "drop-ranked") return "drop";
  return "none";
}

export function parsePrepareDecision(value: unknown): PrepareDecision {
  if (!isRecord(value)) throw new Error("prepare decision must be a JSON object");
  const allowed = new Set(["receipt", "keep", "drop", "title"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unknown build field "${key}"`);
  const refs = (key: "keep" | "drop"): string[] => {
    const raw = value[key] ?? [];
    if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string"))
      throw new Error(`${key} must be an array of refs`);
    if (new Set(raw).size !== raw.length) throw new Error(`${key} contains duplicate refs`);
    return raw as string[];
  };
  const keep = refs("keep");
  const drop = refs("drop");
  const overlap = keep.find((ref) => drop.includes(ref));
  if (overlap) throw new Error(`ref ${overlap} appears in both keep and drop`);
  const title = value["title"];
  if (typeof value["receipt"] !== "string" || !value["receipt"].trim())
    throw new Error("build requires a receipt string from analyze");
  if (title !== undefined && (typeof title !== "string" || !title.trim()))
    throw new Error("title must be a non-empty string");
  return { receipt: value["receipt"], keep, drop, title: typeof title === "string" ? title.trim() : undefined };
}

/** @deprecated retained for source compatibility; prepare now owns decisions. */
export const parseBuildDecision = parsePrepareDecision;

export function parseInspectRequest(value: unknown): InspectRequest {
  if (!isRecord(value)) throw new Error("inspect request must be a JSON object");
  const allowed = new Set(["receipt", "cursor", "refs"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unknown inspect field "${key}"`);
  if (typeof value["receipt"] !== "string") throw new Error("inspect requires an analysis receipt");
  const cursor = value["cursor"];
  const refs = value["refs"];
  if (cursor !== undefined && typeof cursor !== "string") throw new Error("cursor must be a string");
  if (refs !== undefined && (!Array.isArray(refs) || refs.some((ref) => typeof ref !== "string")))
    throw new Error("refs must be an array of strings");
  if (cursor !== undefined && refs !== undefined) throw new Error("cursor and refs are mutually exclusive");
  if (cursor === undefined && refs === undefined) throw new Error("inspect requires cursor or refs");
  if (Array.isArray(refs) && (refs.length === 0 || refs.length > 20))
    throw new Error("refs must contain between 1 and 20 refs");
  return { receipt: value["receipt"], cursor, refs: refs as string[] | undefined };
}

export function parseBuildRequest(value: unknown): BuildRequest {
  if (!isRecord(value)) throw new Error("build request must be a JSON object");
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "plan" || typeof value["plan"] !== "string") {
    throw new Error("build accepts only a prepared plan handle");
  }
  return { plan: value["plan"] };
}
