import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { observeLogin } from './login-observer';
import type { SiteWindow } from './auth';
function fixture() {
    const debug = Object.assign(new EventEmitter(), { attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn(async (command: string) => command === 'Network.getResponseBody' ? { body: JSON.stringify({ code: 0, data: { isLogin: true, mid: 42, uname: '本人昵称' } }) } : {}) });
    const window = Object.assign(new EventEmitter(), { webContents: { debugger: debug }, isDestroyed: () => false }) as unknown as SiteWindow;
    const response = (url = 'https://api.bilibili.com/x/web-interface/nav', id = 'own') => {
        debug.emit('message', null, 'Network.responseReceived', { requestId: id, response: { url, status: 200 } });
        debug.emit('message', null, 'Network.loadingFinished', { requestId: id });
    };
    return { debug, window, response };
}
describe('homepage login network observation', () => {
    it('returns before Network.enable is acknowledged so first navigation can start', async () => {
        const f = fixture();
        let enable!: (value: unknown) => void;
        f.debug.sendCommand.mockImplementationOnce(() => new Promise(resolve => { enable = resolve; }) as never);
        const observer = await observeLogin(f.window, 'douyin');
        expect(f.debug.sendCommand).toHaveBeenCalledWith('Network.enable', expect.any(Object));
        observer.dispose();
        enable({});
        await expect(observer.profile).resolves.toBeUndefined();
    });
    it('cleans up if enabling observation fails after navigation starts', async () => {
        const f = fixture();
        f.debug.sendCommand.mockRejectedValueOnce(new Error('renderer gone'));
        const observer = await observeLogin(f.window, 'douyin');
        await expect(observer.profile).resolves.toBeUndefined();
        expect(f.debug.listenerCount('message')).toBe(0);
        expect(f.debug.detach).toHaveBeenCalledOnce();
    });
    it('detects authenticated self traffic once without navigating or polling', async () => {
        const f = fixture(), observer = await observeLogin(f.window, 'bilibili');
        expect(f.debug.sendCommand).toHaveBeenCalledWith('Network.enable', expect.any(Object));
        f.response();
        await expect(observer.profile).resolves.toEqual({ state: 'authenticated', nickname: '本人昵称' });
        f.response(); await Promise.resolve();
        expect(f.debug.sendCommand.mock.calls.filter(([method]) => method === 'Network.getResponseBody')).toHaveLength(1);
        observer.dispose(); expect(f.debug.detach).toHaveBeenCalledOnce();
    });
    it('ignores guest traffic and waits for the later asynchronous login response', async () => {
        const f = fixture(), observer = await observeLogin(f.window, 'bilibili');
        f.debug.sendCommand.mockResolvedValueOnce({ body: JSON.stringify({ code: 0, data: { isLogin: false } }) });
        f.response(); for (let i = 0; i < 4; i++) await Promise.resolve();
        f.response(undefined, 'after-login');
        await expect(observer.profile).resolves.toMatchObject({ state: 'authenticated' }); observer.dispose();
    });
    it('never accepts author endpoints, lookalike domains or failed requests as a login', async () => {
        const f = fixture(), observer = await observeLogin(f.window, 'bilibili');
        f.response('https://api.bilibili.com/x/space/acc/info');
        f.response('https://api.bilibili.com.attacker.test/x/web-interface/nav');
        f.debug.emit('message', null, 'Network.responseReceived', { requestId: 'failed', response: { url: 'https://api.bilibili.com/x/web-interface/nav', status: 200 } });
        f.debug.emit('message', null, 'Network.loadingFailed', { requestId: 'failed' });
        f.debug.emit('message', null, 'Network.loadingFinished', { requestId: 'failed' });
        expect(f.debug.sendCommand.mock.calls.filter(([method]) => method === 'Network.getResponseBody')).toHaveLength(0);
        observer.dispose(); await expect(observer.profile).resolves.toBeUndefined();
    });
    it('cancels pending response reads and removes listeners when the window closes', async () => {
        const f = fixture(), observer = await observeLogin(f.window, 'bilibili');
        let finish!: (value: unknown) => void;
        f.debug.sendCommand.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }) as never);
        f.response(); f.window.on('closed', () => {});
        (f.window as unknown as EventEmitter).emit('closed');
        finish({ body: JSON.stringify({ code: 0, data: { isLogin: true, mid: 42, uname: 'late identity' } }) });
        await expect(observer.profile).resolves.toBeUndefined();
        expect(f.debug.listenerCount('message')).toBe(0); observer.dispose(); expect(f.debug.detach).toHaveBeenCalledOnce();
    });
});
