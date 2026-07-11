import { tmpdir } from "node:os";

export function testTmpdir(): string {
  const directory = tmpdir();
  if (process.platform === "linux" && process.env["WSL_DISTRO_NAME"] && directory.startsWith("/mnt/")) return "/tmp";
  return directory;
}
