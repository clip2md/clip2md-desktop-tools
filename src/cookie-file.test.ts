import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  withPrivateCookieFile,
  cleanupAuthorizationFiles,
} from "./cookie-file";
describe("temporary credential files outside the Vault", () => {
  it("restricts permissions and removes the raw file even when the tool fails", async () => {
    let file = "";
    await expect(
      withPrivateCookieFile("synthetic-cookie", async (target) => {
        file = target!;
        expect(path.dirname(file).startsWith(os.tmpdir())).toBe(true);
        if (process.platform !== "win32") {
          expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
          expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
        }
        throw new Error("cancelled");
      }),
    ).rejects.toThrow("cancelled");
    await expect(fs.access(file)).rejects.toThrow();
  });
  it("does not create an authorization file for public extraction", async () => {
    expect(
      await withPrivateCookieFile(undefined, async (file) => file),
    ).toBeUndefined();
  });
  it("cleans only dead owned directories and preserves active sessions and unrelated files", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "clipmd-auth-cleanup-test-"),
    );
    const dead = path.join(directory, "clipmd-auth-2147483647-owned"),
      active = path.join(directory, `clipmd-auth-${process.pid}-active`),
      other = path.join(directory, "private-user-data");
    try {
      for (const target of [dead, active, other]) {
        await fs.mkdir(target);
        await fs.writeFile(path.join(target, "data"), "test");
      }
      await cleanupAuthorizationFiles(directory);
      await expect(fs.access(dead)).rejects.toThrow();
      await expect(fs.access(active)).resolves.toBeUndefined();
      await expect(fs.access(other)).resolves.toBeUndefined();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
