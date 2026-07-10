import { chmod, mkdir, open, readdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { RE2JS } from "re2js";
import type { CondenseConfig } from "./config";
import { sha256, stableStringify } from "./protocol";
import { isRecord, type JsonRecord } from "./transcript";

export type OmissionKind = "tool-output" | "tool-input" | "agent-result" | "skill" | "injected";
export type OmissionEntry = {
  kind: OmissionKind;
  value: unknown;
  metadata: Record<string, unknown>;
  renderedLength: number;
  sha256: string;
};
export type OmissionCache = { version: 2; nextId: number; entries: Record<string, OmissionEntry> };
type LegacyCache = { version: 1; nextId: number; entries: Record<string, { content: string }> };
export type OmissionManifest = { sessionId: string; contentIds: string[] };

function dataRoot(): string { return process.env["CONDENSE_DATA_HOME"] || join(process.env["XDG_DATA_HOME"] || join(homedir(), ".local", "share"), "condense"); }
function sessionsDir(): string { return join(dataRoot(), "sessions"); }
function manifestsDir(): string { return join(dataRoot(), "manifests"); }
function sessionPath(sessionId: string): string { return join(sessionsDir(), `${sessionId}.json`); }
function manifestPath(sessionId: string): string { return join(manifestsDir(), `${sessionId}.json`); }
function legacyDir(): string { return process.env["CONDENSE_LEGACY_STORE"] || join(homedir(), ".claude", "condense-store"); }

export function createEmptyCache(): OmissionCache { return { version: 2, nextId: 1, entries: {} }; }

async function readJson(path: string): Promise<unknown | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  try { return await file.json(); }
  catch (error) { throw new Error(`Malformed condense store ${path}: ${error instanceof Error ? error.message : String(error)}`); }
}

function isV2(value: unknown): value is OmissionCache {
  return isRecord(value) && value["version"] === 2 && typeof value["nextId"] === "number" && isRecord(value["entries"]);
}
function isV1(value: unknown): value is LegacyCache {
  return isRecord(value) && value["version"] === 1 && typeof value["nextId"] === "number" && isRecord(value["entries"]);
}

export async function loadOmissionCache(sessionId: string): Promise<OmissionCache> {
  const value = await readJson(sessionPath(sessionId));
  if (value === null) return createEmptyCache();
  if (!isV2(value)) throw new Error(`Unsupported condense store schema for session ${sessionId}`);
  return value;
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function saveOmissionCache(sessionId: string, cache: OmissionCache): Promise<void> {
  await atomicJson(sessionPath(sessionId), cache);
}

export async function saveManifest(sessionId: string, contentIds: string[]): Promise<void> {
  await atomicJson(manifestPath(sessionId), { sessionId, contentIds: [...new Set(contentIds)].sort() } satisfies OmissionManifest);
}

export async function loadManifest(sessionId: string): Promise<OmissionManifest | null> {
  const value = await readJson(manifestPath(sessionId));
  if (value === null) return null;
  if (!isRecord(value) || value["sessionId"] !== sessionId || !Array.isArray(value["contentIds"]) || value["contentIds"].some((id) => typeof id !== "string")) {
    throw new Error(`Malformed condense lineage manifest for session ${sessionId}`);
  }
  return value as OmissionManifest;
}

export function renderOmissionValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value, null, 2);
}

export function allocateOmission(
  cache: OmissionCache,
  sessionId: string,
  value: unknown,
  options: { kind?: OmissionKind; metadata?: Record<string, unknown> } = {},
): string {
  const contentId = `${sessionId.slice(-12)}:omitted-${cache.nextId.toString().padStart(3, "0")}`;
  cache.nextId++;
  const rendered = renderOmissionValue(value);
  cache.entries[contentId] = {
    kind: options.kind ?? "tool-output",
    value,
    metadata: options.metadata ?? {},
    renderedLength: rendered.length,
    sha256: sha256(stableStringify(value)),
  };
  return contentId;
}

type ResolvedEntry = { contentId: string; entry: OmissionEntry; legacy: boolean };

async function candidateFiles(directory: string, suffix: string): Promise<string[]> {
  try { return (await readdir(directory)).filter((name) => name.endsWith(`${suffix}.json`)).map((name) => join(directory, name)); }
  catch { return []; }
}

