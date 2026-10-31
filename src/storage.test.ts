import { afterEach, describe, expect, it, vi } from "vitest";
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseDocument } from "yaml";
import { MaterialStore, supplementPath, taskDirectory, ensureFolders } from "./storage";
import { normalizeSettings, validPreferences } from './config';
import type { App } from "obsidian";
import type { TaskContext } from "./companion-protocol";
const context: TaskContext = {
  bindingScope: "a".repeat(64),
  taskId: 42,
  sourceUrl: "https://example.test/post",
  contentVersion: "1:1",
  notePath: "main.md",
  daily: true,
};
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});
async function diskFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clip2md-storage-race-'));
  directories.push(root);
  const adapter = {
    getFullPath: (value: string) => path.join(root, value),
    stat: async (value: string) => {
      try {
        const entry = await fs.stat(path.join(root, value));
        return { type: entry.isDirectory() ? 'folder' : 'file' };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
  };
  const app = {
    vault: {
      adapter,
      // Simulate the file watcher lagging behind native media publication.
      getAbstractFileByPath: () => null,
      getFileByPath: () => null,
      createFolder: vi.fn(async (value: string) => { await fs.mkdir(path.join(root, value)); }),
      create: async (value: string, content: string) => fs.writeFile(path.join(root, value), content, { flag: 'wx' }),
    },
  } as unknown as App;
  return { root, app, store: new MaterialStore(app) };
}
describe('native media and Vault folder index coordination', () => {
  it('writes article text immediately after media creates folders, before the Vault index refreshes', async () => {
    const { root, app, store } = await diskFixture();
    const bytes = Buffer.from('downloaded image fixture'), source = path.join(root, 'source.png');
    await fs.writeFile(source, bytes);
    const image = await store.media(context, 'image', {
      path: source, bytes: bytes.length, extension: 'png',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }, new AbortController().signal);
    const body = `# 已采集正文\n\n![](${image})`;
    const note = await store.text(context, 'article', body);
    expect(app.vault.getAbstractFileByPath('_local/42')).toBeNull();
    expect(await fs.readFile(path.join(root, image))).toEqual(bytes);
    expect(await fs.readFile(path.join(root, note), 'utf8')).toBe(body);
  });
  it('does not mistake a conflicting file for an already-created folder', async () => {
    const { root, app } = await diskFixture();
    await fs.writeFile(path.join(root, '_local'), 'user file');
    await expect(ensureFolders(app, '_local/42/body.md')).rejects.toThrow('素材目录创建失败');
    expect(await fs.readFile(path.join(root, '_local'), 'utf8')).toBe('user file');
  });
  it('still reports a genuine directory creation failure', async () => {
    const { app } = await diskFixture();
    vi.mocked(app.vault.createFolder).mockRejectedValue(new Error('permission denied'));
    await expect(ensureFolders(app, '_local/42/body.md')).rejects.toThrow('素材目录创建失败');
  });
});
function fixture(folder:()=>string=()=> '') {
  const files = new Map<string, string>([["main.md", "main body"]]);
  const app = {
    vault: {
      getFileByPath: (path: string) => (files.has(path) ? { path } : null),
      getAbstractFileByPath: (path: string) =>
        files.has(path) ? { path } : null,
      getMarkdownFiles:()=>[...files.keys()].filter(path=>path.endsWith('.md')).map(path=>({path})),
      createFolder: async () => {},
      create: async (path: string, content: string) => files.set(path, content),
      process: async (file: { path: string }, update: (s: string) => string) =>
        files.set(file.path, update(files.get(file.path)!)),
    },
    fileManager: {
      generateMarkdownLink: () => "[[main]]",
      processFrontMatter: async (
        file: { path: string },
        update: (data: Record<string, unknown>) => void,
      ) => {
        const content = files.get(file.path)!,
          match = content.match(/^---\n([\s\S]*?)\n---/)!;
        const doc = parseDocument(match[1]);
        const values = doc.toJS();
        update(values);
        for (const [k, v] of Object.entries(values)) doc.set(k, v);
        files.set(
          file.path,
          "---\n" + doc.toString() + "---" + content.slice(match[0].length),
        );
      },
    },
  };
  return { files, store: new MaterialStore(app as unknown as App,folder) };
}
describe("supplement ownership and source properties", () => {
  it('uses the main plugin comment root and names local comments separately from cloud comments',async()=>{
    const f=fixture(()=> '统一资料');
    const c={...context,notePath:'主目录/作品.md',noteTitle:'作品标题',commentFolder:'评论/2026-10-24'};
    const comment=await f.store.text(c,'comments','# 本地评论 · 作品标题\n\n评论内容');
    expect(comment).toMatch(/^评论\/2026-10-24\/_local_review\/42\/本地评论 · 作品标题-/);
    const article=await f.store.text(c,'article','正文');
    expect(article).toMatch(/^统一资料\/_local\/42\//);
    expect(article).not.toContain('clip2md-');
    expect(f.files.get(comment)).toContain('# 本地评论 · 作品标题');
  });
  it('saves captured text and supplements beside the main note when the folder is blank',async()=>{
    const f=fixture(), c={...context,notePath:'剪藏/博主/主笔记.md'};
    expect(taskDirectory(c)).toBe('剪藏/博主/_local/42');
    const text=await f.store.text(c,'comments','抓取评论');
    const supplement=await f.store.supplement(c,'comments','正文',{});
    expect(text).toMatch(/^剪藏\/博主\/_local_review\/42\/[^/]+\.md$/);
    expect(supplement).toMatch(/^剪藏\/博主\/_local\/42\/[^/]+\.md$/);
    expect(f.files.get(text)).toBe('抓取评论');
    expect(taskDirectory(context)).toBe('_local/42');
  });
  it('supports a custom folder, root, and keeps an existing supplement after directory changes',async()=>{
    let folder='素材/抓取';const f=fixture(()=>folder);
    const text=await f.store.text(context,'subtitles','字幕');
    expect(text).toMatch(/^素材\/抓取\/_local\/42\/[^/]+\.md$/);
    const first=await f.store.supplement(context,'comments','原正文',{});
    folder='其他目录';
    expect(await f.store.supplement(context,'comments','新正文',{})).toBe(first);
    expect(f.files.get(first)).toContain('新正文');
    expect(taskDirectory(context,'/')).toBe('_local/42');
    expect(normalizeSettings({materialFolder:' 素材\\抓取 '}).materialFolder).toBe('素材/抓取');
    expect(normalizeSettings({}).materialFolder).toBe('');
    expect(validPreferences({materialFolder:'../outside'})).toBe(false);
    expect(()=>taskDirectory(context,'/tmp/private')).toThrow('相对路径');
    expect(()=>taskDirectory(context,'C:\\private')).toThrow('相对路径');
  });
  it("refuses a same-name private note without changing it", async () => {
    const f = fixture(),
      target = supplementPath(context);
    f.files.set(target, "My private note");
    await expect(
      f.store.supplement(context, "metadata", "body", { author: "a" }),
    ).rejects.toThrow("身份");
    expect(f.files.get(target)).toBe("My private note");
  });
  it("updates owned daily metadata while preserving user-modified values", async () => {
    const f = fixture(),
      target = await f.store.supplement(context, "metadata", "original", {
        author: "a",
      });
    await f.store.supplement(
      context,
      "metadata",
      "updated",
      { author: "b" },
      { author: "a" },
    );
    expect(f.files.get(target)).toContain("作者: b");
    f.files.set(
      target,
      f.files
        .get(target)!
        .replace("作者: b", "作者: user"),
    );
    await f.store.supplement(
      context,
      "metadata",
      "latest",
      { author: "c" },
      { author: "b" },
    );
    expect(f.files.get(target)).toContain("作者: user");
  });
  it("preserves edited managed text instead of silently replacing it", async () => {
    const f = fixture(),
      target = await f.store.supplement(context, "comments", "original", {
        author: "a",
      });
    f.files.set(
      target,
      f.files.get(target)!.replace("\noriginal\n", "\nuser edit\n"),
    );
    const before = f.files.get(target);
    await expect(
      f.store.supplement(
        context,
        "comments",
        "new",
        { author: "b" },
        { author: "a" },
      ),
    ).rejects.toThrow("编辑");
    expect(f.files.get(target)).toBe(before);
  });
});
