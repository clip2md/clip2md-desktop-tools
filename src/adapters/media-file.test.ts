import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { saveMediaOriginalFile } from "./media-file";
const directories: string[] = [];
async function setup() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "clip2md-original-file-"),
  );
  directories.push(directory);
  const vaultRoot = path.join(directory, "vault");
  await fs.mkdir(vaultRoot);
  const source = path.join(directory, "source.wav"),
    bytes = Buffer.from("validated original bytes");
  await fs.writeFile(source, bytes);
  return {
    vault: {
      adapter: { getFullPath: (value: string) => path.join(vaultRoot, value) },
    } as any,
    vaultRoot,
    source: {
      path: source,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      extension: "wav",
    },
    bytes,
  };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0))
    await fs.rm(dir, { recursive: true, force: true });
});
it("publishes verified originals exclusively and reuses unchanged files without rewriting", async () => {
  const { vault, vaultRoot, source, bytes } = await setup(),
    signal = new AbortController().signal;
  await saveMediaOriginalFile(
    vault,
    "附件/task-1/original.wav",
    source,
    signal,
  );
  const file = path.join(vaultRoot, "附件/task-1/original.wav"),
    before = await fs.stat(file);
  await saveMediaOriginalFile(
    vault,
    "附件/task-1/original.wav",
    source,
    signal,
  );
  expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs);
  expect(await fs.readFile(file)).toEqual(bytes);
  await fs.writeFile(file, "用户修改");
  await expect(
    saveMediaOriginalFile(vault, "附件/task-1/original.wav", source, signal),
  ).rejects.toThrow("已有文件已保留");
  expect(await fs.readFile(file, "utf8")).toBe("用户修改");
});
it("does not publish an original changed after download verification", async () => {
  const { vault, vaultRoot, source } = await setup();
  await fs.writeFile(source.path, "tampered");
  await expect(
    saveMediaOriginalFile(
      vault,
      "assets/original.wav",
      source,
      new AbortController().signal,
    ),
  ).rejects.toThrow("校验失败");
  expect(await fs.readdir(path.join(vaultRoot, "assets"))).toEqual([]);
});
it("does not traverse a Vault symlink into an external directory", async () => {
  const { vault, vaultRoot, source } = await setup(),
    outside = path.join(path.dirname(vaultRoot), "outside");
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(vaultRoot, "linked"));
  await expect(
    saveMediaOriginalFile(
      vault,
      "linked/original.wav",
      source,
      new AbortController().signal,
    ),
  ).rejects.toThrow("链接");
  expect(await fs.readdir(outside)).toEqual([]);
});
it("preserves a user file created during publication and removes only its own staging file", async () => {
  const { vault, vaultRoot, source } = await setup(),
    link = fs.link.bind(fs);
  vi.spyOn(fs, "link").mockImplementationOnce(async (from, to) => {
    await fs.writeFile(to, "用户抢先创建");
    await link(from, to);
  });
  await expect(
    saveMediaOriginalFile(
      vault,
      "assets/original.wav",
      source,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(
    await fs.readFile(path.join(vaultRoot, "assets/original.wav"), "utf8"),
  ).toBe("用户抢先创建");
  expect(await fs.readdir(path.join(vaultRoot, "assets"))).toEqual([
    "original.wav",
  ]);
});
