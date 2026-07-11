import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import {
  allocateOmission, collectReferencedContentIds, createEmptyCache, readOmittedContent,
  makeV3Object, newContentId, omissionNotice, parseOmissionNotice, saveManifest,
  saveOmissionCache, saveV3Objects, searchOmittedContent,
} from "../src/omission";
import { pruneToolInput } from "../src/prune";

let root = ""; let legacy = "";
beforeEach(async () => { root = await mkdtemp("/tmp/condense-store-"); legacy = join(root, "legacy"); process.env["CONDENSE_DATA_HOME"] = join(root, "data"); process.env["CONDENSE_LEGACY_STORE"] = legacy; });
afterEach(async () => { delete process.env["CONDENSE_DATA_HOME"]; delete process.env["CONDENSE_LEGACY_STORE"]; await rm(root, { recursive: true, force: true }); });

test("preserves structured Edit fields", () => {
  const cache = createEmptyCache(); const old = "old\nvalue".repeat(200); const next = "new\nvalue".repeat(200);
  const block: Record<string, any> = { type: "tool_use", id: "edit", name: "Edit", input: { file_path: "/x", old_string: old, new_string: next } };
  expect(pruneToolInput(block, cache, "00000000-0000-0000-0000-123456789abc")).toBeGreaterThan(0);
  const entry = Object.values(cache.entries)[0]!;
  expect(entry.value).toEqual({ old_string: old, new_string: next }); expect(entry.metadata.fields).toEqual(["old_string", "new_string"]);
});

describe("read and search", () => {
  test("paginates, searches lineage literally, and captures safe regex groups", async () => {
    const session = "00000000-0000-0000-0000-123456789abc"; const cache = createEmptyCache();
    const id = allocateOmission(cache, session, "alpha\nerror[E42]\nλomega", { kind: "tool-output", metadata: { toolName: "Bash" } });
    await saveOmissionCache(session, cache); await saveManifest("active", [id]);
    const page = await readOmittedContent(id, { config: DEFAULT_CONFIG, length: 5 });
    expect(page?.text).toBe("alpha"); expect(page?.nextStart).toBe(5);
    const literal = await searchOmittedContent({ query: "ERROR", config: DEFAULT_CONFIG, sessionId: "active" });
    expect(literal.matches).toHaveLength(1); expect(literal.matches[0]!.line).toBe(2);
    const regex = await searchOmittedContent({ query: "error\\[(E\\d+)\\]", mode: "regex", contentIds: [id], config: DEFAULT_CONFIG });
    expect(regex.matches[0]!.captures).toEqual(["E42"]);
    const unicode = await searchOmittedContent({ query: "λomega", mode: "regex", contentIds: [id], config: DEFAULT_CONFIG });
    expect(unicode.matches).toHaveLength(1);
    await expect(searchOmittedContent({ query: "(?=error)", mode: "regex", contentIds: [id], config: DEFAULT_CONFIG })).rejects.toThrow("invalid RE2");
  });

  test("reads legacy caches without rewriting", async () => {
    await mkdir(legacy, { recursive: true }); const session = "00000000-0000-0000-0000-abcdef123456"; const id = "abcdef123456:omitted-001";
    await Bun.write(join(legacy, `${session}.json`), JSON.stringify({ version: 1, nextId: 2, entries: { [id]: { content: "legacy value" } } }));
    const result = await readOmittedContent(id, { config: DEFAULT_CONFIG });
    expect(result?.text).toBe("legacy value"); expect(result?.legacy).toBe(true);
  });

  test("writes 0600 files under 0700 directories and detects hash tampering", async () => {
    const session = "00000000-0000-0000-0000-fedcba654321"; const cache = createEmptyCache(); const id = allocateOmission(cache, session, "secret");
    await saveOmissionCache(session, cache); const path = join(root, "data", "sessions", `${session}.json`);
    expect((await stat(path)).mode & 0o777).toBe(0o600); expect((await stat(join(root, "data", "sessions"))).mode & 0o777).toBe(0o700);
    const json = JSON.parse(await readFile(path, "utf8")); json.entries[id].value = "tampered"; await Bun.write(path, JSON.stringify(json));
    await expect(readOmittedContent(id, { config: DEFAULT_CONFIG })).rejects.toThrow("Integrity check");
  });

  test("fails closed when short session suffixes are ambiguous", async () => {
    const first = "00000000-0000-0000-0000-abcdef123456";
    const second = "11111111-1111-1111-1111-abcdef123456";
    const firstCache = createEmptyCache();
    const secondCache = createEmptyCache();
    const id = allocateOmission(firstCache, first, "first");
    expect(allocateOmission(secondCache, second, "second")).toBe(id);
    await saveOmissionCache(first, firstCache);
    await saveOmissionCache(second, secondCache);
    await expect(readOmittedContent(id, { config: DEFAULT_CONFIG })).rejects.toThrow("Ambiguous Content-ID");
  });
});

test("collects only structurally owned placeholder IDs", () => {
  const id = "abcdef123456:omitted-001";
  const rows: any[] = [
    { type: "user", isMeta: false, message: { content: `pasted ${id}` } },
    { type: "user", message: { content: [{ type: "tool_result", content: `[condense: output omitted (2ch) — retrieve: ${id}]` }] } },
  ];
  expect(collectReferencedContentIds(rows)).toEqual([id]);
});

test("writes directly addressable v3 objects and parses only exact notices", async () => {
  const id = newContentId();
  await saveV3Objects([makeV3Object(id, { exact: ["value"] }, { kind: "tool-output", metadata: { command: "x".repeat(1000) } })]);
  const notice = omissionNotice("Bash output omitted", 10, id);
  expect(parseOmissionNotice(notice)?.contentId).toBe(id);
  expect(parseOmissionNotice(`prefix ${notice}`)).toBeNull();
  const result = await readOmittedContent(id, { config: DEFAULT_CONFIG });
  expect(result?.text).toContain('"exact"');
  expect(JSON.stringify(result?.metadata).length).toBeLessThan(2100);
});

test("bounds full regex matches and reports missing IDs", async () => {
  const id = newContentId();
  await saveV3Objects([makeV3Object(id, "x".repeat(100000))]);
  const result = await searchOmittedContent({ query: "[x]+", mode: "regex", contentIds: [id, newContentId()], maxMatches: 1, config: DEFAULT_CONFIG });
  expect(String(result.matches[0]!.match).length).toBeLessThanOrEqual(500);
  expect(result.matches[0]!.matchTruncated).toBe(true);
  expect(result.complete).toBe(false);
  expect(result.missingContentIds).toHaveLength(1);
  expect(JSON.stringify(result).length).toBeLessThan(DEFAULT_CONFIG.retrieval.maxResponseChars);
});
