import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { isRecord } from "./transcript";

export const RETENTION_MODES = ["keep-all", "keep-ranked", "drop-ranked", "drop-all"] as const;
export type RetentionMode = (typeof RETENTION_MODES)[number];
export type PolicyClass = "thinking" | "tools" | "agentResults" | "skills" | "injections";

export type CondenseConfig = {
  keepTurns: number;
  policies: Record<PolicyClass, RetentionMode>;
  analysis: {
    maxPageChars: number;
  };
  retrieval: {
    defaultReadChars: number;
    maxReadChars: number;
    minQueryChars: number;
    caseSensitive: boolean;
    defaultContextLines: number;
    maxContextLines: number;
    defaultMatches: number;
    maxMatches: number;
    maxExcerptChars: number;
    allowRegex: boolean;
    maxRegexPatternChars: number;
    maxResponseChars: number;
  };
};

export type ConfigOverrides = {
  keepTurns?: number;
  policies?: Partial<Record<PolicyClass, RetentionMode>>;
};

export const DEFAULT_CONFIG: CondenseConfig = {
  keepTurns: 1,
  policies: {
    thinking: "drop-ranked",
    tools: "keep-ranked",
    agentResults: "drop-ranked",
    skills: "drop-all",
    injections: "keep-ranked",
  },
  analysis: {
    maxPageChars: 12000,
  },
  retrieval: {
    defaultReadChars: 8000,
    maxReadChars: 50000,
    minQueryChars: 2,
    caseSensitive: false,
    defaultContextLines: 2,
    maxContextLines: 10,
    defaultMatches: 10,
    maxMatches: 50,
    maxExcerptChars: 4000,
    allowRegex: true,
    maxRegexPatternChars: 500,
    maxResponseChars: 50000,
  },
};

const POLICY_KEYS = new Set<PolicyClass>(["thinking", "tools", "agentResults", "skills", "injections"]);
const RETRIEVAL_KEYS = new Set(Object.keys(DEFAULT_CONFIG.retrieval));
const ANALYSIS_KEYS = new Set(Object.keys(DEFAULT_CONFIG.analysis));
const ROOT_KEYS = new Set(["keepTurns", "policies", "analysis", "retrieval"]);

function configHome(): string {
  return process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config");
}

export function globalConfigPath(): string {
  return join(configHome(), "condense", "config.json");
}

export function findProjectConfig(start: string): string | null {
  let current = resolve(start || process.cwd());
  const root = parse(current).root;
  while (true) {
    const candidate = join(current, ".condense.json");
    if (existsSync(candidate)) return candidate;
    if (current === root) return null;
    current = dirname(current);
  }
}

function assertKeys(value: Record<string, unknown>, allowed: Set<string>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${path}: unknown setting "${key}"`);
  }
}

function integer(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${path}: expected an integer between ${min} and ${max}`);
  }
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path}: expected a boolean`);
  return value;
}

function mode(value: unknown, path: string): RetentionMode {
  if (!(RETENTION_MODES as readonly unknown[]).includes(value)) {
    throw new Error(`${path}: expected one of ${RETENTION_MODES.join(", ")}`);
  }
  return value as RetentionMode;
}

export function applyConfigValue(base: CondenseConfig, raw: unknown, path: string): CondenseConfig {
  if (!isRecord(raw)) throw new Error(`${path}: expected a JSON object`);
  assertKeys(raw, ROOT_KEYS, path);
  const next: CondenseConfig = {
    keepTurns: base.keepTurns,
    policies: { ...base.policies },
    analysis: { ...base.analysis },
    retrieval: { ...base.retrieval },
  };
  if (raw["keepTurns"] !== undefined) next.keepTurns = integer(raw["keepTurns"], `${path}.keepTurns`, 0, 10000);
  if (raw["policies"] !== undefined) {
    if (!isRecord(raw["policies"])) throw new Error(`${path}.policies: expected an object`);
    assertKeys(raw["policies"], POLICY_KEYS, `${path}.policies`);
    for (const [key, value] of Object.entries(raw["policies"])) {
      next.policies[key as PolicyClass] = mode(value, `${path}.policies.${key}`);
    }
  }
  if (raw["analysis"] !== undefined) {
    if (!isRecord(raw["analysis"])) throw new Error(`${path}.analysis: expected an object`);
    assertKeys(raw["analysis"], ANALYSIS_KEYS, `${path}.analysis`);
    if (raw["analysis"]["maxPageChars"] !== undefined) {
      next.analysis.maxPageChars = integer(raw["analysis"]["maxPageChars"], `${path}.analysis.maxPageChars`, 4000, 50000);
    }
  }
  if (raw["retrieval"] !== undefined) {
    if (!isRecord(raw["retrieval"])) throw new Error(`${path}.retrieval: expected an object`);
    assertKeys(raw["retrieval"], RETRIEVAL_KEYS, `${path}.retrieval`);
    const r = raw["retrieval"];
    const intRules: Record<string, [number, number]> = {
      defaultReadChars: [1, 200000], maxReadChars: [1, 200000], minQueryChars: [1, 100],
      defaultContextLines: [0, 50], maxContextLines: [0, 50], defaultMatches: [1, 200],
      maxMatches: [1, 200], maxExcerptChars: [1, 50000], maxRegexPatternChars: [1, 2000],
      maxResponseChars: [1000, 200000],
    };
    for (const [key, value] of Object.entries(r)) {
      if (key === "caseSensitive" || key === "allowRegex") {
        (next.retrieval as Record<string, unknown>)[key] = boolean(value, `${path}.retrieval.${key}`);
      } else {
        const rule = intRules[key];
        if (!rule) throw new Error(`${path}.retrieval: unknown numeric setting "${key}"`);
        const [min, max] = rule;
        (next.retrieval as Record<string, unknown>)[key] = integer(value, `${path}.retrieval.${key}`, min, max);
      }
    }
  }
  if (next.retrieval.defaultReadChars > next.retrieval.maxReadChars) throw new Error(`${path}: defaultReadChars must be <= maxReadChars`);
  if (next.retrieval.defaultContextLines > next.retrieval.maxContextLines) throw new Error(`${path}: defaultContextLines must be <= maxContextLines`);
  if (next.retrieval.defaultMatches > next.retrieval.maxMatches) throw new Error(`${path}: defaultMatches must be <= maxMatches`);
  return next;
}

async function applyFile(base: CondenseConfig, path: string | null): Promise<CondenseConfig> {
  if (!path || !existsSync(path)) return base;
  let raw: unknown;
  try { raw = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { throw new Error(`${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`); }
  return applyConfigValue(base, raw, path);
}

export async function loadConfig(projectCwd: string, overrides: ConfigOverrides = {}): Promise<CondenseConfig> {
  let config = await applyFile(DEFAULT_CONFIG, globalConfigPath());
  config = await applyFile(config, findProjectConfig(projectCwd));
  if (overrides.keepTurns !== undefined) config.keepTurns = integer(overrides.keepTurns, "invocation.keepTurns", 0, 10000);
  for (const [key, value] of Object.entries(overrides.policies ?? {})) {
    config.policies[key as PolicyClass] = mode(value, `invocation.policies.${key}`);
  }
  return config;
}
