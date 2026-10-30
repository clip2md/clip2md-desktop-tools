import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
/** Raw authorization files must never be placed inside a synchronizable Vault. */
export async function withPrivateCookieFile<T>(
  content: string | undefined,
  use: (file: string | undefined) => Promise<T>,
): Promise<T> {
  if (content === undefined) return use(undefined);
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), `clipmd-auth-${process.pid}-`),
  );
  try {
    await fs.chmod(directory, 0o700);
    const file = path.join(directory, "cookies.txt");
    await fs.writeFile(file, content, { mode: 0o600, flag: "wx" });
    return await use(file);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
export async function cleanupAuthorizationFiles(
  directory = os.tmpdir(),
): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const match = entry.name.match(/^clipmd-auth-([1-9]\d*)-[A-Za-z0-9]+$/);
    if (!match || !entry.isDirectory()) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid)) continue;
    let dead = false;
    try {
      process.kill(pid, 0);
    } catch (error) {
      dead = (error as NodeJS.ErrnoException).code === "ESRCH";
    }
    if (dead)
      await fs.rm(path.join(directory, entry.name), {
        recursive: true,
        force: true,
      });
  }
}
