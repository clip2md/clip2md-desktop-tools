import { beforeEach, describe, expect, it, vi } from 'vitest';
const setup = vi.hoisted(() => ({ prepare: vi.fn(), check: vi.fn() }));
vi.mock('./tool-installer-market', () => ({ prepareManagedTools: setup.prepare }));
vi.mock('./tools', async importOriginal => ({ ...await importOriginal<typeof import('./tools')>(), checkTool: setup.check }));
import DesktopTools from './main';
import { normalizeSettings } from './config';
beforeEach(() => { setup.prepare.mockReset(); setup.check.mockReset().mockResolvedValue('fixture version'); });
function instance() {
    const plugin = new DesktopTools();
    Object.assign(plugin, { manifest: { version: '0.1.0' }, app: { saveLocalStorage: vi.fn() }, events: { trigger: vi.fn() }, settings: normalizeSettings({ commentLimit: 321 }), bridge: { version: 1 }, sessions: { setScope: vi.fn(async () => {}), close: vi.fn(async () => {}) }, drain: vi.fn(), savePreferences: vi.fn(async () => {}), verifyASR: vi.fn(async () => { plugin['asrReady'] = true; }) });
    return plugin;
}
describe('first-enable tool preparation lifecycle', () => {
    it('starts once, remains responsive, and cancels preparation when switched off', async () => {
        const p = instance();
        setup.prepare.mockImplementation((_root, signal: AbortSignal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true })));
        await p.setEnabled(true);
        await vi.waitFor(() => expect(setup.prepare).toHaveBeenCalledOnce());
        const running = p['toolSetup']; expect(running).toBeTruthy(); expect(p['prepareTools']()).toBe(running);
        await p.setEnabled(false);
        expect(p['toolSetup']).toBeNull(); expect(p['asrReady']).toBe(false); expect(p.settings.commentLimit).toBe(321);
        expect(p['verifyASR']).not.toHaveBeenCalled(); expect(p['setupError']).toBe('');
    });
    it('keeps preferences after failure and allows one explicit retry to become ready', async () => {
        const p = instance();
        setup.prepare.mockRejectedValueOnce(Error('download failed')).mockResolvedValueOnce({ whisper: '/managed/whisper-cli', ffmpeg: '/managed/ffmpeg', ytdlp: '/managed/yt-dlp', whisperModel: '/managed/ggml-base.bin' });
        await p.setEnabled(true); await p['toolSetup'];
        expect(p['asrReady']).toBe(false); expect(p['setupError']).toBe('download failed'); expect(p.settings.commentLimit).toBe(321);
        await p['prepareTools']();
        expect(setup.prepare).toHaveBeenCalledTimes(2); expect(setup.check).toHaveBeenCalledTimes(2); expect(p['verifyASR']).toHaveBeenCalledOnce();
        expect(p['asrReady']).toBe(true); expect(p['setupError']).toBe(''); expect(p.settings.whisperModel).toBe('/managed/ggml-base.bin');
        expect(p['toolStatus'].whisper.phase).toBe('ready'); expect(p['toolStatus'].model.phase).toBe('ready');
    });
});
