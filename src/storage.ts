import { FileSystemAdapter, type App } from "obsidian";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseDocument, stringify } from "yaml";
import { saveMediaOriginalFile } from "./adapters/media-file";
import type { DownloadedMedia } from "./adapters/media-download";
import { LOCAL_PROPERTY_NAMES, type LocalField, type TaskContext, type LocalProperties } from "./companion-protocol";
import { validMaterialFolder, type Feature } from "./config";
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function taskDirectory(context: TaskContext, configuredFolder=''): string {
    if(!validMaterialFolder(configuredFolder))throw new Error('资料目录必须是当前知识库内的相对路径');
    const folder=configuredFolder.trim().replace(/\\/g,'/');
    const resolved=folder ? folder.replace(/^\/+|\/+$/g,'') : context.notePath.split('/').slice(0,-1).join('/');
    if(!validMaterialFolder(resolved))throw new Error('主笔记目录必须位于当前知识库');
    return [resolved,'_local',String(context.taskId)].filter(Boolean).join('/');
}
export function reviewTaskDirectory(context: TaskContext, configuredFolder=''): string {
    if(!validMaterialFolder(configuredFolder))throw new Error('评论目录必须是当前知识库内的相对路径');
    const folder=configuredFolder.trim().replace(/\\/g,'/');
    const resolved=folder ? folder.replace(/^\/+|\/+$/g,'') : context.notePath.split('/').slice(0,-1).join('/');
    if(!validMaterialFolder(resolved))throw new Error('主笔记目录必须位于当前知识库');
    return [resolved,'_local_review',String(context.taskId)].filter(Boolean).join('/');
}
export function supplementPath(context: TaskContext, configuredFolder=''): string {
    return [taskDirectory(context,configuredFolder),`${context.taskId}-本地资料.md`].filter(Boolean).join('/');
}
export async function ensureFolders(app: App, target: string): Promise<void> {
    let folder = "";
    for (const segment of target.split("/").slice(0, -1)) {
        folder = folder ? folder + "/" + segment : segment;
        if (!app.vault.getAbstractFileByPath(folder)) {
            try {
                await app.vault.createFolder(folder);
            }
            catch {
                // Native media writes can create a directory before Obsidian's
                // file watcher has added it to the in-memory Vault index.
                const diskEntry = await app.vault.adapter.stat(folder).catch(() => null);
                if (!app.vault.getAbstractFileByPath(folder) && diskEntry?.type !== 'folder')
                    throw new Error("素材目录创建失败");
            }
        }
    }
}
export class MaterialStore {
    constructor(private readonly app: App, private readonly configuredFolder:()=>string=()=> '') { }
    async cleanupCache(): Promise<void> {
        if (!(this.app.vault.adapter instanceof FileSystemAdapter))
            return;
        const base = path.join(this.app.vault.adapter.getBasePath(), ".clip2md-desktop-cache");
        let entries: string[];
        try {
            const stat = await fs.lstat(base);
            if (stat.isSymbolicLink() || !stat.isDirectory())
                throw new Error("缓存目录不安全");
            entries = await fs.readdir(base);
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
                return;
            throw error;
        }
        for (const name of entries) {
            if (!/^\d+-[A-Za-z0-9]+$/.test(name))
                continue;
            const directory = path.join(base, name);
            const stat = await fs.lstat(directory);
            if (stat.isSymbolicLink() || !stat.isDirectory())
                continue;
            let owner: {
                pid?: number;
            };
            try {
                owner = JSON.parse(await fs.readFile(path.join(directory, "owner.json"), "utf8")) as {
                    pid?: number;
                };
            }
            catch {
                continue;
            }
            if (!Number.isSafeInteger(owner.pid) || owner.pid! <= 0)
                continue;
            let dead = false;
            try {
                process.kill(owner.pid!, 0);
            }
            catch (error) {
                dead = (error as NodeJS.ErrnoException).code === "ESRCH";
            }
            if (dead)
                await fs.rm(directory, { recursive: true, force: true });
        }
    }
    async localFile(reference: string): Promise<string> {
        if (!(this.app.vault.adapter instanceof FileSystemAdapter) ||
            reference.startsWith("/") ||
            reference.includes("\\") ||
            reference.split("/").some((p) => !p || p === "." || p === ".."))
            throw new Error("素材路径必须位于当前 Vault");
        const root = await fs.realpath(this.app.vault.adapter.getBasePath()), target = await fs.realpath(path.join(root, reference));
        const relative = path.relative(root, target);
        if (relative.startsWith("..") || path.isAbsolute(relative))
            throw new Error("素材路径超出当前 Vault");
        return target;
    }
    async manifest(assets: string[], signal: AbortSignal): Promise<Array<{
        path: string;
        sha256: string;
    }>> {
        const result: Array<{
            path: string;
            sha256: string;
        }> = [];
        for (const reference of assets) {
            signal.throwIfAborted();
            const file = await this.localFile(reference);
            const fingerprint = createHash("sha256");
            for await (const chunk of createReadStream(file)) {
                signal.throwIfAborted();
                fingerprint.update(chunk as Buffer);
            }
            result.push({ path: reference, sha256: fingerprint.digest("hex") });
        }
        return result;
    }
    async cache(context: TaskContext): Promise<string> {
        if (!(this.app.vault.adapter instanceof FileSystemAdapter))
            throw new Error("当前 Vault 不支持桌面文件处理");
        const root = this.app.vault.adapter.getBasePath();
        // Cache is inside this Vault, outside the Obsidian configuration directory.
        const base = path.join(root, ".clip2md-desktop-cache");
        await fs.mkdir(base, { recursive: true, mode: 0o700 });
        const stat = await fs.lstat(base);
        if (stat.isSymbolicLink() || !stat.isDirectory())
            throw new Error("缓存目录被链接或文件占用");
        const directory = await fs.mkdtemp(path.join(base, `${context.taskId}-`));
        await fs.writeFile(path.join(directory, "owner.json"), JSON.stringify({ pid: process.pid }), { mode: 0o600, flag: "wx" });
        return directory;
    }
    async checkpoint(context: TaskContext): Promise<string> {
        if (!(this.app.vault.adapter instanceof FileSystemAdapter))
            throw new Error("当前 Vault 不支持本地转写");
        const root = await fs.realpath(this.app.vault.adapter.getBasePath());
        const relative = `.clip2md-desktop-checkpoints/${hash(context.bindingScope + ":" + context.taskId + ":" + context.contentVersion)}`;
        const directory = path.join(root, relative);
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        if (await fs.realpath(directory) !== directory)
            throw new Error("转写检查点不能经过符号链接");
        const lock = path.join(directory, "active.json");
        try {
            const owner = JSON.parse(await fs.readFile(lock, "utf8")) as {
                pid: number;
            };
            let alive = true;
            try {
                process.kill(owner.pid, 0);
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ESRCH")
                    alive = false;
            }
            if (alive)
                throw new Error("另一实例正在处理此转写");
            await fs.rm(lock);
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
        }
        await fs.writeFile(lock, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
        return directory;
    }
    async media(context: TaskContext, kind: string, media: DownloadedMedia, signal: AbortSignal): Promise<string> {
        const filename=`${context.taskId}-${kind}-${media.sha256.slice(0,16)}.${media.extension}`;
        const target = [taskDirectory(context,this.configuredFolder()),filename].filter(Boolean).join('/');
        await saveMediaOriginalFile(this.app.vault, target, media, signal);
        return target;
    }
    async text(context: TaskContext, kind: string, text: string, extension = "md"): Promise<string> {
        const title=(context.noteTitle || context.sourceTitle || `剪藏 ${context.taskId}`).replace(/[\\/:*?"<>|\r\n]/g,'_').trim().slice(0,100);
        const filename=kind==='comments'
            ? `本地评论 · ${title}-${context.bindingScope.slice(0,16)}-${context.taskId}-${hash(text).slice(0,16)}.${extension}`
            : `${context.taskId}-${kind}-${hash(text).slice(0,16)}.${extension}`;
        const target = [kind === 'comments' ? reviewTaskDirectory(context, context.commentFolder ?? '') : taskDirectory(context, this.configuredFolder()), filename].filter(Boolean).join('/');
        await ensureFolders(this.app, target);
        const existing = this.app.vault.getFileByPath(target);
        if (existing) {
            if ((await this.app.vault.read(existing)) !== text)
                throw new Error("同名素材已被修改，已保留");
            return target;
        }
        await this.app.vault.create(target, text);
        return target;
    }
    async supplement(context: TaskContext, feature: Feature, body: string, properties: LocalProperties, previous: LocalProperties = {}, replaceUserValues = false): Promise<string> {
        // Continue updating an existing owned supplement after directory changes.
        const legacy=`Clip2MD Supplements/${context.bindingScope.slice(0,16)}/${context.taskId}.md`;
        const previousFile=this.app.vault.getMarkdownFiles?.().find(file=>file.path.endsWith(`/${context.taskId}-本地资料.md`) || file.path===`${context.taskId}-本地资料.md`
            || file.path.endsWith(`/clip2md-${context.bindingScope.slice(0,16)}-${context.taskId}-本地资料.md`) || file.path===`clip2md-${context.bindingScope.slice(0,16)}-${context.taskId}-本地资料.md`);
        const target = previousFile?.path || (this.app.vault.getFileByPath(legacy) ? legacy : supplementPath(context,this.configuredFolder()));
        await ensureFolders(this.app, target);
        const start = `<!-- clipmd-desktop:${feature}:`;
        const end = `<!-- /clipmd-desktop:${feature} -->`;
        if (body.includes(start) || body.includes(end))
            throw new Error("素材含保留的区块标记");
        const block = `${start}${hash(body)} -->\n${body}\n${end}`;
        let file = this.app.vault.getFileByPath(target);
        if (!file) {
            const header = stringify({
                clip2md_parent_binding: context.bindingScope,
                clip2md_parent_task: context.taskId,
                source_url: context.sourceUrl,
                ...Object.fromEntries(Object.entries(properties).map(([k, v]) => [LOCAL_PROPERTY_NAMES[k as LocalField], v])),
            });
            const link = this.app.fileManager.generateMarkdownLink(this.app.vault.getFileByPath(context.notePath)!, target);
            await this.app.vault.create(target, `---\n${header}---\n\n主笔记：${link}\n\n${block}\n`);
            return target;
        }
        await this.app.vault.process(file, (current) => {
            const header = current.match(/^---\n([\s\S]*?)\n---/);
            const metadata = header ? parseDocument(header[1]) : null;
            if (!metadata ||
                metadata.errors.length ||
                metadata.get("clip2md_parent_binding") !== context.bindingScope ||
                metadata.get("clip2md_parent_task") !== context.taskId ||
                metadata.get("source_url") !== context.sourceUrl)
                throw new Error("补充笔记身份不匹配，已有文件已保留");
            // This marker is only trusted in our dedicated supplement, never in cloud receipts.
            const pattern = new RegExp(`<!-- clipmd-desktop:${feature}:([a-f0-9]{64}) -->\\n([\\s\\S]*?)\\n<!-- /clipmd-desktop:${feature} -->`, "g");
            const matches = [...current.matchAll(pattern)];
            if (!matches.length) {
                if (current.includes(start) || current.includes(end))
                    throw new Error("补充区块标记损坏");
                return current.trimEnd() + "\n\n" + block + "\n";
            }
            if (matches.length !== 1 || hash(matches[0][2]) !== matches[0][1])
                throw new Error("补充内容已被编辑，已保留原笔记");
            return current.replace(matches[0][0], () => block);
        });
        await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
            for (const [key, value] of Object.entries(properties)) {
                const name = LOCAL_PROPERTY_NAMES[key as LocalField];
                const legacy = "clip2md_local_" + key;
                const current=frontmatter[name]??frontmatter[legacy];
                if (replaceUserValues ||
                    current === undefined ||
                    JSON.stringify(current) ===
                        JSON.stringify(previous[key as keyof LocalProperties]))
                    frontmatter[name] = value;
                else if(frontmatter[name]===undefined)frontmatter[name]=current;
                delete frontmatter[legacy];
            }
        });
        return target;
    }
}
