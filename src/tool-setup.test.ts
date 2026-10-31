import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODEL, agentRepairInstructions, discoverTools, findInstalledTool, toolPaths } from './tool-setup';
import { prepareManagedTools } from './tool-installer-market';
describe('fixed resource and market discovery', () => {
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
    it('always chooses the managed model location instead of a user-supplied model', () => {
        expect(toolPaths('/device/Clip2MD').whisperModel).toBe('/device/Clip2MD/ggml-base.bin');
        expect(MODEL.sha256).toHaveLength(64);
        expect(agentRepairInstructions('/device/Clip2MD')).toContain(MODEL.sha256);
        expect(agentRepairInstructions('/device/Clip2MD')).toContain('不修改 Vault');
    });
    it('market preparation never installs or downloads missing dependencies', async () => {
        const controller = new AbortController(); controller.abort();
        await expect(prepareManagedTools('/missing', controller.signal, vi.fn())).rejects.toThrow();
    });
    it('copies the exact managed executable paths and fixed model destination', () => {
        const root = path.resolve('/device/Clip2MD');
        const instructions = agentRepairInstructions(root);
        for (const file of Object.values(toolPaths(root))) expect(instructions).toContain(file);
        expect(instructions).toContain('whisper 子目录');
        expect(instructions).toContain('动态库');
        expect(instructions).toContain('短音频转写自检');
    });
    function installed(...files: string[]) {
        const available = new Set(files);
        vi.spyOn(fs, 'stat').mockImplementation(async file => {
            if (!available.has(String(file))) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
            return { isFile: () => true } as Awaited<ReturnType<typeof fs.stat>>;
        });
        vi.spyOn(fs, 'access').mockResolvedValue();
        vi.stubEnv('PATH', path.resolve('/custom/bin'));
    }
    it('prefers the canonical Whisper executable over root and PATH alternatives', async () => {
        const root = path.resolve('/device/Clip2MD');
        const canonical = toolPaths(root).whisper;
        installed(canonical, path.join(root, path.basename(canonical)), path.join(path.resolve('/custom/bin'), path.basename(canonical)));
        expect(await findInstalledTool('whisper', root, new AbortController().signal)).toBe(canonical);
    });
    it('discovers root-level Whisper when the canonical location is missing', async () => {
        const root = path.resolve('/device/Clip2MD');
        const fallback = path.join(root, path.basename(toolPaths(root).whisper));
        installed(fallback);
        expect(await findInstalledTool('whisper', root, new AbortController().signal)).toBe(fallback);
    });
    it('falls through to PATH when a managed binary is not executable', async () => {
        const root = path.resolve('/device/Clip2MD');
        const canonical = toolPaths(root).whisper;
        const system = path.join(path.resolve('/custom/bin'), path.basename(canonical));
        installed(canonical, system);
        vi.mocked(fs.access).mockImplementation(async file => {
            if (String(file) === canonical) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        });
        expect(await findInstalledTool('whisper', root, new AbortController().signal)).toBe(system);
    });
    it('excludes both managed Whisper paths from system-only lookup, including PATH entries', async () => {
        const root = path.resolve('/device/Clip2MD');
        const canonical = toolPaths(root).whisper;
        const fallback = path.join(root, path.basename(canonical));
        const systemBin = path.resolve('/custom/bin');
        const system = path.join(systemBin, path.basename(canonical));
        installed(canonical, fallback, system);
        vi.stubEnv('PATH', [root, path.dirname(canonical), systemBin].join(path.delimiter));
        expect(await findInstalledTool('whisper', root, new AbortController().signal, true)).toBe(system);
    });
    it('reports the expected executable path when discovery cannot continue', async () => {
        const root = path.resolve('/device/Clip2MD');
        installed();
        await expect(discoverTools(root, new AbortController().signal)).rejects.toThrow(toolPaths(root).whisper);
    });
});
