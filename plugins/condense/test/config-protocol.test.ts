import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_CONFIG, applyConfigValue, loadConfig } from "../src/config";
import { decodeReceipt, encodeReceipt, parseBuildDecision } from "../src/protocol";

const created: string[] = [];
const originalConfigHome = process.env["XDG_CONFIG_HOME"];
afterEach(async () => {
  if (originalConfigHome === undefined) delete process.env["XDG_CONFIG_HOME"]; else process.env["XDG_CONFIG_HOME"] = originalConfigHome;
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temp(): Promise<string> { const path = await mkdtemp("/tmp/condense-config-"); created.push(path); return path; }

describe("config", () => {
  test("loads built-in, global, nearest project, then invocation overrides", async () => {
    const root = await temp(); const configHome = join(root, "config"); const project = join(root, "project", "nested");
    process.env["XDG_CONFIG_HOME"] = configHome;
    await mkdir(join(configHome, "condense"), { recursive: true }); await mkdir(project, { recursive: true });
    await Bun.write(join(configHome, "condense", "config.json"), JSON.stringify({ keepTurns: 2, policies: { tools: "keep-all" } }));
    await Bun.write(join(root, "project", ".condense.json"), JSON.stringify({ policies: { thinking: "drop-all" }, retrieval: { defaultMatches: 3 } }));
    const config = await loadConfig(project, { keepTurns: 4, policies: { tools: "drop-ranked" } });
    expect(config.keepTurns).toBe(4); expect(config.policies.tools).toBe("drop-ranked"); expect(config.policies.thinking).toBe("drop-all"); expect(config.retrieval.defaultMatches).toBe(3);
  });

  test("fails clearly on unknown settings and inconsistent limits", () => {
    expect(() => applyConfigValue(DEFAULT_CONFIG, { typo: true }, "test.json")).toThrow("unknown setting");
    expect(() => applyConfigValue(DEFAULT_CONFIG, { retrieval: { defaultReadChars: 20, maxReadChars: 10 } }, "test.json")).toThrow("defaultReadChars");
  });
});

describe("receipt and decision schema", () => {
  const payload = { sessionId: "s", cutoffUuid: "u", keepTurns: 1, policies: DEFAULT_CONFIG.policies, sourceDigest: "a".repeat(64), candidateDigest: "b".repeat(64) };
  test("round-trips an opaque receipt", () => expect(decodeReceipt(encodeReceipt(payload))).toEqual(payload));
  test("rejects malformed decisions", () => {
    expect(() => parseBuildDecision({ keep: [] })).toThrow("receipt");
    expect(() => parseBuildDecision({ receipt: "x", keep: ["a", "a"] })).toThrow("duplicate");
    expect(() => parseBuildDecision({ receipt: "x", keep: ["a"], drop: ["a"] })).toThrow("both");
    expect(() => parseBuildDecision({ receipt: "x", unexpected: true })).toThrow("unknown build field");
  });
});