async function resolveEntry(contentId: string): Promise<ResolvedEntry | null> {
  const match = contentId.match(/^([0-9a-fA-F]{12}):omitted-\d+$/);
  if (!match) return null;
  const suffix = match[1]!;
  const paths = [...await candidateFiles(sessionsDir(), suffix), ...await candidateFiles(legacyDir(), suffix)];
  const found: ResolvedEntry[] = [];
  for (const path of paths) {
    const value = await readJson(path);
    if (isV2(value) && value.entries[contentId]) found.push({ contentId, entry: value.entries[contentId]!, legacy: false });
    else if (isV1(value) && value.entries[contentId]) {
      const content = value.entries[contentId]!.content;
      found.push({ contentId, legacy: true, entry: { kind: "tool-output", value: content, metadata: { legacy: true }, renderedLength: content.length, sha256: sha256(stableStringify(content)) } });
    }
  }
  if (found.length > 1) throw new Error(`Ambiguous Content-ID ${contentId}: multiple session stores match its suffix`);
  const result = found[0] ?? null;
  if (result && sha256(stableStringify(result.entry.value)) !== result.entry.sha256) throw new Error(`Integrity check failed for Content-ID ${contentId}`);
  return result;
}

export async function readOmittedContent(contentId: string, options: { start?: number; length?: number; config: CondenseConfig }) {
  const resolved = await resolveEntry(contentId);
  if (!resolved) return null;
  const rendered = renderOmissionValue(resolved.entry.value);
  const start = options.start ?? 0;
  const length = options.length ?? options.config.retrieval.defaultReadChars;
  if (!Number.isInteger(start) || start < 0 || start > rendered.length) throw new Error(`start must be an integer between 0 and ${rendered.length}`);
  if (!Number.isInteger(length) || length < 1 || length > options.config.retrieval.maxReadChars) throw new Error(`length must be between 1 and ${options.config.retrieval.maxReadChars}`);
  const end = Math.min(rendered.length, start + length);
  return { contentId, kind: resolved.entry.kind, metadata: resolved.entry.metadata, sha256: resolved.entry.sha256, totalLength: rendered.length, start, end, nextStart: end < rendered.length ? end : null, truncated: end < rendered.length, text: rendered.slice(start, end), legacy: resolved.legacy };
}

function lineNumberAt(text: string, offset: number): number { return text.slice(0, offset).split("\n").length; }
function contextFor(text: string, start: number, end: number, lines: number, cap: number) {
  let from = start; let to = end;
  for (let i = 0; i < lines && from > 0; i++) { const at = text.lastIndexOf("\n", Math.max(0, from - 2)); from = at < 0 ? 0 : at + 1; }
  for (let i = 0; i < lines && to < text.length; i++) { const at = text.indexOf("\n", to); to = at < 0 ? text.length : at + 1; }
  if (to - from > cap) { const half = Math.floor(cap / 2); from = Math.max(0, start - half); to = Math.min(text.length, from + cap); }
  return { contextStart: from, contextEnd: to, context: text.slice(from, to) };
}

