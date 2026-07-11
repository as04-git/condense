import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const pluginRoot = dirname(import.meta.dir);
const fixtureRoot = await mkdtemp(join(tmpdir(), "condense-clean-plugin-"));
const dataRoot = await mkdtemp(join(tmpdir(), "condense-clean-data-"));
const storeRoot = await mkdtemp(join(tmpdir(), "condense-clean-store-"));

try {
  await Promise.all([
    cp(join(pluginRoot, "src"), join(fixtureRoot, "src"), { recursive: true }),
    cp(join(pluginRoot, "runtime"), join(fixtureRoot, "runtime"), { recursive: true }),
  ]);
  const command = [
    process.execPath,
    "--no-install",
    join(fixtureRoot, "src", "bootstrap.ts"),
    "condense",
    dataRoot,
    "storage",
  ];
  const run = async () => {
    const child = Bun.spawn(command, {
      env: { ...process.env, CONDENSE_DATA_HOME: storeRoot },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) throw new Error(`clean bootstrap failed (${exitCode}): ${stderr}`);
    return JSON.parse(stdout) as { root: string };
  };

  const first = await run();
  if (first.root !== storeRoot) throw new Error("clean bootstrap did not execute the Condense CLI");
  const stampPath = join(dataRoot, "runtime", "condense-runtime.json");
  const firstStamp = await readFile(stampPath, "utf8");
  await run();
  const secondStamp = await readFile(stampPath, "utf8");
  if (firstStamp !== secondStamp) throw new Error("unchanged bootstrap inputs unexpectedly reinstalled dependencies");

  const mcp = Bun.spawn([process.execPath, "--no-install", join(fixtureRoot, "src", "bootstrap.ts"), "mcp", dataRoot], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  mcp.stdin.end();
  const mcpStdout = new Response(mcp.stdout).text();
  const mcpStderr = new Response(mcp.stderr).text();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const mcpExit = await Promise.race([
    mcp.exited,
    new Promise<number>((resolve) => {
      timeout = setTimeout(() => {
        mcp.kill();
        resolve(-1);
      }, 5000);
    }),
  ]);
  clearTimeout(timeout);
  const [mcpOutput, mcpErrors] = await Promise.all([mcpStdout, mcpStderr]);
  if (mcpExit !== 0) {
    throw new Error(`clean bootstrap MCP smoke failed with exit code ${mcpExit}: ${mcpErrors || mcpOutput}`);
  }
  console.log("clean runtime bootstrap smoke passed");
} finally {
  await Promise.all([
    rm(fixtureRoot, { recursive: true, force: true }),
    rm(dataRoot, { recursive: true, force: true }),
    rm(storeRoot, { recursive: true, force: true }),
  ]);
}
