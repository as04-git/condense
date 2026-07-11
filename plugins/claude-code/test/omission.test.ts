import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { boundedMcpTextResponse, configForMcpResponse } from "../src/mcp-response";
import {
  collectReferencedContentIds,
  makeOmissionObject,
  newContentId,
  omissionStorageUsage,
  omissionNotice,
  parseOmissionNotice,
  readOmittedContent,
  saveManifest,
  saveOmissionObjects,
  searchOmittedContent,
} from "../src/omission";
import { pruneToolInputWithId } from "../src/prune";
import { testTmpdir } from "./temp";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(testTmpdir(), "condense-store-"));
  process.env["CONDENSE_DATA_HOME"] = join(root, "data");
});
afterEach(async () => {
  delete process.env["CONDENSE_DATA_HOME"];
  await rm(root, { recursive: true, force: true });
});

test("preserves structured Edit fields", () => {
  const old = "old\nvalue".repeat(200);
  const next = "new\nvalue".repeat(200);
  const block: Record<string, any> = {
    type: "tool_use",
    id: "edit",
    name: "Edit",
    input: { file_path: "/x", old_string: old, new_string: next },
  };
  const result = pruneToolInputWithId(block, newContentId());
  expect(result?.size).toBeGreaterThan(0);
  expect(result?.value).toEqual({ old_string: old, new_string: next });
  expect(result?.metadata.fields).toEqual(["old_string", "new_string"]);
});

describe("read and search", () => {
  test("paginates, searches lineage literally, and captures safe regex groups", async () => {
    const id = newContentId();
    await saveOmissionObjects([
      makeOmissionObject(id, "alpha\nerror[E42]\nλomega", {
        kind: "tool-output",
        metadata: { toolName: "Bash" },
      }),
    ]);
    await saveManifest("active", [id]);
    const page = await readOmittedContent(id, { config: DEFAULT_CONFIG, length: 5 });
    expect(page?.text).toBe("alpha");
    expect(page?.nextStart).toBe(5);
    const literal = await searchOmittedContent({ query: "ERROR", config: DEFAULT_CONFIG, sessionId: "active" });
    expect(literal.matches).toHaveLength(1);
    expect(literal.matches[0]!.line).toBe(2);
    const regex = await searchOmittedContent({
      query: "error\\[(E\\d+)\\]",
      mode: "regex",
      contentIds: [id],
      config: DEFAULT_CONFIG,
    });
    expect(regex.matches[0]!.captures).toEqual(["E42"]);
    const unicode = await searchOmittedContent({
      query: "λomega",
      mode: "regex",
      contentIds: [id],
      config: DEFAULT_CONFIG,
    });
    expect(unicode.matches).toHaveLength(1);

    const unicodeId = newContentId();
    await saveOmissionObjects([makeOmissionObject(unicodeId, "😀ΛOmega tail")]);
    const unicodeLiteral = await searchOmittedContent({
      query: "λomega",
      contentIds: [unicodeId],
      config: DEFAULT_CONFIG,
    });
    const start = Number(unicodeLiteral.matches[0]!.start);
    const end = Number(unicodeLiteral.matches[0]!.end);
    expect(start).toBe("😀".length);
    expect("😀ΛOmega tail".slice(start, end)).toBe("ΛOmega");
    await expect(
      searchOmittedContent({ query: "(?=error)", mode: "regex", contentIds: [id], config: DEFAULT_CONFIG }),
    ).rejects.toThrow("invalid RE2");
  });

  test("writes 0600 files under 0700 directories and detects hash tampering", async () => {
    const id = newContentId();
    await saveOmissionObjects([makeOmissionObject(id, "secret")]);
    const path = join(root, "data", "objects", id.slice(3, 5), `${id}.json`);
    if (process.platform !== "win32" && ((await stat(root)).mode & 0o777) !== 0o777) {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, "data", "objects", id.slice(3, 5)))).mode & 0o777).toBe(0o700);
    }
    const json = JSON.parse(await readFile(path, "utf8"));
    json.value = "tampered";
    await Bun.write(path, JSON.stringify(json));
    await expect(readOmittedContent(id, { config: DEFAULT_CONFIG })).rejects.toThrow("Integrity check");
  });
});

