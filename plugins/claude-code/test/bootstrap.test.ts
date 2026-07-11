import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureRuntime } from "../src/bootstrap";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporary(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  created.push(path);
  return path;
}

test("runtime bootstrap serializes installation and refreshes only when its inputs change", async () => {
  const pluginRoot = await temporary("condense-bootstrap-plugin-");
  const dataRoot = await temporary("condense-bootstrap-data-");
  await writeFile(join(pluginRoot, "package.json"), JSON.stringify({ name: "fixture", dependencies: {} }));
  await writeFile(join(pluginRoot, "bun.lock"), "fixture-lock-v1");
  await mkdir(join(pluginRoot, "src"));
  await writeFile(join(pluginRoot, "src", "fixture.ts"), "export const fixture = 1;\n");
  let installs = 0;
  const installer = async (stagingDirectory: string) => {
    installs++;
    await Bun.sleep(20);
    await mkdir(join(stagingDirectory, "node_modules", "@anthropic-ai", "claude-agent-sdk"), { recursive: true });
    await mkdir(join(stagingDirectory, "node_modules", "@modelcontextprotocol", "sdk"), { recursive: true });
    await mkdir(join(stagingDirectory, "node_modules", "re2js"), { recursive: true });
    await writeFile(join(stagingDirectory, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"), "{}");
    await writeFile(join(stagingDirectory, "node_modules", "@modelcontextprotocol", "sdk", "package.json"), "{}");
    await writeFile(join(stagingDirectory, "node_modules", "re2js", "package.json"), "{}");
  };

  const [first, second] = await Promise.all([
    ensureRuntime({ pluginRoot, dataRoot, installer }),
    ensureRuntime({ pluginRoot, dataRoot, installer }),
  ]);
  expect(first).toBe(second);
  expect(installs).toBe(1);

  await ensureRuntime({ pluginRoot, dataRoot, installer });
  expect(installs).toBe(1);

  await writeFile(join(pluginRoot, "bun.lock"), "fixture-lock-v2");
  await ensureRuntime({ pluginRoot, dataRoot, installer });
  expect(installs).toBe(2);

  await writeFile(join(pluginRoot, "src", "fixture.ts"), "export const fixture = 2;\n");
  await ensureRuntime({ pluginRoot, dataRoot, installer });
  expect(installs).toBe(3);
});
