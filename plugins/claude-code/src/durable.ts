import { open, rename } from "node:fs/promises";
import { dirname } from "node:path";

const UNSUPPORTED_DIRECTORY_SYNC = new Set(["EBADF", "EINVAL", "ENOTSUP", "EPERM", "EISDIR"]);

/** Flush a directory entry where the host filesystem supports directory fsync. */
export async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (!UNSUPPORTED_DIRECTORY_SYNC.has(code)) throw error;
  } finally {
    await handle?.close();
  }
}

export async function durableRename(from: string, to: string): Promise<void> {
  await rename(from, to);
  await syncDirectory(dirname(to));
}