test("collects only structurally owned placeholder IDs", () => {
  const id = newContentId();
  const notice = omissionNotice("output omitted", 2, id);
  const rows: any[] = [
    { type: "user", isMeta: false, message: { content: `pasted ${notice}` } },
    {
      type: "user",
      message: { content: [{ type: "tool_result", content: notice }] },
    },
  ];
  expect(collectReferencedContentIds(rows)).toEqual([id]);
});

test("writes directly addressable objects and parses only exact notices", async () => {
  const id = newContentId();
  await saveOmissionObjects([
    makeOmissionObject(id, { exact: ["value"] }, { kind: "tool-output", metadata: { command: "x".repeat(1000) } }),
  ]);
  const notice = omissionNotice("Bash output omitted", 10, id);
  expect(parseOmissionNotice(notice)?.contentId).toBe(id);
  expect(parseOmissionNotice(`prefix ${notice}`)).toBeNull();
  const result = await readOmittedContent(id, { config: DEFAULT_CONFIG });
  expect(result?.text).toContain('"exact"');
  expect(JSON.stringify(result?.metadata).length).toBeLessThan(2100);
});

test("reports exact store bytes and attributable lineage usage without deleting data", async () => {
  const included = newContentId();
  const unrelated = newContentId();
  const missing = newContentId();
  const includedValue = "lineage payload".repeat(100);
  await saveOmissionObjects([
    makeOmissionObject(included, includedValue),
    makeOmissionObject(unrelated, "other payload"),
  ]);
  await saveManifest("active", [included, missing]);

  const usage = await omissionStorageUsage("active");
  expect(usage.objects.files).toBe(2);
  expect(usage.objects.bytes).toBeGreaterThan(includedValue.length);
  expect(usage.manifests.files).toBe(1);
  expect(usage.lineage).toMatchObject({
    sessionId: "active",
    manifestFound: true,
    referencedObjects: 2,
    presentObjects: 1,
    missingObjects: 1,
    payloadChars: includedValue.length,
  });
  expect(usage.lineage!.objectBytes).toBeLessThan(usage.objects.bytes);
  expect(usage.total.files).toBe(3);
});

test("detects full-envelope tampering and refuses object collisions", async () => {
  const id = newContentId();
  const object = makeOmissionObject(id, "original", { metadata: { toolName: "Bash" } });
  await saveOmissionObjects([object]);
  await expect(saveOmissionObjects([object])).rejects.toMatchObject({ code: "EEXIST" });
  const path = join(root, "data", "objects", id.slice(3, 5), `${id}.json`);
  const tampered = JSON.parse(await readFile(path, "utf8"));
  tampered.metadata.toolName = "forged";
  await writeFile(path, `${JSON.stringify(tampered)}\n`);
  await expect(readOmittedContent(id, { config: DEFAULT_CONFIG })).rejects.toThrow("Integrity check");
});

test("bounds full regex matches and reports missing IDs", async () => {
  const id = newContentId();
  await saveOmissionObjects([makeOmissionObject(id, "x".repeat(100000))]);
  const result = await searchOmittedContent({
    query: "[x]+",
    mode: "regex",
    contentIds: [id, newContentId()],
    maxMatches: 1,
    config: DEFAULT_CONFIG,
  });
  expect(String(result.matches[0]!.match).length).toBeLessThanOrEqual(500);
  expect(result.matches[0]!.matchTruncated).toBe(true);
  expect(result.complete).toBe(false);
  expect(result.missingContentIds).toHaveLength(1);
  expect(JSON.stringify(result).length).toBeLessThan(DEFAULT_CONFIG.retrieval.maxResponseChars);

  const mcpConfig = configForMcpResponse(DEFAULT_CONFIG);
  const manyMatches = await searchOmittedContent({
    query: "x{1000}",
    mode: "regex",
    contentIds: [id],
    maxMatches: 50,
    config: mcpConfig,
  });
  const response = boundedMcpTextResponse(manyMatches, DEFAULT_CONFIG.retrieval.maxResponseChars);
  expect(JSON.stringify(response).length).toBeLessThanOrEqual(DEFAULT_CONFIG.retrieval.maxResponseChars);
});