export async function searchOmittedContent(args: {
  query: string; mode?: "literal" | "regex"; contentIds?: string[]; caseSensitive?: boolean;
  contextLines?: number; maxMatches?: number; config: CondenseConfig; sessionId?: string;
}) {
  const config = args.config.retrieval;
  if (typeof args.query !== "string" || args.query.length < config.minQueryChars) throw new Error(`query must contain at least ${config.minQueryChars} characters`);
  const mode = args.mode ?? "literal";
  if (mode === "regex" && !config.allowRegex) throw new Error("regex search is disabled by config");
  if (mode === "regex" && args.query.length > config.maxRegexPatternChars) throw new Error(`regex pattern exceeds ${config.maxRegexPatternChars} characters`);
  const contextLines = args.contextLines ?? config.defaultContextLines;
  const maxMatches = args.maxMatches ?? config.defaultMatches;
  if (!Number.isInteger(contextLines) || contextLines < 0 || contextLines > config.maxContextLines) throw new Error(`contextLines must be between 0 and ${config.maxContextLines}`);
  if (!Number.isInteger(maxMatches) || maxMatches < 1 || maxMatches > config.maxMatches) throw new Error(`maxMatches must be between 1 and ${config.maxMatches}`);
  let ids = args.contentIds;
  if (ids === undefined) {
    if (!args.sessionId) throw new Error("current-session search requires CLAUDE_CODE_SESSION_ID");
    const manifest = await loadManifest(args.sessionId);
    if (!manifest) throw new Error("No lineage manifest exists for this session; pass contentIds explicitly.");
    ids = manifest.contentIds;
  }
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) throw new Error("contentIds must be an array of strings");
  const caseSensitive = args.caseSensitive ?? config.caseSensitive;
  const results: JsonRecord[] = [];
  for (const contentId of [...new Set(ids)]) {
    if (results.length >= maxMatches) break;
    const resolved = await resolveEntry(contentId);
    if (!resolved) continue;
    const text = renderOmissionValue(resolved.entry.value);
    if (mode === "literal") {
      const haystack = caseSensitive ? text : text.toLocaleLowerCase();
      const needle = caseSensitive ? args.query : args.query.toLocaleLowerCase();
      let offset = 0;
      while (results.length < maxMatches) {
        const start = haystack.indexOf(needle, offset); if (start < 0) break;
        const end = start + needle.length;
        results.push({ contentId, kind: resolved.entry.kind, start, end, line: lineNumberAt(text, start), match: text.slice(start, end), captures: [], ...contextFor(text, start, end, contextLines, config.maxExcerptChars) });
        offset = Math.max(end, start + 1);
      }
    } else {
      const flags = (caseSensitive ? 0 : RE2JS.CASE_INSENSITIVE) | RE2JS.MULTILINE;
      let pattern: InstanceType<typeof RE2JS>;
      try { pattern = RE2JS.compile(args.query, flags); }
      catch (error) { throw new Error(`invalid RE2 pattern: ${error instanceof Error ? error.message : String(error)}`); }
      const matcher = pattern.matcher(text);
      while (results.length < maxMatches && matcher.find()) {
        const start = matcher.start(); const end = matcher.end(); const captures: Array<string | null> = [];
        for (let i = 1; i <= matcher.groupCount(); i++) { try { captures.push(matcher.group(i)); } catch { captures.push(null); } }
        results.push({ contentId, kind: resolved.entry.kind, start, end, line: lineNumberAt(text, start), match: text.slice(start, end), captures, ...contextFor(text, start, end, contextLines, config.maxExcerptChars) });
      }
    }
  }
  return { query: args.query, mode, searchedContentIds: ids.length, matches: results };
}

const CONTENT_ID = /([0-9a-fA-F]{12}:omitted-\d+)/g;
function idsInNotice(text: string): string[] {
  if (!(text.startsWith("[condense:") || text.startsWith("[Skill \"") || text.includes("_omission_notice"))) return [];
  return [...text.matchAll(CONTENT_ID)].flatMap((match) => match[1] ? [match[1]] : []);
}

export function collectReferencedContentIds(rows: JsonRecord[]): string[] {
  const ids = new Set<string>();
  const add = (text: string) => idsInNotice(text).forEach((id) => ids.add(id));
  for (const row of rows) {
    if (!isRecord(row) || !isRecord(row["message"])) continue;
    const content = row["message"]["content"];
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block["type"] === "tool_result" && typeof block["content"] === "string") add(block["content"]);
      if (block["type"] === "tool_use" && isRecord(block["input"])) {
        for (const [key, value] of Object.entries(block["input"])) if (key.endsWith("_omission_notice") && typeof value === "string") add(value);
      }
      if (row["isMeta"] === true && block["type"] === "text" && typeof block["text"] === "string") add(block["text"]);
    }
  }
  return [...ids].sort();
}

export function inputOmissionNotice(description: string, length: number, contentId: string): string { return `[condense: ${description} (${length}ch) — retrieve: ${contentId}]`; }
export function outputOmissionNotice(description: string, length: number, contentId: string): string { return inputOmissionNotice(description, length, contentId); }
export function noticeOverhead(description: string): number { return 12 + description.length + 60; }
