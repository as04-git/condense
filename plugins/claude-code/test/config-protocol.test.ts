import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_CONFIG, applyConfigValue, loadConfig } from "../src/config";
import { parseBuildRequest, parseInspectRequest, parsePrepareDecision } from "../src/protocol";
import { testTmpdir } from "./temp";

const created: string[] = [];
const originalConfigHome = process.env["XDG_CONFIG_HOME"];
afterEach(async () => {
  if (originalConfigHome === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = originalConfigHome;
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temp(): Promise<string> {
  const path = await mkdtemp(join(testTmpdir(), "condense-config-"));
  created.push(path);
  return path;
}

describe("config", () => {
  test("loads built-in, global, nearest project, then invocation overrides", async () => {
    const root = await temp();
    const configHome = join(root, "config");
    const project = join(root, "project", "nested");
    process.env["XDG_CONFIG_HOME"] = configHome;
    await mkdir(join(configHome, "condense"), { recursive: true });
    await mkdir(project, { recursive: true });
    await Bun.write(
      join(configHome, "condense", "config.json"),
      JSON.stringify({ keepTurns: 2, policies: { tools: "keep-all" } }),
    );
    await Bun.write(
      join(root, "project", ".condense.json"),
      JSON.stringify({ policies: { thinking: "drop-all" }, retrieval: { defaultMatches: 3 } }),
    );
    const config = await loadConfig(project, { keepTurns: 4, policies: { tools: "drop-ranked" } });
    expect(config.keepTurns).toBe(4);
    expect(config.policies.tools).toBe("drop-ranked");
    expect(config.policies.thinking).toBe("drop-all");
    expect(config.retrieval.defaultMatches).toBe(3);
  });

  test("fails clearly on unknown settings and inconsistent limits", () => {
    expect(() => applyConfigValue(DEFAULT_CONFIG, { typo: true }, "test.json")).toThrow("unknown setting");
    expect(() =>
      applyConfigValue(DEFAULT_CONFIG, { retrieval: { defaultReadChars: 20, maxReadChars: 10 } }, "test.json"),
    ).toThrow("defaultReadChars");
  });
});

describe("workflow request schemas", () => {
  test("rejects malformed decisions", () => {
    expect(() => parsePrepareDecision({ keep: [] })).toThrow("receipt");
    expect(() => parsePrepareDecision({ receipt: "x", keep: ["a", "a"] })).toThrow("duplicate");
    expect(() => parsePrepareDecision({ receipt: "x", keep: ["a"], drop: ["a"] })).toThrow("both");
    expect(() => parsePrepareDecision({ receipt: "x", unexpected: true })).toThrow("unknown build field");
  });
  test("requires inspect cursor or refs and build plan only", () => {
    expect(() => parseInspectRequest({ receipt: "x" })).toThrow("cursor or refs");
    expect(() => parseInspectRequest({ receipt: "x", cursor: "p_1", refs: ["o:x"] })).toThrow("mutually exclusive");
    expect(parseBuildRequest({ plan: "bp_x" })).toEqual({ plan: "bp_x" });
    expect(() => parseBuildRequest({ receipt: "x", keep: [] })).toThrow("prepared plan");
  });
});
