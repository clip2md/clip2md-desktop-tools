import { describe, expect, it, vi } from "vitest";
import { SiteSessions, type SiteCookie, type SiteRuntime } from "./auth";
import type { App } from "obsidian";
import { EventEmitter } from 'node:events';
function fixture(loginTimeoutMs = 30000) {
  const secrets = new Map<string, string>();
  const created: Array<{
    cookies: SiteCookie[];
    clear: ReturnType<typeof vi.fn>;
  }> = [];
  const options: Record<string, unknown>[] = [];
  const partitions: string[] = [];
  const requestHandlers: Array<(details: { url: string }, callback: (result: { cancel: boolean }) => void) => void> = [];
  const windows: Array<{
    url: string; destroyed: boolean; loadURL: ReturnType<typeof vi.fn>;
    webContents: EventEmitter & {
      executeJavaScript: ReturnType<typeof vi.fn>;
      mainFrame?: { url: string; executeJavaScript: ReturnType<typeof vi.fn>; frames: unknown[] };
    };
    show: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn>;
  }> = [];
  const runtime: SiteRuntime = {
    session: {
      fromPartition: (name: string) => {
        partitions.push(name);
        const data = {
          cookies: [] as SiteCookie[],
          clear: vi.fn(async () => {
            data.cookies = [];
          }),
        };
        created.push(data);
        return {
          cookies: {
            get: async ({ url } = {}) =>
              data.cookies.filter(
                (c) =>
                  !url ||
                  new URL(url).hostname.endsWith(c.domain.replace(/^\./, "")),
              ),
            set: async (c) => {
              data.cookies.push(c as unknown as SiteCookie);
            },
          },
          clearStorageData: data.clear,
          setPermissionRequestHandler: vi.fn(),
          setPermissionCheckHandler: vi.fn(),
          webRequest: { onBeforeRequest: (_filter: unknown, handler: (details: { url: string }, callback: (result: { cancel: boolean }) => void) => void) => { requestHandlers.push(handler); } },
          on: vi.fn(),
        };
      },
    },
    BrowserWindow: class extends EventEmitter {
      url = 'about:blank';
      webContents = Object.assign(new EventEmitter(), {
        setWindowOpenHandler: vi.fn(), setUserAgent: vi.fn(), getURL: () => this.url,
        executeJavaScript: vi.fn(async () => ({})),
      });
      show = vi.fn();
      focus = vi.fn();
      destroyed = false;
      constructor(o: Record<string, unknown>) {
        super();
        // The host prevents navigation on every newly created WebContents.
        this.webContents.on('will-navigate', (event: { preventDefault(): void }) => event.preventDefault());
        options.push(o);
        windows.push(this);
      }
      loadURL = vi.fn(async (url: string) => { this.url = url; });
      destroy() {
        this.destroyed = true;
        this.emit('closed');
      }
      isDestroyed() {
        return this.destroyed;
      }
    },
  };
  const app = {
    secretStorage: {
      getSecret: (key: string) => secrets.get(key) || null,
      setSecret: (key: string, value: string) => {
        if (!/^[a-z0-9-]{1,64}$/.test(key))
          throw new Error("invalid secret ID");
        secrets.set(key, value);
      },
    },
  } as unknown as App;
  return {
    sessions: new SiteSessions(app, () => runtime, loginTimeoutMs),
    secrets,
    created,
    options,
    windows,
    partitions,
    requestHandlers,
  };
}
describe("isolated native authorization", () => {
  it('binds import fingerprints to saved localStorage authorization as well as cookies', async () => {
    const f = fixture(); await f.sessions.setScope('scope-a');
    const win = await f.sessions.login('xiaohongshu');
    f.created[0].cookies.push({ name: 'web_session', value: 'same-cookie', domain: '.xiaohongshu.com', path: '/' });
    Object.assign(win.webContents, { executeJavaScript: vi.fn(async () => ({ account: 'first-local-token' })) });
    await f.sessions.save('xiaohongshu', undefined, win);
    const cookieOnly = await f.sessions.cookieAuthFingerprint('xiaohongshu');
    const first = await f.sessions.authorizationFingerprint('xiaohongshu');
    Object.assign(win.webContents, { executeJavaScript: vi.fn(async () => ({ account: 'second-local-token' })) });
    await f.sessions.save('xiaohongshu', undefined, win);
    expect(await f.sessions.cookieAuthFingerprint('xiaohongshu')).toBe(cookieOnly);
    expect(await f.sessions.authorizationFingerprint('xiaohongshu')).not.toBe(first);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    await f.sessions.close();
  });

  it.each([
    ['csdn', [{ name: 'UserToken', value: 'token' }, { name: 'UserName', value: 'user' }]],
    ['zhihu', [{ name: 'z_c0', value: 'token' }]],
    ['douban', [{ name: 'dbcl2', value: 'token' }]],
    ['xiaohongshu', [{ name: 'web_session', value: 'token' }]],
    ['weibo', [{ name: 'SUB', value: 'token' }]],
    ['twitter', [{ name: 'auth_token', value: 'token' }, { name: 'ct0', value: 'csrf' }]],
    ['kuaishou', [{ name: 'userId', value: '123456' }]],
    ['xiaoyuzhou', [{ name: 'x-jike-access-token', value: 'token' }]],
    ['lizhi', [{ name: 'lztacokefu', value: 'token' }]],
    ['applepodcasts', [{ name: 'media-user-token', value: 'token' }]],
  ] as const)('recognizes %s login cookies without treating analytics cookies as authorization', async (platform, rows) => {
    const f = fixture(); await f.sessions.setScope('scope-a'); await f.sessions.login(platform as any);
    const domain = platform === 'zhihu' ? 'zhihu.com' : platform === 'douban' ? 'douban.com'
      : platform === 'weibo' ? 'weibo.com' : platform === 'twitter' ? 'x.com'
      : platform === 'kuaishou' ? 'kuaishou.com' : platform === 'xiaoyuzhou' ? 'xiaoyuzhoufm.com'
      : platform === 'lizhi' ? 'taco.lizhifm.com'
      : platform === 'xiaohongshu' ? 'xiaohongshu.com'
      : platform === 'applepodcasts' ? 'apple.com' : 'csdn.net';
    f.created[0].cookies.push(...rows.map(row => ({ ...row, domain: `.${domain}`, path: '/' })));
    expect((await f.sessions.cookieLoginProfile(platform as any))?.state).toBe('authenticated');
    await f.sessions.close();
  });
  it('requires an explicit login confirmation for domain-scoped generic sessions and isolates sibling sites', async () => {
    const f=fixture();await f.sessions.setScope('scope-a');f.sessions.setWebDomains(['example.com']);
    await f.sessions.login('web:example.com');
    expect(f.windows[0].url).toBe('https://example.com/');
    f.created[0].cookies.push({name:'session',value:'synthetic-login',domain:'.example.com',path:'/'});
    await expect(f.sessions.save('web:example.com')).rejects.toThrow('尚未检测');
    await f.sessions.save('web:example.com',undefined,undefined,true);
    expect(await f.sessions.cookieHeader('https://news.example.com/article')).toBe('session=synthetic-login');
    expect(await f.sessions.cookieHeader('https://example.com.evil.test/article')).toBe('');
    expect(await f.sessions.cookieHeader('https://other.test/article')).toBe('');
    await f.sessions.revoke('web:example.com');
    expect(f.sessions.hasStoredAuthorization('web:example.com')).toBe(false);
    await f.sessions.close();
  });
  it('saves and restores origin-scoped localStorage without writing it to Vault configuration', async () => {
    const f=fixture();await f.sessions.setScope('scope-a');
    const win=await f.sessions.login('web:example.com');
    Object.assign(f.windows[0].webContents,{executeJavaScript:vi.fn(async()=>({token:'synthetic-storage-token'}))});
    await f.sessions.save('web:example.com',undefined,win,true);
    expect(f.sessions.hasLocalStorageAuthorization('web:example.com')).toBe(true);
    expect([...f.secrets.values()].join()).toContain('synthetic-storage-token');
    await f.sessions.close();await f.sessions.setScope('scope-a');
    const restored=await f.sessions.login('web:example.com');
    const execute=vi.fn(async()=>{});Object.assign(restored.webContents,{executeJavaScript:execute});
    restored.webContents.emit('dom-ready');
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('localStorage.setItem'),false);
    await f.sessions.close();await f.sessions.setScope('scope-b');
    expect(f.sessions.hasStoredAuthorization('web:example.com')).toBe(false);
    await f.sessions.close();
  });
  it('detects and restores Lizhi login storage from its allowed Taco subframe', async () => {
    const f = fixture(); await f.sessions.setScope('scope-a');
    const win = await f.sessions.login('lizhi');
    const frameExecute = vi.fn(async () => ({
      "__kefu-taco__default__": JSON.stringify({ appKey: "lizhi", lztacokefu: "token-in-frame" }),
    }));
    Object.assign(win.webContents, {
      mainFrame: {
        url: 'https://nj.lizhi.fm/static/login/#/taco/redirect',
        executeJavaScript: vi.fn(async () => ({ unrelated: 'main' })),
        frames: [{
          url: 'https://taco.lizhifm.com/login/callback',
          executeJavaScript: frameExecute,
          frames: [],
        }],
      },
    });
    expect((await f.sessions.cookieLoginProfile('lizhi', win))?.state).toBe('authenticated');
    await f.sessions.save('lizhi', undefined, win, true);
    expect([...f.secrets.values()].join()).toContain('token-in-frame');
    expect([...f.secrets.values()].join()).toContain('https://taco.lizhifm.com');
    expect(f.sessions.hasLocalStorageAuthorization('lizhi')).toBe(true);

    await f.sessions.close(); await f.sessions.setScope('scope-a');
    const restored = await f.sessions.login('lizhi');
    const restoreMain = vi.fn(async () => undefined);
    const restoreFrame = vi.fn(async () => undefined);
    Object.assign(restored.webContents, {
      mainFrame: {
        url: 'https://nj.lizhi.fm/static/login/#/taco/redirect',
        executeJavaScript: restoreMain,
        frames: [{
          url: 'https://taco.lizhifm.com/login/callback',
          executeJavaScript: restoreFrame,
          frames: [],
        }],
      },
    });
    restored.webContents.emit('did-frame-finish-load');
    await vi.waitFor(() => expect(restoreFrame).toHaveBeenCalledWith(expect.stringContaining('localStorage.setItem'), false));
    expect(restoreFrame.mock.calls[0][0]).toContain('token-in-frame');
    await f.sessions.close();
  });
  it('recognizes the Yuanbao user identity and authorization stored by its own login flow', async () => {
    const f = fixture(); await f.sessions.setScope('scope-a');
    const win = await f.sessions.login('wechat-channel');
    const execute = vi.fn(async () => ({
      yb_user_id: '123456789',
      LOCAL_AUTH_INFO_KEY_yuanbao: 'opaque-session',
    }));
    Object.assign(win.webContents, {
      mainFrame: {
        url: 'https://yuanbao.tencent.com/chat/example',
        executeJavaScript: execute,
        frames: [],
      },
    });
    expect(await f.sessions.cookieLoginProfile('wechat-channel', win)).toMatchObject({state:'authenticated'});
    await f.sessions.save('wechat-channel', undefined, win);
    expect([...f.secrets.values()].join()).toContain('opaque-session');
    expect(f.sessions.hasLocalStorageAuthorization('wechat-channel')).toBe(true);
    await f.sessions.close();
  });
  it('recognizes the hexadecimal Yuanbao user id and authenticated profile', async () => {
    const f = fixture(); await f.sessions.setScope('scope-a');
    const win = await f.sessions.login('wechat-channel');
    const execute = vi.fn(async () => ({
      yb_user_id: '6bd5f45a1b824627acb471ed6eedae6a',
      LOCAL_AUTH_INFO_KEY_yuanbao: JSON.stringify({
        auth: true,
        status: 2,
        userId: '6bd5f45a1b824627acb471ed6eedae6a',
        anonUser: { isAnon: false },
      }),
    }));
    Object.assign(win.webContents, {
      executeJavaScript: execute,
      mainFrame: {
        url: 'https://yuanbao.tencent.com/chat/example',
        executeJavaScript: vi.fn(async () => ({ stale: 'frame' })),
        frames: [],
      },
    });
    expect((await f.sessions.cookieLoginProfile('wechat-channel', win))?.state).toBe('authenticated');
    await f.sessions.save('wechat-channel', undefined, win);
    expect(f.sessions.hasLocalStorageAuthorization('wechat-channel')).toBe(true);
    await f.sessions.close();
  });
  it('saves Yuanbao authorization confirmed by the first-party identity API without legacy local storage', async () => {
    const f = fixture(); await f.sessions.setScope('scope-a');
    const win = await f.sessions.login('wechat-channel');
    Object.assign(win.webContents, {
      mainFrame: {
        url: 'https://yuanbao.tencent.com/chat/example',
        executeJavaScript: vi.fn(async () => ({ unrelated: 'session-state' })),
        frames: [],
      },
    });
    await f.sessions.save(
      'wechat-channel',
      undefined,
      win,
      false,
      { state: 'authenticated', nickname: '元宝账号' },
    );
    expect(f.sessions.hasStoredAuthorization('wechat-channel')).toBe(true);
    expect(f.sessions.hasLocalStorageAuthorization('wechat-channel')).toBe(false);
    await f.sessions.close();
  });
  it('does not treat Yuanbao visitor state as an authenticated account', async () => {
    const f = fixture(); await f.sessions.setScope('scope-a');
    const win = await f.sessions.login('wechat-channel');
    Object.assign(win.webContents, {
      mainFrame: {
        url: 'https://yuanbao.tencent.com/chat/example',
        executeJavaScript: vi.fn(async () => ({ hy_user: 'visitor', yb_token: 'anonymous' })),
        frames: [],
      },
    });
    expect(await f.sessions.cookieLoginProfile('wechat-channel', win)).toBeUndefined();
    await expect(f.sessions.save('wechat-channel', undefined, win)).rejects.toThrow('尚未检测');
    await f.sessions.close();
  });
  it('does not treat a hexadecimal Yuanbao anonymous profile as authenticated', async () => {
    const f = fixture(); await f.sessions.setScope('scope-a');
    const win = await f.sessions.login('wechat-channel');
    Object.assign(win.webContents, {
      mainFrame: {
        url: 'https://yuanbao.tencent.com/chat/example',
        executeJavaScript: vi.fn(async () => ({
          yb_user_id: '6bd5f45a1b824627acb471ed6eedae6a',
          LOCAL_AUTH_INFO_KEY_yuanbao: JSON.stringify({
            auth: true,
            status: 2,
            anonUser: { isAnon: true },
          }),
        })),
        frames: [],
      },
    });
    expect(await f.sessions.cookieLoginProfile('wechat-channel', win)).toBeUndefined();
    await f.sessions.close();
  });
  it('preserves the isolated Yuanbao session when the plugin scope is disposed for a reload', async () => {
    const f = fixture(); await f.sessions.setScope('scope-a');
    await f.sessions.open('wechat-channel');
    const clearStorageData = f.created[0].clear;
    await f.sessions.close();
    expect(clearStorageData).not.toHaveBeenCalled();
  });
  it('reuses deterministic in-memory partitions after plugin reload and isolates scopes or platforms', async () => {
    const f = fixture();
    await f.sessions.setScope('scope-a');
    await f.sessions.open('wechat-channel');
    await f.sessions.open('wechat');
    const first = f.partitions.slice();
    await f.sessions.close();
    await f.sessions.setScope('scope-a');
    await f.sessions.open('wechat-channel');
    expect(f.partitions.at(-1)).toBe(first[0]);
    expect(first[0]).not.toBe(first[1]);
    expect(first[0]).not.toMatch(/^persist:/);
    await f.sessions.close();
    await f.sessions.setScope('scope-b');
    await f.sessions.open('wechat-channel');
    expect(f.partitions.at(-1)).not.toBe(first[0]);
    await f.sessions.close();
  });
  it('does not trust Lizhi storage from a disallowed frame', async () => {
    const f = fixture(); await f.sessions.setScope('scope-a');
    const win = await f.sessions.login('lizhi');
    const execute = vi.fn(async () => ({
      "__kefu-taco__default__": JSON.stringify({ lztacokefu: 'hostile-token' }),
    }));
    Object.assign(win.webContents, {
      mainFrame: {
        url: 'https://nj.lizhi.fm/static/login/#/taco/redirect',
        executeJavaScript: vi.fn(async () => ({})),
        frames: [{ url: 'https://attacker.test/login', executeJavaScript: execute, frames: [] }],
      },
    });
    expect(await f.sessions.cookieLoginProfile('lizhi', win)).toBeUndefined();
    await expect(f.sessions.save('lizhi', undefined, win, true)).rejects.toThrow('尚未检测');
    expect(execute).not.toHaveBeenCalled();
    await f.sessions.close();
  });
  it.each(['csdn','zhihu','douban','wechat','weibo','youtube','twitter','kuaishou','toutiao','xiaoyuzhou','lizhi','applepodcasts','wechat-channel'] as const)('opens an isolated login window for %s', async platform=>{
    const f=fixture();await f.sessions.setScope('scope-a');await f.sessions.login(platform);
    expect(f.windows[0].url).toMatch(/^https:\/\//);
    expect(f.options[0].webPreferences).toMatchObject({nodeIntegration:false,sandbox:true,contextIsolation:true});
    await f.sessions.close();
  });
  it('opens a queued WeChat article instead of the management console', async () => {
    const f = fixture(); await f.sessions.setScope('scope-a');
    const target = 'https://mp.weixin.qq.com/s/example-article?scene=1#rd';
    await f.sessions.login('wechat', undefined, target);
    expect(f.windows[0].loadURL).toHaveBeenCalledWith(target);
    await f.sessions.close();
  });
  it('opens Weibo login overlay from the first-party page after loading completes', async () => {
    const f = fixture(); await f.sessions.setScope('scope-a');
    const open = f.sessions.open.bind(f.sessions);
    const execute = vi.fn()
      .mockResolvedValueOnce('waiting')
      .mockResolvedValueOnce('clicked')
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    vi.spyOn(f.sessions, 'open').mockImplementation(async (...args) => {
      const win = await open(...args);
      Object.assign(win.webContents, { executeJavaScript: execute });
      return win;
    });
    await f.sessions.login('weibo');
    await vi.waitFor(() =>
      expect(execute).toHaveBeenCalledWith(expect.stringContaining('data-testid=\\\"loginButton\\\"'), false),
    );
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(4));
    expect(execute.mock.calls[3][0]).toContain('text === "微信"');
    await f.sessions.close();
  });
  it('opens Yuanbao login overlay from the first-party page after loading completes', async () => {
    const f = fixture(); await f.sessions.setScope('scope-a');
    const open = f.sessions.open.bind(f.sessions);
    const execute = vi.fn()
      .mockResolvedValueOnce('waiting')
      .mockResolvedValueOnce('clicked')
      .mockResolvedValueOnce(true);
    vi.spyOn(f.sessions, 'open').mockImplementation(async (...args) => {
      const win = await open(...args);
      Object.assign(win.webContents, { executeJavaScript: execute });
      return win;
    });
    await f.sessions.login('wechat-channel');
    await vi.waitFor(() =>
      expect(execute).toHaveBeenCalledWith(expect.stringContaining('agent-dialogue__tool__login'), false),
    );
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
    await f.sessions.close();
  });
  it('recognizes Xiaohongshu web_session before waiting for page hydration', async () => {
    const f = fixture(); await f.sessions.setScope('scope-a'); await f.sessions.login('xiaohongshu');
    f.created[0].cookies.push({name:'web_session',value:'active',domain:'.xiaohongshu.com',path:'/',expirationDate:Date.now()/1000+3600});
    expect(await f.sessions.cookieLoginProfile('xiaohongshu')).toMatchObject({state:'authenticated',nickname:'xiaohongshu.com'});
    f.created[0].cookies[0].expirationDate=Date.now()/1000-1;
    expect(await f.sessions.cookieLoginProfile('xiaohongshu')).toBeUndefined();
    await f.sessions.close();
  });
  it('uses a stable Cookie fingerprint for Weibo re-login challenges',async()=>{
    const f=fixture();await f.sessions.setScope('scope-a');await f.sessions.login('weibo');
    f.created[0].cookies.push({name:'SUB',value:'old-auth',domain:'.weibo.com',path:'/'});
    const before=await f.sessions.cookieAuthFingerprint('weibo');
    expect(await f.sessions.cookieAuthFingerprint('weibo')).toBe(before);
    f.created[0].cookies[0].value='new-auth';
    expect(await f.sessions.cookieAuthFingerprint('weibo')).not.toBe(before);
    await f.sessions.close();
  });
  it.each(['twitter', 'youtube'] as const)('routes %s Google OAuth out of the embedded login window', async platform => {
    const f = fixture(); await f.sessions.setScope('scope-a');
    const win = await f.sessions.login(platform);
    const handler = (win.webContents.setWindowOpenHandler as ReturnType<typeof vi.fn>).mock.calls[0][0] as (details: {url: string}) => {action: string};
    expect(handler({url:'https://accounts.google.com/o/oauth2/auth?client_id=x'})).toEqual({action:'deny'});
    expect(win.loadURL).not.toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/auth?client_id=x');
    const googleEvent={preventDefault:vi.fn()};
    win.webContents.emit('will-navigate',googleEvent,'https://accounts.google.com/o/oauth2/auth?client_id=x');
    expect(googleEvent.preventDefault).toHaveBeenCalled();
    const evilEvent={preventDefault:vi.fn()};
    win.webContents.emit('will-navigate',evilEvent,'https://evil.example/oauth');
    expect(evilEvent.preventDefault).toHaveBeenCalled();
    await f.sessions.close();
  });
  it('refreshes browser Cookie authorization promptly after an OAuth handoff', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); await f.sessions.setScope('scope-a');
      const provider = vi.fn()
        .mockResolvedValueOnce([{name:'guest_id', value:'guest', domain:'.x.com', path:'/'}])
        .mockResolvedValueOnce([{name:'auth_token', value:'auth', domain:'.x.com', path:'/'}, {name:'ct0', value:'csrf', domain:'.x.com', path:'/'}]);
      f.sessions.setBrowserCookieProvider(provider);
      expect(await f.sessions.cookieLoginProfile('twitter')).toBeUndefined();
      await vi.advanceTimersByTimeAsync(5_001);
      expect((await f.sessions.cookieLoginProfile('twitter'))?.state).toBe('authenticated');
      expect(provider).toHaveBeenCalledTimes(2);
      await f.sessions.close();
    } finally { vi.useRealTimers(); }
  });
  it('recognizes a YouTube browser session during the login poll', async () => {
    const f = fixture(); await f.sessions.setScope('scope-a');
    f.sessions.setBrowserCookieProvider(async () => [{name:'SID', value:'sid', domain:'.youtube.com', path:'/'}]);
    expect((await f.sessions.cookieLoginProfile('youtube'))?.nickname).toBe('youtube.com');
    await f.sessions.close();
  });
  it('recognizes Toutiao account cookies during the login poll', async () => {
    const f = fixture(); await f.sessions.setScope('scope-a'); await f.sessions.login('toutiao');
    f.created[0].cookies.push({name:'sessionid', value:'session', domain:'.toutiao.com', path:'/'});
    expect((await f.sessions.cookieLoginProfile('toutiao'))?.state).toBe('authenticated');
    await f.sessions.close();
  });
  it("does not read a browser profile or initialize a session for public requests", async () => {
    const f = fixture();
    await f.sessions.setScope("scope-a");
    expect(
      await f.sessions.cookieHeader("https://www.bilibili.com/video/42"),
    ).toBe("");
    expect(f.created).toHaveLength(0);
  });
  it("uses a sandbox and persists only selected-platform login cookies in secret storage", async () => {
    const f = fixture();
    await f.sessions.setScope("scope-a");
    await f.sessions.login("bilibili");
    expect(f.options[0].webPreferences).toMatchObject({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    });
    expect(f.windows[0].webContents.setUserAgent).toHaveBeenCalledWith(expect.stringContaining("Mozilla/5.0"));
    f.created[0].cookies.push(
      {
        name: "SESSDATA",
        value: "test-session",
        domain: ".bilibili.com",
        path: "/",
      },
      {
        name: "tracking",
        value: "third-party",
        domain: ".other.test",
        path: "/",
      },
    );
    await f.sessions.save("bilibili");
    expect([...f.secrets.values()].join()).toContain("test-session");
    expect([...f.secrets.values()].join()).not.toContain("third-party");
    expect(await f.sessions.cookieHeader("https://api.bilibili.com/test")).toBe(
      "SESSDATA=test-session",
    );
    expect(
      await f.sessions.cookieHeader("https://bilibili.com.other.test/test"),
    ).toBe("");
    expect(await f.sessions.authorizedCookies("bilibili")).toHaveLength(1);
    await f.sessions.close();
  });
  it("allows non-network page assets such as data URLs", async () => {
    const f = fixture();
    await f.sessions.setScope("scope-a");
    await f.sessions.login("douyin");
    for (const [url, cancel] of [
      ['data:text/plain,login', false],
      ['blob:https://www.douyin.com/synthetic', false],
      ['file:///tmp/private', true],
      ['invalid url', true],
      ['http://127.0.0.1/private', true],
    ] as const) {
      const result = await new Promise<{ cancel: boolean }>(resolve => f.requestHandlers[0]({ url }, resolve));
      expect(result).toEqual({ cancel });
    }
    await f.sessions.close();
  });
  it('permits trusted challenge reloads while blocking off-site navigation', async () => {
    const f = fixture(); await f.sessions.setScope('scope-a');
    await f.sessions.login('douyin');
    for (const name of ['will-navigate', 'will-redirect']) {
      for (const url of ['https://www.douyin.com/', 'https://passport.douyin.com/login/']) {
        const event = { preventDefault: vi.fn() };
        f.windows[0].webContents.emit(name, event, url);
        expect(event.preventDefault).not.toHaveBeenCalled();
      }
      for (const url of ['https://www.douyin.com.evil.test/', 'file:///tmp/private', 'http://www.douyin.com/']) {
        const event = { preventDefault: vi.fn() };
        f.windows[0].webContents.emit(name, event, url);
        expect(event.preventDefault).toHaveBeenCalledOnce();
      }
    }
    await f.sessions.close();
  });
  it("isolates account scopes, restores only its own session and revokes saved authorization", async () => {
    const f = fixture();
    await f.sessions.setScope("scope-a");
    await f.sessions.login("bilibili");
    f.created[0].cookies.push({
      name: "SESSDATA",
      value: "test-a",
      domain: ".bilibili.com",
      path: "/",
    });
    await f.sessions.save("bilibili");
    await f.sessions.setScope("scope-b");
    expect(await f.sessions.cookieHeader("https://api.bilibili.com/test")).toBe(
      "",
    );
    await f.sessions.setScope("scope-a");
    expect(await f.sessions.cookieHeader("https://api.bilibili.com/test")).toBe(
      "SESSDATA=test-a",
    );
    await f.sessions.revoke("bilibili");
    expect(await f.sessions.cookieHeader("https://api.bilibili.com/test")).toBe(
      "",
    );
  });
  it("does not accept an anonymous page as a completed login", async () => {
    const f = fixture();
    await f.sessions.setScope("scope-a");
    await f.sessions.login("bilibili");
    await expect(f.sessions.save("bilibili")).rejects.toThrow("尚未检测");
    await f.sessions.close();
  });
  it.each([
    ['bilibili', 'https://www.bilibili.com/'],
    ['douyin', 'https://www.douyin.com/'],
    ['xiaohongshu', 'https://www.xiaohongshu.com/'],
  ] as const)('opens the %s homepage and brings it to the front', async (platform, origin) => {
    const f = fixture(); await f.sessions.setScope('scope-a');
    await f.sessions.login(platform);
    expect(f.windows[0].loadURL).toHaveBeenCalledWith(origin);
    expect(f.windows[0].show).toHaveBeenCalledOnce(); expect(f.windows[0].focus).toHaveBeenCalledOnce();
    await f.sessions.close();
  });
  it('installs the login observer before any homepage navigation starts', async () => {
    const f = fixture(); await f.sessions.setScope('scope-a');
    const observe = vi.fn(async () => { expect(f.windows[0].loadURL).not.toHaveBeenCalled(); });
    await f.sessions.login('bilibili', observe);
    expect(observe).toHaveBeenCalledOnce(); expect(f.windows[0].loadURL).toHaveBeenCalledOnce(); await f.sessions.close();
  });
  it('does not persist authorization if cancellation arrives while cookies are being read', async () => {
    const f = fixture(); await f.sessions.setScope('scope-a'); const controller = new AbortController();
    let finish!: (cookies: SiteCookie[]) => void;
    vi.spyOn(f.sessions, 'cookies').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const save = f.sessions.save('bilibili', controller.signal); controller.abort();
    finish([{name:'SESSDATA',value:'synthetic',domain:'.bilibili.com',path:'/'}]);
    await expect(save).rejects.toThrow(); expect(f.secrets.size).toBe(0); await f.sessions.close();
  });
  it('accepts a trusted DOM-ready document without waiting for stalled secondary resources', async () => {
    const f = fixture(); await f.sessions.setScope('scope-a');
    const open = f.sessions.open.bind(f.sessions);
    vi.spyOn(f.sessions, 'open').mockImplementation(async (...args) => {
      const win = await open(...args);
      vi.mocked(win.loadURL).mockImplementation(async (url: string) => { f.windows[0].url = url; queueMicrotask(() => win.webContents.emit('dom-ready')); await new Promise(() => {}); });
      return win;
    });
    await expect(f.sessions.login('bilibili')).resolves.toBeDefined();
    expect(f.windows[0].webContents.listenerCount('dom-ready')).toBe(0);
    await f.sessions.close();
  });
  it('ignores an aborted redirect and keeps the login window available', async () => {
    const f = fixture(); await f.sessions.setScope('scope-a'); const open = f.sessions.open.bind(f.sessions);
    vi.spyOn(f.sessions, 'open').mockImplementation(async (...args) => {
      const win = await open(...args);
      vi.mocked(win.loadURL).mockImplementation(async (url: string) => {
        f.windows[0].url = url;
        queueMicrotask(() => {
          win.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', url, true);
          f.windows[0].url = 'https://www.youtube.com/';
          win.webContents.emit('dom-ready');
        });
        throw new Error('ERR_ABORTED');
      });
      return win;
    });
    await expect(f.sessions.login('youtube')).resolves.toBeDefined();
    await f.sessions.close();
  });
  it('closes failed windows and returns a sanitized network error', async () => {
    const f = fixture(); await f.sessions.setScope('scope-a'); const open = f.sessions.open.bind(f.sessions);
    vi.spyOn(f.sessions, 'open').mockImplementation(async (...args) => {
      const win = await open(...args); vi.mocked(win.loadURL).mockRejectedValue(Error('ERR_BLOCKED_BY_CLIENT https://site.example/?secret=private')); return win;
    });
    await expect(f.sessions.login('bilibili')).rejects.toThrow('ERR_BLOCKED_BY_CLIENT');
    expect(f.windows[0].destroyed).toBe(true);
    expect(f.windows[0].webContents.listenerCount('did-fail-load')).toBe(0);
    await f.sessions.close();
  });
  it('times out and cleans an unresponsive login instead of leaving an empty window', async () => {
      const f = fixture(10); await f.sessions.setScope('scope-a'); const open = f.sessions.open.bind(f.sessions);
      vi.spyOn(f.sessions, 'open').mockImplementation(async (...args) => { const win = await open(...args); vi.mocked(win.loadURL).mockImplementation(() => new Promise(() => {})); return win; });
      await expect(f.sessions.login('bilibili')).rejects.toThrow('超时');
      expect(f.windows[0].destroyed).toBe(true); await f.sessions.close();
  });
  it('does not mistake about:blank DOM readiness for a usable login page', async () => {
    const f = fixture(10); await f.sessions.setScope('scope-a'); const open = f.sessions.open.bind(f.sessions);
    vi.spyOn(f.sessions, 'open').mockImplementation(async (...args) => { const win = await open(...args); vi.mocked(win.loadURL).mockImplementation(async () => { queueMicrotask(() => win.webContents.emit('dom-ready')); await new Promise(() => {}); }); return win; });
    await expect(f.sessions.login('bilibili')).rejects.toThrow('超时');
    expect(f.windows[0].destroyed).toBe(true); await f.sessions.close();
  });
  it('handles main-frame load errors and closing during a pending login', async () => {
    for (const event of ['closed', 'did-fail-load']) {
      const f = fixture(); await f.sessions.setScope('scope-a'); const open = f.sessions.open.bind(f.sessions);
      vi.spyOn(f.sessions, 'open').mockImplementation(async (...args) => { const win = await open(...args); vi.mocked(win.loadURL).mockImplementation(async () => { queueMicrotask(() => event === 'closed' ? win.destroy() : win.webContents.emit('did-fail-load', {}, -105, 'secret URL', '', true)); await new Promise(() => {}); }); return win; });
      await expect(f.sessions.login('bilibili')).rejects.toThrow(event === 'closed' ? '已关闭' : 'NET_-105');
      expect(f.windows[0].destroyed).toBe(true); await f.sessions.close();
    }
  });
});
