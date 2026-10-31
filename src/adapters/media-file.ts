/** Publish an optional large original without buffering it into the JS heap. */
import fs from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Vault } from "obsidian";
import type { DownloadedMedia } from "./media-download";

async function fingerprint(file: string, signal: AbortSignal) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    signal.throwIfAborted();
    bytes += chunk.length;
    hash.update(chunk);
  }
  signal.throwIfAborted();
  return { bytes, sha256: hash.digest("hex") };
}
export async function saveMediaOriginalFile(
  vault: Vault,
  target: string,
  source: DownloadedMedia,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const adapter = vault.adapter as { getFullPath?: (name: string) => string };
  if (!adapter.getFullPath) throw new Error("当前Vault不能保存大媒体原件");
  if (
    !target ||
    target.startsWith("/") ||
    target.includes("\\") ||
    target.split("/").some((part) => !part || [".", ".."].includes(part))
  )
    throw new Error("媒体原件必须保存在Vault内");
  const root = path.resolve(adapter.getFullPath("")),
    destination = path.resolve(adapter.getFullPath(target));
  const relative = path.relative(root, destination);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("媒体原件目录超出Vault");
  // Our generated paths may still encounter a user-created symlink or folder conflict.
  const parts = target.split("/");
  parts.pop();
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      await fs.mkdir(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const state = await fs.lstat(current);
    if (state.isSymbolicLink() || !state.isDirectory())
      throw new Error("媒体目录被链接或文件占用，已有内容已保留");
  }
  try {
    const state = await fs.lstat(destination);
    if (!state.isFile() || state.isSymbolicLink())
      throw new Error("媒体原件路径已被占用");
    const old = await fingerprint(destination, signal);
    if (old.bytes !== source.bytes || old.sha256 !== source.sha256)
      throw new Error("同名媒体原件内容不同，已有文件已保留");
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const staged = path.join(
    path.dirname(destination),
    `.clip2md-media-${randomUUID()}.tmp`,
  );
  try {
    await fs.copyFile(source.path, staged, constants.COPYFILE_EXCL);
    const result = await fingerprint(staged, signal);
    if (result.bytes !== source.bytes || result.sha256 !== source.sha256)
      throw new Error("媒体原件复制校验失败");
    const file = await fs.open(staged, "r+");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    signal.throwIfAborted();
    // Hard-link publication is complete and exclusive on the same filesystem.
    // Obsidian's file watcher observes the finished original, never partial bytes.
    await fs.link(staged, destination);
  } finally {
    await fs.rm(staged, { force: true });
  }
}
