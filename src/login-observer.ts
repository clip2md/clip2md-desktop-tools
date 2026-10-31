/** Login-window-only observation. Never exports bodies, headers, cookies or nicknames to logs. */
import type { SiteWindow } from './auth';
import type { LoginPlatform } from './config';
import { profileFromResponse, selfEndpoint, type AccountProfile } from './account-profile';
export type LoggedInProfile = Extract<AccountProfile, {state:'authenticated'}>;
export interface LoginObserver { profile: Promise<LoggedInProfile | undefined>; dispose(): void; }
interface DebugMessage { requestId?: string; response?: { url?: string; status?: number }; }
interface LoginDebugger {
    attach(version: string): void;
    detach(): void;
    on(event: string, callback: (event: unknown, method: string, params: DebugMessage) => void): void;
    removeListener(event: string, callback: (event: unknown, method: string, params: DebugMessage) => void): void;
    sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
}
export async function observeLogin(win: SiteWindow, platform: LoginPlatform): Promise<LoginObserver> {
    const debuggerApi = (win.webContents as { debugger: LoginDebugger }).debugger;
    let active = true, attached = false, completed = false;
    let complete!: (profile: LoggedInProfile | undefined) => void;
    const profile = new Promise<LoggedInProfile | undefined>(resolve => { complete = resolve; });
    const pending = new Set<string>();
    const message = (_event: unknown, method: string, params: DebugMessage) => {
        if (!active || completed) return;
        const id = params.requestId;
        if (!id) return;
        if (method === 'Network.responseReceived' && params.response?.status === 200 && typeof params.response.url === 'string' && selfEndpoint(platform, params.response.url) && pending.size < 3) pending.add(id);
        if (method === 'Network.loadingFailed') pending.delete(id);
        if (method === 'Network.loadingFinished' && pending.delete(id)) {
            void (async () => {
                const raw: unknown = await debuggerApi.sendCommand('Network.getResponseBody', { requestId: id });
                if (!active || completed || !raw || typeof raw !== 'object' || !('body' in raw) || typeof raw.body !== 'string' || raw.body.length > 256 * 1024 || ('base64Encoded' in raw && raw.base64Encoded)) return;
                const value = profileFromResponse(platform, JSON.parse(raw.body));
                if (value.state === 'authenticated') { completed = true; complete(value); }
            })().catch(() => undefined);
        }
    };
    const dispose = () => {
        if (!active) return;
        active = false; pending.clear(); complete(undefined);
        try { debuggerApi.removeListener('message', message); } catch { /* The window may already be gone. */ }
        if (attached && !win.isDestroyed()) try { debuggerApi.detach(); } catch { /* Closed host. */ }
        win.removeListener?.('closed', dispose);
    };
    try {
        debuggerApi.attach('1.3'); attached = true;
        debuggerApi.on('message', message);
        win.on('closed', dispose);
        // Attach before navigating so the initial self request and later login
        // responses are both observed, including login without a page reload.
        // A new BrowserWindow may not acknowledge CDP commands until its first
        // navigation creates a renderer. Waiting here prevents that navigation
        // from starting and leaves the login window permanently blank.
        void debuggerApi.sendCommand('Network.enable', { maxResourceBufferSize: 256 * 1024, maxTotalBufferSize: 1024 * 1024 }).catch(dispose);
        return { profile, dispose };
    } catch (error) { dispose(); throw error; }
}
