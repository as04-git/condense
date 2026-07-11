import { createHash, randomBytes } from "node:crypto";
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { isRecord } from "./transcript";

const BOOTSTRAP_VERSION = 1;
const LOCK_TIMEOUT_MS = 2 * 60 * 1000;
const ABANDONED_LOCK_MS = 5 * 60 * 1000;

type RuntimeStamp = {
  version: 1;
  fingerprint: string;
  installedAt: string;
};

export type RuntimeInstaller = (stagingDirectory: string) => Promise<void>;

function errorCode(error: unknown): string {
  return isRecord(error) && typeof error["code"] === "string" ? error["code"] : "";
}

async function fingerprint(pluginRoot: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(`bootstrap=${BOOTSTRAP_VERSION}\nplatform=${process.platform}\narch=${process.arch}\n`);
  hash.update(await readFile(join(pluginRoot, "package.json")));
  hash.update(await readFile(join(pluginRoot, "bun.lock")));
  const sourceRoot = join(pluginRoot, "src");
  for (const name of (await readdir(sourceRoot)).filter((value) => value.endsWith(".ts")).sort()) {
    hash.update(`\n${name}\n`);
    hash.update(await readFile(join(sourceRoot, name)));
  }
  return hash.digest("hex");
}

async function readStamp(runtimeDirectory: string): Promise<RuntimeStamp | null> {
  try {
    const value: unknown = JSON.parse(await readFile(join(runtimeDirectory, "condense-runtime.json"), "utf8"));
    if (
      !isRecord(value) ||
      value["version"] !== 1 ||
      typeof value["fingerprint"] !== "string" ||
      typeof value["installedAt"] !== "string"
    ) {
      return null;
    }
    return value as RuntimeStamp;
  } catch {
    return null;
  }
}

async function runtimeReady(runtimeDirectory: string, expectedFingerprint: string): Promise<boolean> {
  const stamp = await readStamp(runtimeDirectory);
  if (stamp?.fingerprint !== expectedFingerprint) return false;
  return (
    (await Bun.file(
      join(runtimeDirectory, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"),
    ).exists()) &&
    (await Bun.file(join(runtimeDirectory, "node_modules", "@modelcontextprotocol", "sdk", "package.json")).exists()) &&
    (await Bun.file(join(runtimeDirectory, "node_modules", "re2js", "package.json")).exists())
  );
}

async function defaultInstaller(stagingDirectory: string): Promise<void> {
  console.error("Condense: installing pinned runtime dependencies (first use or update)…");
  const child = Bun.spawn(
    [
      process.execPath,
      "install",
      "--silent",
      "--frozen-lockfile",
      "--production",
      "--omit=optional",
      "--ignore-scripts",
    ],
    { cwd: stagingDirectory, stdin: "ignore", stdout: "inherit", stderr: "inherit" },
  );
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Bun dependency installation failed with exit code ${exitCode}`);
  console.error("Condense: runtime dependencies ready.");
}

async function acquireInstallLock(lockDirectory: string, runtimeDirectory: string, expected: string): Promise<boolean> {
  const started = Date.now();
  while (true) {
    if (await runtimeReady(runtimeDirectory, expected)) return false;
    try {
      await mkdir(lockDirectory);
      return true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    try {
      const age = Date.now() - (await stat(lockDirectory)).mtimeMs;
      if (age > ABANDONED_LOCK_MS) {
        const abandoned = `${lockDirectory}.abandoned-${randomBytes(8).toString("base64url")}`;
        try {
          await rename(lockDirectory, abandoned);
          await rm(abandoned, { recursive: true, force: true });
          continue;
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    if (Date.now() - started > LOCK_TIMEOUT_MS) {
      throw new Error("Timed out waiting for another Condense process to install runtime dependencies");
    }
    await Bun.sleep(100);
  }
}

export async function ensureRuntime(options: {
  pluginRoot: string;
  dataRoot: string;
  installer?: RuntimeInstaller;
}): Promise<string> {
  const expected = await fingerprint(options.pluginRoot);
  const runtimeDirectory = join(options.dataRoot, "runtime");
  if (await runtimeReady(runtimeDirectory, expected)) return runtimeDirectory;
  await mkdir(options.dataRoot, { recursive: true, mode: 0o700 });
  const lockDirectory = join(options.dataRoot, "runtime-install.lock");
  if (!(await acquireInstallLock(lockDirectory, runtimeDirectory, expected))) return runtimeDirectory;

  const suffix = `${process.pid}-${randomBytes(8).toString("base64url")}`;
  const stagingDirectory = join(options.dataRoot, `runtime.staging-${suffix}`);
  const previousDirectory = join(options.dataRoot, `runtime.previous-${suffix}`);
  try {
    await mkdir(stagingDirectory, { recursive: false, mode: 0o700 });
    await Promise.all([
      copyFile(join(options.pluginRoot, "package.json"), join(stagingDirectory, "package.json")),
      copyFile(join(options.pluginRoot, "bun.lock"), join(stagingDirectory, "bun.lock")),
    ]);
    await (options.installer ?? defaultInstaller)(stagingDirectory);
    await cp(join(options.pluginRoot, "src"), join(stagingDirectory, "src"), { recursive: true });
    const stamp: RuntimeStamp = {
      version: 1,
      fingerprint: expected,
      installedAt: new Date().toISOString(),
    };
    await writeFile(join(stagingDirectory, "condense-runtime.json"), `${JSON.stringify(stamp)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      await rename(runtimeDirectory, previousDirectory);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    await rename(stagingDirectory, runtimeDirectory);
    await rm(previousDirectory, { recursive: true, force: true });
    return runtimeDirectory;
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
    await rm(lockDirectory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const [targetName, dataRoot, ...args] = Bun.argv.slice(2);
  if ((targetName !== "condense" && targetName !== "mcp") || !dataRoot || dataRoot.includes("${")) {
    throw new Error("usage: bun bootstrap.ts <condense|mcp> <CLAUDE_PLUGIN_DATA> [arguments]");
  }
  const pluginRoot = dirname(import.meta.dir);
  const runtimeDirectory = await ensureRuntime({ pluginRoot, dataRoot });
  const target = join(runtimeDirectory, "src", targetName === "mcp" ? "mcp.ts" : "condense.ts");
  const nodePath = [join(runtimeDirectory, "node_modules"), process.env["NODE_PATH"]].filter(Boolean).join(delimiter);
  const child = Bun.spawn([process.execPath, "--no-install", target, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_PATH: nodePath },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const forwardInterrupt = () => child.kill("SIGINT");
  const forwardTerminate = () => child.kill("SIGTERM");
  process.once("SIGINT", forwardInterrupt);
  process.once("SIGTERM", forwardTerminate);
  const exitCode = await child.exited;
  process.off("SIGINT", forwardInterrupt);
  process.off("SIGTERM", forwardTerminate);
  process.exitCode = exitCode;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`condense bootstrap: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
