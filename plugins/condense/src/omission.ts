import { randomBytes } from "node:crypto";
import { chmod, link, mkdir, open, readdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { RE2JS } from "re2js";
import type { CondenseConfig } from "./config";
import { durableRename, syncDirectory } from "./durable";
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
export type OmissionManifest = { version?: 3; sessionId: string; contentIds: string[] };
export type V3OmissionObject = {
  version: 3;
  id: string;
  kind: OmissionKind;
  value: unknown;
  metadata: Record<string, unknown>;
  renderedLength: number;
  sha256: string;
};

function dataRoot(): string {
  return (
    process.env["CONDENSE_DATA_HOME"] ||
    join(process.env["XDG_DATA_HOME"] || join(homedir(), ".local", "share"), "condense")
  );
}
function sessionsDir(): string {
  return join(dataRoot(), "sessions");
}
function manifestsDir(): string {
  return join(dataRoot(), "manifests");
}
function objectsDir(): string {
  return join(dataRoot(), "objects");
}
function sessionPath(sessionId: string): string {
  return join(sessionsDir(), `${sessionId}.json`);
}
function manifestPath(sessionId: string): string {
  return join(manifestsDir(), `${sessionId}.json`);
}
function legacyDir(): string {
  return process.env["CONDENSE_LEGACY_STORE"] || join(homedir(), ".claude", "condense-store");
}

export function createEmptyCache(): OmissionCache {
  return { version: 2, nextId: 1, entries: {} };
}

async function readJson(path: string): Promise<unknown | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  try {
    return await file.json();
  } catch (error) {
    throw new Error(`Malformed condense store ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
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
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporary, 0o600);
  await durableRename(temporary, path);
  await chmod(path, 0o600);
}

export async function saveOmissionCache(sessionId: string, cache: OmissionCache): Promise<void> {
  await atomicJson(sessionPath(sessionId), cache);
}

export async function saveManifest(sessionId: string, contentIds: string[]): Promise<void> {
  await atomicJson(manifestPath(sessionId), {
    version: 3,
    sessionId,
    contentIds: [...new Set(contentIds)].sort(),
  } satisfies OmissionManifest);
}

export async function loadManifest(sessionId: string): Promise<OmissionManifest | null> {
  const value = await readJson(manifestPath(sessionId));
  if (value === null) return null;
  if (
    !isRecord(value) ||
    (value["version"] !== undefined && value["version"] !== 3) ||
    value["sessionId"] !== sessionId ||
    !Array.isArray(value["contentIds"]) ||
    value["contentIds"].some((id) => typeof id !== "string")
  ) {
    throw new Error(`Malformed condense lineage manifest for session ${sessionId}`);
  }
  return value as OmissionManifest;
}

export function renderOmissionValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value, null, 2);
}

function boundedMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string") result[key] = value.replace(/\s+/g, " ").slice(0, 240);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) result[key] = value;
    else if (Array.isArray(value))
      result[key] = value.slice(0, 20).map((item) => (typeof item === "string" ? item.slice(0, 120) : item));
  }
  return result;
}

function v3EnvelopeHash(entry: Omit<V3OmissionObject, "sha256">): string {
  return sha256(stableStringify(entry));
}

export function newContentId(): string {
  return `c3_${randomBytes(16).toString("base64url")}`;
}

export async function newAvailableContentId(): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = newContentId();
    if (!(await Bun.file(objectPath(id)).exists())) return id;
  }
  throw new Error("Could not allocate a collision-free v3 Content-ID");
}

export function makeV3Object(
  id: string,
  value: unknown,
  options: { kind?: OmissionKind; metadata?: Record<string, unknown> } = {},
): V3OmissionObject {
  if (!/^c3_[A-Za-z0-9_-]{22}$/.test(id)) throw new Error(`Invalid v3 Content-ID ${id}`);
  const base: Omit<V3OmissionObject, "sha256"> = {
    version: 3,
    id,
    kind: options.kind ?? "tool-output",
    value,
    metadata: boundedMetadata(options.metadata ?? {}),
    renderedLength: renderOmissionValue(value).length,
  };
  return { ...base, sha256: v3EnvelopeHash(base) };
}

function objectPath(id: string): string {
  return join(objectsDir(), id.slice(3, 5), `${id}.json`);
}

export async function saveV3Objects(objects: V3OmissionObject[]): Promise<void> {
  for (const object of objects) {
    const path = objectPath(object.id);
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(object)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, path);
      await syncDirectory(directory);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    await chmod(path, 0o600);
  }
}

export function omissionNotice(description: string, length: number, contentId: string): string {
  const safe = description
    .replace(/[\r\n\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return `[condense:v3 ${contentId} ${length}ch | ${safe}]`;
}

export type ParsedNotice = { version: 3 | "legacy"; contentId: string };
const V3_NOTICE = /^\[condense:v3 (c3_[A-Za-z0-9_-]{22}) \d+ch \| [^\]\r\n]{1,180}\]$/;
const LEGACY_NOTICE = /^\[condense: [\s\S]+ \(\d+ch\) — retrieve: ([0-9a-fA-F]{12}:omitted-\d+)\]$/;
const LEGACY_SKILL_NOTICE =
  /^\[Skill "[^"]+" output \(\d+ chars\) omitted by condense\. Re-invoke \/[^;\]]+; fallback retrieve: ([0-9a-fA-F]{12}:omitted-\d+)\]$/;

export function parseOmissionNotice(text: string): ParsedNotice | null {
  const v3 = text.match(V3_NOTICE);
  if (v3?.[1]) return { version: 3, contentId: v3[1] };
  const legacy = text.match(LEGACY_NOTICE) ?? text.match(LEGACY_SKILL_NOTICE);
  return legacy?.[1] ? { version: "legacy", contentId: legacy[1] } : null;
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

type ResolvedEntry = { contentId: string; entry: OmissionEntry; legacy: boolean; version: 1 | 2 | 3 };

async function candidateFiles(directory: string, suffix: string): Promise<string[]> {
  try {
    return (await readdir(directory))
      .filter((name) => name.endsWith(`${suffix}.json`))
      .map((name) => join(directory, name));
  } catch {
    return [];
  }
}

type RequestCache = Map<string, Promise<unknown | null>>;

async function cachedJson(path: string, cache?: RequestCache): Promise<unknown | null> {
  if (!cache) return readJson(path);
  let pending = cache.get(path);
  if (!pending) {
    pending = readJson(path);
    cache.set(path, pending);
  }
  return pending;
}

async function resolveEntry(contentId: string, cache?: RequestCache): Promise<ResolvedEntry | null> {
  if (/^c3_[A-Za-z0-9_-]{22}$/.test(contentId)) {
    const value = await cachedJson(objectPath(contentId), cache);
    if (value === null) return null;
    if (
      !isRecord(value) ||
      value["version"] !== 3 ||
      value["id"] !== contentId ||
      typeof value["kind"] !== "string" ||
      !("value" in value) ||
      !isRecord(value["metadata"]) ||
      typeof value["renderedLength"] !== "number" ||
      typeof value["sha256"] !== "string"
    ) {
      throw new Error(`Malformed v3 condense object ${contentId}`);
    }
    const object = value as V3OmissionObject;
    const { sha256: expected, ...base } = object;
    if (v3EnvelopeHash(base) !== expected) throw new Error(`Integrity check failed for Content-ID ${contentId}`);
    if (renderOmissionValue(object.value).length !== object.renderedLength)
      throw new Error(`Rendered-length check failed for Content-ID ${contentId}`);
    return {
      contentId,
      legacy: false,
      version: 3,
      entry: {
        kind: object.kind,
        value: object.value,
        metadata: object.metadata,
        renderedLength: object.renderedLength,
        sha256: object.sha256,
      },
    };
  }
  const match = contentId.match(/^([0-9a-fA-F]{12}):omitted-\d+$/);
  if (!match) return null;
  const suffix = match[1]!;
  const paths = [...(await candidateFiles(sessionsDir(), suffix)), ...(await candidateFiles(legacyDir(), suffix))];
  const found: ResolvedEntry[] = [];
  for (const path of paths) {
    const value = await cachedJson(path, cache);
    if (isV2(value) && value.entries[contentId])
      found.push({ contentId, entry: value.entries[contentId]!, legacy: false, version: 2 });
    else if (isV1(value) && value.entries[contentId]) {
      const content = value.entries[contentId]!.content;
      found.push({
        contentId,
        legacy: true,
        version: 1,
        entry: {
          kind: "tool-output",
          value: content,
          metadata: { legacy: true },
          renderedLength: content.length,
          sha256: sha256(stableStringify(content)),
        },
      });
    }
  }
  if (found.length > 1) throw new Error(`Ambiguous Content-ID ${contentId}: multiple session stores match its suffix`);
  const result = found[0] ?? null;
  if (result && sha256(stableStringify(result.entry.value)) !== result.entry.sha256)
    throw new Error(`Integrity check failed for Content-ID ${contentId}`);
  return result;
}

export async function readOmittedContent(
  contentId: string,
  options: { start?: number; length?: number; config: CondenseConfig },
) {
  const resolved = await resolveEntry(contentId);
  if (!resolved) return null;
  const rendered = renderOmissionValue(resolved.entry.value);
  const start = options.start ?? 0;
  const requestedLength = options.length ?? options.config.retrieval.defaultReadChars;
  if (!Number.isInteger(start) || start < 0 || start > rendered.length)
    throw new Error(`start must be an integer between 0 and ${rendered.length}`);
  if (
    !Number.isInteger(requestedLength) ||
    requestedLength < 1 ||
    requestedLength > options.config.retrieval.maxReadChars
  )
    throw new Error(`length must be between 1 and ${options.config.retrieval.maxReadChars}`);
  const length = Math.min(requestedLength, Math.max(1, options.config.retrieval.maxResponseChars - 3000));
  const end = Math.min(rendered.length, start + length);
  const metadataText = JSON.stringify(resolved.entry.metadata);
  const metadata =
    metadataText.length <= 2000 ? resolved.entry.metadata : { truncated: true, preview: metadataText.slice(0, 1900) };
  return {
    contentId,
    kind: resolved.entry.kind,
    metadata,
    sha256: resolved.entry.sha256,
    totalLength: rendered.length,
    start,
    end,
    nextStart: end < rendered.length ? end : null,
    truncated: end < rendered.length,
    text: rendered.slice(start, end),
    legacy: resolved.legacy,
  };
}

function lineNumberAt(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}
function contextFor(text: string, start: number, end: number, lines: number, cap: number) {
  let from = start;
  let to = end;
  for (let i = 0; i < lines && from > 0; i++) {
    const at = text.lastIndexOf("\n", Math.max(0, from - 2));
    from = at < 0 ? 0 : at + 1;
  }
  for (let i = 0; i < lines && to < text.length; i++) {
    const at = text.indexOf("\n", to);
    to = at < 0 ? text.length : at + 1;
  }
  if (to - from > cap) {
    const half = Math.floor(cap / 2);
    from = Math.max(0, start - half);
    to = Math.min(text.length, from + cap);
  }
  return { contextStart: from, contextEnd: to, context: text.slice(from, to) };
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

export async function searchOmittedContent(args: {
  query: string;
  mode?: "literal" | "regex";
  contentIds?: string[];
  caseSensitive?: boolean;
  contextLines?: number;
  maxMatches?: number;
  config: CondenseConfig;
  sessionId?: string;
}) {
  const config = args.config.retrieval;
  if (typeof args.query !== "string" || args.query.length < config.minQueryChars)
    throw new Error(`query must contain at least ${config.minQueryChars} characters`);
  if (args.query.length > config.maxRegexPatternChars)
    throw new Error(`query exceeds ${config.maxRegexPatternChars} characters`);
  const mode = args.mode ?? "literal";
  if (mode === "regex" && !config.allowRegex) throw new Error("regex search is disabled by config");
  if (mode === "regex" && args.query.length > config.maxRegexPatternChars)
    throw new Error(`regex pattern exceeds ${config.maxRegexPatternChars} characters`);
  const contextLines = args.contextLines ?? config.defaultContextLines;
  const maxMatches = args.maxMatches ?? config.defaultMatches;
  if (!Number.isInteger(contextLines) || contextLines < 0 || contextLines > config.maxContextLines)
    throw new Error(`contextLines must be between 0 and ${config.maxContextLines}`);
  if (!Number.isInteger(maxMatches) || maxMatches < 1 || maxMatches > config.maxMatches)
    throw new Error(`maxMatches must be between 1 and ${config.maxMatches}`);
  let ids = args.contentIds;
  if (ids === undefined) {
    if (!args.sessionId) throw new Error("current-session search requires CLAUDE_CODE_SESSION_ID");
    const manifest = await loadManifest(args.sessionId);
    if (!manifest) throw new Error("No lineage manifest exists for this session; pass contentIds explicitly.");
    ids = manifest.contentIds;
  }
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))
    throw new Error("contentIds must be an array of strings");
  if (ids.length > 500) throw new Error("contentIds may contain at most 500 IDs");
  if (ids.some((id) => !/^c3_[A-Za-z0-9_-]{22}$/.test(id) && !/^[0-9a-fA-F]{12}:omitted-\d+$/.test(id)))
    throw new Error("contentIds contains an invalid Content-ID");
  const caseSensitive = args.caseSensitive ?? config.caseSensitive;
  const results: JsonRecord[] = [];
  const missingContentIds: string[] = [];
  let responseChars = 0;
  let responseTruncated = false;
  const requestCache: RequestCache = new Map();
  const addResult = (result: JsonRecord): boolean => {
    const serialized = JSON.stringify(result).length;
    if (responseChars + serialized > config.maxResponseChars) {
      responseTruncated = true;
      return false;
    }
    responseChars += serialized;
    results.push(result);
    return true;
  };
  for (const contentId of [...new Set(ids)]) {
    const resolved = await resolveEntry(contentId, requestCache);
    if (!resolved) {
      missingContentIds.push(contentId);
      continue;
    }
    if (results.length >= maxMatches || responseTruncated) continue;
    const text = renderOmissionValue(resolved.entry.value);
    if (mode === "literal") {
      const flags = (caseSensitive ? 0 : RE2JS.CASE_INSENSITIVE) | RE2JS.MULTILINE;
      const matcher = RE2JS.compile(escapeRegexLiteral(args.query), flags).matcher(text);
      while (results.length < maxMatches && matcher.find()) {
        const start = matcher.start();
        const end = matcher.end();
        const rawMatch = text.slice(start, end);
        const match = rawMatch.slice(0, 500);
        if (
          !addResult({
            contentId,
            kind: resolved.entry.kind,
            start,
            end,
            line: lineNumberAt(text, start),
            match,
            matchLength: rawMatch.length,
            matchTruncated: match.length < rawMatch.length,
            captures: [],
            ...contextFor(text, start, end, contextLines, config.maxExcerptChars),
          })
        )
          break;
      }
    } else {
      const flags = (caseSensitive ? 0 : RE2JS.CASE_INSENSITIVE) | RE2JS.MULTILINE;
      let pattern: InstanceType<typeof RE2JS>;
      try {
        pattern = RE2JS.compile(args.query, flags);
      } catch (error) {
        throw new Error(`invalid RE2 pattern: ${error instanceof Error ? error.message : String(error)}`);
      }
      const matcher = pattern.matcher(text);
      while (results.length < maxMatches && matcher.find()) {
        const start = matcher.start();
        const end = matcher.end();
        const captures: Array<string | null> = [];
        for (let i = 1; i <= matcher.groupCount(); i++) {
          try {
            captures.push(matcher.group(i));
          } catch {
            captures.push(null);
          }
        }
        const rawMatch = text.slice(start, end);
        const match = rawMatch.slice(0, 500);
        const boundedCaptures = captures.map((capture) => (capture === null ? null : capture.slice(0, 300)));
        if (
          !addResult({
            contentId,
            kind: resolved.entry.kind,
            start,
            end,
            line: lineNumberAt(text, start),
            match,
            matchLength: rawMatch.length,
            matchTruncated: match.length < rawMatch.length,
            captures: boundedCaptures,
            capturesTruncated: captures.some(
              (capture, i) => capture !== null && capture.length > (boundedCaptures[i]?.length ?? 0),
            ),
            ...contextFor(text, start, end, contextLines, config.maxExcerptChars),
          })
        )
          break;
      }
    }
  }
  const response = {
    query: args.query,
    mode,
    complete: missingContentIds.length === 0 && !responseTruncated,
    searchedContentIds: ids.length - missingContentIds.length,
    missingContentIds,
    responseTruncated,
    matches: results,
  };
  while (JSON.stringify(response).length > config.maxResponseChars && results.length > 0) {
    results.pop();
    response.responseTruncated = true;
    response.complete = false;
  }
  if (JSON.stringify(response).length > config.maxResponseChars)
    throw new Error("retrieval.maxResponseChars is too small for the bounded response metadata");
  return response;
}

function idsInNotice(text: string): string[] {
  const notice = parseOmissionNotice(text);
  return notice ? [notice.contentId] : [];
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
        for (const [key, value] of Object.entries(block["input"]))
          if (key.endsWith("_omission_notice") && typeof value === "string") add(value);
      }
      if (row["isMeta"] === true && block["type"] === "text" && typeof block["text"] === "string") add(block["text"]);
    }
  }
  return [...ids].sort();
}

export function inputOmissionNotice(description: string, length: number, contentId: string): string {
  return `[condense: ${description} (${length}ch) — retrieve: ${contentId}]`;
}
export function outputOmissionNotice(description: string, length: number, contentId: string): string {
  return inputOmissionNotice(description, length, contentId);
}
export function noticeOverhead(description: string): number {
  return 12 + description.length + 60;
}
