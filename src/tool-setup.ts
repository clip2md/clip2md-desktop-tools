import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { CLIP2MD_USAGE_DOC_URL } from './config';
export type ToolId = 'whisper' | 'ffmpeg' | 'ytdlp' | 'model';
export type SetupPhase = 'pending' | 'downloading' | 'installing' | 'checking' | 'ready' | 'failed';
export interface ToolStatus { phase: SetupPhase; message: string; }
export type SetupProgress = (tool: ToolId, phase: SetupPhase, message: string) => void;
export interface ToolPaths { whisper: string; ffmpeg: string; ytdlp: string; whisperModel: string; }
export const TOOL_LABELS: Record<ToolId, string> = { whisper: 'Whisper', ffmpeg: 'FFmpeg', ytdlp: 'yt-dlp', model: '内置转写资源' };
/** Public immutable Clip2MD mirror used by runtime installers. */
export const TOOL_CDN_BASE = 'https://static.clip2md.cn/downloads/obsidian-tools/v1';
export const MODEL = {
    url: `${TOOL_CDN_BASE}/common/ggml-base.bin`,
    sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
    size: 147951465,
};
/** Machine-local, outside the Vault: neither tools nor model enter Vault sync. */
export function toolsRoot(): string {
    const base = process.platform === 'win32' ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local') : path.join(os.homedir(), 'Library', 'Application Support');
    return path.join(base, 'Clip2MD', 'tools', 'v1', `${process.platform}-${process.arch}`);
}
export function toolPaths(root: string): ToolPaths {
    const exe = process.platform === 'win32' ? '.exe' : '';
    return { whisper: path.join(root, 'whisper', `whisper-cli${exe}`), ffmpeg: path.join(root, `ffmpeg${exe}`), ytdlp: path.join(root, `yt-dlp${exe}`), whisperModel: path.join(root, 'ggml-base.bin') };
}
export async function hashFile(file: string, signal: AbortSignal): Promise<string> {
    const hash = createHash('sha256');
    signal.throwIfAborted();
    const stream = createReadStream(file);
    const stop = () => { stream.destroy(new Error('工具检查已取消')); };
    signal.addEventListener('abort', stop, { once: true });
    try {
        for await (const chunk of stream) { signal.throwIfAborted(); hash.update(chunk as Buffer); }
        signal.throwIfAborted();
        return hash.digest('hex');
    } finally { signal.removeEventListener('abort', stop); stream.destroy(); }
}
export async function matches(file: string, sha: string, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    try { return await hashFile(file, signal) === sha; }
    catch (error) { signal.throwIfAborted(); if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
export async function discoverTools(root: string, signal: AbortSignal, progress?: SetupProgress): Promise<ToolPaths> {
    const paths = toolPaths(root);
    for (const key of ['whisper', 'ffmpeg', 'ytdlp'] as const) {
        const found = await findInstalledTool(key, root, signal);
        if (!found) throw new Error(`${TOOL_LABELS[key]} 未安装或不可执行，请检查 ${paths[key]} 或系统 PATH，使用 Agent 修复后重试`);
        paths[key] = found;
        progress?.(key, 'checking', '已找到工具，等待能力检查');
    }
    if (!(await matches(paths.whisperModel, MODEL.sha256, signal))) throw new Error('内置转写资源缺失或损坏，请使用 Agent 修复后重试');
    progress?.('model', 'ready', '固定转写资源已就绪');
    return paths;
}
export async function findInstalledTool(key: 'whisper' | 'ffmpeg' | 'ytdlp', root: string, signal: AbortSignal, systemOnly = false): Promise<string | undefined> {
    const paths = toolPaths(root);
    const bins = process.platform === 'win32'
        ? (process.env.PATH || '').split(path.delimiter)
        : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', ...(process.env.PATH || '').split(path.delimiter)];
    const name = path.basename(paths[key]);
    const managed = key === 'whisper' ? [paths[key], path.join(root, name)] : [paths[key]];
    const candidates = [...(systemOnly ? [] : managed), ...bins.filter(dir => path.isAbsolute(dir)).map(dir => path.join(dir, name)).filter(candidate => !systemOnly || !managed.some(file => path.resolve(file) === path.resolve(candidate)))];
    for (const candidate of candidates) {
        signal.throwIfAborted();
        try { if (!(await fs.stat(candidate)).isFile()) continue; await fs.access(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); return candidate; }
        catch { /* Try the next installed binary. */ }
    }
}
export function agentRepairInstructions(root: string): string {
    const paths = toolPaths(root);
    const exe = process.platform === 'win32' ? '.exe' : '';
    return `请先阅读 Clip2MD 产品使用说明：${CLIP2MD_USAGE_DOC_URL}，再为本地剪藏扩展安装或修复 whisper-cli（whisper.cpp）、完整 FFmpeg、yt-dlp。请先检查系统与架构，不索取或回显 API Key、Cookie、密码，不修改 Vault 笔记、模板、账号凭据和插件开关，不使用未知来源安装脚本。工具可安装在系统 PATH 或 ${root}。使用 Clip2MD 工具目录时，请按以下完整路径安装：\nWhisper：${paths.whisper}\nFFmpeg：${paths.ffmpeg}\nyt-dlp：${paths.ytdlp}\nFFprobe（如一并安装）：${path.join(root, `ffprobe${exe}`)}\nWhisper 可执行文件应放在 whisper 子目录；0.2.3 及之后版本也兼容工具目录根层的 whisper-cli${exe}。Whisper 运行所需动态库或其他配套文件须一并保留。Whisper 使用插件固定的多语言 base 资源，不需要用户选择模型：下载 ${MODEL.url} 到 ${paths.whisperModel}，SHA-256 必须为 ${MODEL.sha256}。下载失败时保留错误原因，不跳过文件校验。完成后请检查工具版本、FFmpeg 的 file/pipe、matroska/segment 能力，以及 yt-dlp 的 --no-plugin-dirs、--no-js-runtimes、--no-remote-components 参数，并用上述实际路径执行短音频转写自检，再提示用户点击插件中的重试检查。`;
}
