import type { App } from "obsidian";
import { createHash } from "node:crypto";
import { setTimeout, clearTimeout } from 'node:timers';
import { isPublicAddress, lookupWithSignal } from "./adapters/network";
import { loginFor, loginOrigin, loginDomains, observedAccount, type LoginPlatform } from "./config";
import type { AccountProfile } from "./account-profile";
// Structural boundary: electron.remote is supplied by some Obsidian desktop hosts.
// No remote package or browser runtime is installed if the host lacks it.
export interface SiteCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure?: boolean;
  httpOnly?: boolean;
  expirationDate?: number;
  sameSite?: string;
}
export interface SiteSession {
  cookies: {
    get(filter: { url?: string }): Promise<SiteCookie[]>;
    set(cookie: Record<string, unknown>): Promise<void>;
  };
  clearStorageData(): Promise<void>;
  setPermissionRequestHandler(handler: unknown): void;
  setPermissionCheckHandler(handler: unknown): void;
  webRequest: {
    onBeforeRequest(
      filter: unknown,
      handler: (
        details: { url: string },
        callback: (result: { cancel: boolean }) => void,
      ) => void,
    ): void;
  };
  on(name: string, handler: (event: { preventDefault(): void }) => void): void;
}
// Electron host objects are deliberately confined to this module and the page collector.
export interface SiteWindow {
  loadURL(url: string): Promise<void>;
  destroy(): void;
  isDestroyed(): boolean;
  show?(): void;
  focus?(): void;
  on(name: string, callback: (...args: any[]) => void): void;
  removeListener?(name: string, callback: (...args: any[]) => void): void;
  webContents: any;
}
interface StorageState {
  origin: string;
  values: Record<string, string>;
}
interface SavedSessionState {
  cookies: SiteCookie[];
  storages: StorageState[];
}
interface FrameLike {
  url?: unknown;
  frames?: FrameLike[];
  executeJavaScript?(script: string, userGesture?: boolean): Promise<unknown>;
}
function validStorage(value: unknown): value is StorageState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const storage = value as Partial<StorageState>;
  if (typeof storage.origin !== "string" || !storage.values ||
      typeof storage.values !== "object" || Array.isArray(storage.values)) return false;
  return Object.values(storage.values).every((item) => typeof item === "string") &&
    JSON.stringify(storage.values).length <= 512 * 1024;
}
function storageAuthenticatesLizhi(storage: StorageState): boolean {
  const raw = storage.values["__kefu-taco__default__"];
  if (!raw?.trim()) return false;
  const variants = [raw];
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded !== raw) variants.push(decoded);
  } catch { /* Keep the raw value. */ }
  const hasValue = (value: unknown): boolean =>
    (typeof value === "string" && !!value.trim() && value !== "0" && value !== "null" && value !== "undefined") ||
    (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
  const hasToken = (value: unknown, depth = 0): boolean => {
    if (depth > 8 || value === null || value === undefined) return false;
    if (Array.isArray(value)) return value.some((item) => hasToken(item, depth + 1));
    if (typeof value !== "object")
      return typeof value === "string" && /(?:^|[?&,;{}\s])["']?lztacokefu["']?\s*(?:=|:)\s*["']?([^&,;{}\s"']+)/i.test(value);
    const row = value as Record<string, unknown>;
    for (const [key, item] of Object.entries(row))
      if ((key === "lztacokefu" && hasValue(item)) || hasToken(item, depth + 1)) return true;
    return false;
  };
  for (const value of variants) {
    try {
      if (hasToken(JSON.parse(value))) return true;
    } catch { /* Some builds store a URL-encoded or delimiter-based string. */ }
    if (hasToken(value)) return true;
  }
  return false;
}
function storageAuthenticatesYuanbao(storage: StorageState): boolean {
  const userId = storage.values.yb_user_id;
  const auth = storage.values.LOCAL_AUTH_INFO_KEY_yuanbao?.trim();
  if (!/^(?:[1-9]\d{0,39}|[0-9a-f]{32})$/i.test(userId?.trim() || '') || !auth)
    return false;
  try {
    const info = JSON.parse(auth) as Record<string, unknown>;
    const anon = info.anonUser as Record<string, unknown> | undefined;
    return info.auth === true && info.status === 2 &&
      (!anon || anon.isAnon !== true);
  } catch {
    // Older Yuanbao builds may store an opaque token instead of profile JSON.
    return /[1-9a-f]/i.test(auth) && !/^\s*(?:anon|anonymous|visitor)\s*$/i.test(auth);
  }
}
function frameTree(root?: FrameLike): FrameLike[] {
  if (!root) return [];
  const rows: FrameLike[] = [];
  const seen = new Set<FrameLike>();
  const visit = (frame: FrameLike) => {
    if (seen.has(frame)) return;
    seen.add(frame);
    rows.push(frame);
    for (const child of frame.frames || []) visit(child);
  };
  visit(root);
  return rows;
}
const READ_LOCAL_STORAGE =
  "(() => Object.fromEntries(Object.entries(localStorage)))()";
const RESTORE_LOCAL_STORAGE = (values: Record<string, string>) =>
  `(() => { const values = ${JSON.stringify(values)}; let changed = false; for (const [key,value] of Object.entries(values)) if (localStorage.getItem(key) === null) { localStorage.setItem(key,value); changed = true; } if(changed) location.reload(); })()`;
function oauthDomains(platform: LoginPlatform): string[] {
  return platform === "twitter"
    ? ["x.com", "twitter.com", "t.co", "google.com", "googleapis.com", "gstatic.com", "googleusercontent.com"]
    : loginDomains(platform);
}
function googleOAuthUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      (url.hostname === "accounts.google.com" || url.hostname.endsWith(".google.com"));
  } catch {
    return false;
  }
}
function usesExternalGoogleOAuth(platform: LoginPlatform): boolean {
  return platform === "youtube" || platform === "twitter";
}
const BROWSER_COOKIE_CACHE_MS = 5_000;
const AUTH_COOKIE_NAMES: Partial<Record<LoginPlatform, string[]>> = {
  bilibili: ["SESSDATA"],
  douyin: ["sessionid", "sessionid_ss"],
  xiaohongshu: ["web_session"],
  zhihu: ["z_c0"],
  weibo: ["SUB", "SUBP"],
};
function authFingerprint(cookies: SiteCookie[], platform: LoginPlatform): string {
  const names = AUTH_COOKIE_NAMES[platform] || [];
  return createHash("sha256")
    .update(cookies
      .filter(cookie => !names.length || names.includes(cookie.name))
      .map(cookie => `${cookie.name}\0${cookie.value}\0${cookie.domain}\0${cookie.path}`)
      .sort()
      .join("\n"))
    .digest("hex");
}
function openExternal(value: string): void {
  try {
    const electron = require("electron");
    const shell = electron?.shell || electron?.remote?.shell;
    if (shell?.openExternal) void shell.openExternal(value);
  } catch {
    /* The host may not expose Electron shell; the login window remains usable. */
  }
}
export interface SiteRuntime {
  BrowserWindow: new (options: Record<string, unknown>) => SiteWindow;
  session: { fromPartition(name: string): SiteSession };
}
export type BrowserCookieProvider = (
  platform: LoginPlatform,
  signal: AbortSignal,
) => Promise<SiteCookie[]>;
export function hostRuntime(): SiteRuntime {
  const runtime = require("electron").remote as SiteRuntime | undefined;
  if (!runtime?.BrowserWindow || !runtime.session?.fromPartition)
    throw new Error("当前宿主未提供独立登录窗口，需登录的能力不可用");
  return runtime;
}
// Several source sites return an empty shell or a 404 to Electron's default
// user agent. Keep the isolated login session browser-like while retaining the
// host/domain allowlist below.
const LOGIN_USER_AGENT =
  // Keep the declared browser version aligned with Obsidian 1.14's bundled
  // Chromium 150. A mismatched future Chrome version is rejected by Google
  // sign-in as an embedded or unsupported client.
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.250 Safari/537.36";
export class AuthorizationRequired extends Error {}
export class LoginWindowError extends Error {
  constructor(readonly code: string) {
    super(code === 'LOGIN_TIMEOUT'
      ? '登录页面加载超时，请检查网络或代理后重新登录'
      : code === 'LOGIN_CLOSED' ? '登录窗口已关闭，请重新登录'
      : `登录页面打开失败（${code}），请检查网络或代理后重试`);
  }
}
export class SiteSessions {
  private scope = "";
  private transitions: Promise<void> = Promise.resolve();
  private sessions = new Map<LoginPlatform, SiteSession>();
  private windows = new Set<SiteWindow>();
  private webDomains: string[] = [];
  private browserCookieProvider?: BrowserCookieProvider;
  private browserCookieCache?: { at: number; cookies: SiteCookie[] };
  setWebDomains(domains: string[]): void { this.webDomains = [...domains]; }
  setBrowserCookieProvider(provider?: BrowserCookieProvider): void {
    this.browserCookieProvider = provider;
    this.browserCookieCache = undefined;
  }
  targetFor(url: string): LoginPlatform { return loginFor(url, this.webDomains); }
  private savedState(platform: LoginPlatform): SavedSessionState {
    const raw = this.app.secretStorage.getSecret(this.secret(platform));
    if (!raw) return { cookies: [], storages: [] };
    const value = JSON.parse(raw) as SiteCookie[] | {
      version?: number;
      cookies?: SiteCookie[];
      storage?: unknown;
      storages?: unknown;
    };
    if (Array.isArray(value)) return { cookies: value, storages: [] };
    if (!Array.isArray(value.cookies)) throw new Error('登录凭据格式无效');
    if (value.version === 2 && validStorage(value.storage))
      return { cookies: value.cookies, storages: [value.storage] };
    if (value.version === 3 && Array.isArray(value.storages) &&
        value.storages.length <= 12 && value.storages.every(validStorage))
      return { cookies: value.cookies, storages: value.storages };
    throw new Error('登录凭据格式无效');
  }
  hasLocalStorageAuthorization(platform: LoginPlatform): boolean {
    try {
      const storages = this.savedState(platform).storages.filter(storage =>
        this.allowed(platform, storage.origin + "/") && Object.keys(storage.values).length > 0,
      );
      return platform === "lizhi"
        ? storages.some(storageAuthenticatesLizhi)
        : platform === "wechat-channel"
          ? storages.some(storageAuthenticatesYuanbao)
        : storages.length > 0;
    }
    catch { return false; }
  }
  constructor(
    private readonly app: App,
    private readonly runtime: () => SiteRuntime = hostRuntime,
    private readonly loginTimeoutMs = 30000,
  ) {}
  setScope(scope: string): Promise<void> {
    this.transitions = this.transitions
      .catch(() => undefined)
      .then(async () => {
        if (this.scope === scope) return;
        await this.disposeCurrent();
        this.scope = scope;
      });
    return this.transitions;
  }
  private secret(platform: LoginPlatform): string {
    return (
      "clipmd-desktop-" +
      createHash("sha256")
        .update(this.scope + "\n" + platform)
        .digest("hex")
        .slice(0, 48)
    );
  }
  private partition(platform: LoginPlatform): string {
    const identity = this.scope
      ? createHash("sha256").update(this.scope).digest("hex").slice(0, 24)
      : "unbound";
    const target = platform.startsWith("web:")
      ? "web-" + createHash("sha256").update(platform).digest("hex").slice(0, 24)
      : platform;
    // Electron partitions without persist: are in-memory. A deterministic
    // identity lets a plugin reload recover an unfinished login without
    // writing the site session to Chromium's disk profile.
    return `clipmd-desktop-${identity}-${target}`;
  }
  allowed(platform: LoginPlatform, url: string): boolean {
    try {
      const u = new URL(url),
        host = u.hostname;
      return (
        u.protocol === "https:" &&
        !u.username &&
        !u.password &&
        loginDomains(platform).some(domain => host === domain || host.endsWith("." + domain))
      );
    } catch {
      return false;
    }
  }
  private async session(platform: LoginPlatform): Promise<SiteSession> {
    await this.transitions;
    const expectedScope = this.scope;
    if (!this.scope) throw new Error("请先启用并绑定 Clip2MD 主插件");
    const existing = this.sessions.get(platform);
    if (existing) return existing;
    const session = this.runtime().session.fromPartition(this.partition(platform));
    session.setPermissionRequestHandler(
      (
        _web: unknown,
        _permission: unknown,
        callback: (allowed: boolean) => void,
      ) => callback(false),
    );
    session.setPermissionCheckHandler(() => false);
    session.on("will-download", (event) => event.preventDefault());
    session.webRequest.onBeforeRequest(
      { urls: ["<all_urls>"] },
      (details, callback) => {
        let parsed: URL;
        try {
          parsed = new URL(details.url);
        } catch {
          callback({ cancel: true });
          return;
        }
        // Login pages use data/blob resources and cross-origin public CDNs.
        // Navigation is still restricted by will-navigate/will-redirect below;
        // this hook only prevents requests to private/local network addresses.
        if (!["https:", "http:"].includes(parsed.protocol)) {
          callback({ cancel: !["data:", "blob:"].includes(parsed.protocol) });
          return;
        }
        void (async () => {
          const signal = AbortSignal.timeout(5000);
          const rows = await lookupWithSignal(
            parsed.hostname.replace(/^\[|\]$/g, ""),
            signal,
          );
          return (
            rows.length > 0 && rows.every((row) => isPublicAddress(row.address))
          );
        })().then(
          (allowed) => callback({ cancel: !allowed }),
          () => callback({ cancel: true }),
        );
      },
    );
    const stored = this.app.secretStorage.getSecret(this.secret(platform));
    if (stored) {
      try {
        const cookies = this.savedState(platform).cookies;
        if (!Array.isArray(cookies) || cookies.length > 200) throw new Error();
        for (const cookie of cookies) {
          const url =
            "https://" +
            cookie.domain.replace(/^\./, "") +
            (cookie.path || "/");
          if (
            this.allowed(platform, url) &&
            (!cookie.expirationDate ||
              cookie.expirationDate > Date.now() / 1000)
          )
            await session.cookies.set({ ...cookie, url });
        }
      } catch {
        await session.clearStorageData();
        throw new Error("本机登录凭据损坏，请撤销后重新授权");
      }
    }
    if (this.scope !== expectedScope) {
      await session.clearStorageData();
      throw new Error("原站授权上下文已变化");
    }
    this.sessions.set(platform, session);
    return session;
  }
  async cookieHeader(url: string): Promise<string> {
    let platform: LoginPlatform;
    try { platform = this.targetFor(url); } catch { return ''; }
    if (!this.allowed(platform, url) || !this.scope) return '';
    // Do not create a host session for public extraction without an existing authorization.
    if (
      !this.sessions.has(platform) &&
      !this.app.secretStorage.getSecret(this.secret(platform))
    )
      return "";
    const cookies = await (
      await this.session(platform)
    ).cookies.get({ url });
    return cookies
      .filter((c) => !/[\r\n;]/.test(c.name + c.value))
      .map((c) => c.name + "=" + c.value)
      .join("; ");
  }
  hasStoredAuthorization(platform: LoginPlatform): boolean {
    return !!this.scope && !!this.app.secretStorage.getSecret(this.secret(platform));
  }
  async authorizedCookies(platform: LoginPlatform, signal?: AbortSignal): Promise<SiteCookie[]> {
    const browserAllowed = (platform === "youtube" || platform === "twitter") && !!this.browserCookieProvider;
    if (
      !this.scope ||
      (!this.sessions.has(platform) &&
        !this.app.secretStorage.getSecret(this.secret(platform)) &&
        !browserAllowed)
    )
      return [];
    let cookies = await this.cookies(platform);
    if ((platform === "youtube" || platform === "twitter") && this.browserCookieProvider) {
      const now = Date.now();
      const browser = this.browserCookieCache && now - this.browserCookieCache.at < BROWSER_COOKIE_CACHE_MS
        ? this.browserCookieCache.cookies
        : await this.browserCookieProvider(platform, signal || AbortSignal.timeout(35_000));
      this.browserCookieCache = { at: now, cookies: browser };
      const session = await this.session(platform);
      for (const cookie of browser) {
        if (!this.allowed(platform, "https://" + cookie.domain.replace(/^\./, "") + (cookie.path || "/"))) continue;
        try {
          await session.cookies.set({ ...cookie, url: "https://" + cookie.domain.replace(/^\./, "") + (cookie.path || "/") });
        } catch { /* Ignore a stale browser cookie and retain other cookies. */ }
      }
      cookies = [...cookies, ...browser];
    }
    return cookies.filter((c) =>
      this.allowed(platform, "https://" + c.domain.replace(/^\./, "") + "/"),
    );
  }
  /**
   * Detect the small set of first-party login cookies whose names and paired
   * values are stable enough to confirm a browser login without scraping a
   * nickname or treating analytics cookies as authorization.
   */
  async cookieLoginProfile(platform: LoginPlatform, win?: SiteWindow): Promise<Extract<AccountProfile, { state: "authenticated" }> | undefined> {
    const cookies = await this.authorizedCookies(platform);
    const valid = (name: string) => cookies.some(cookie =>
      cookie.name === name && !!cookie.value &&
      (!cookie.expirationDate || cookie.expirationDate > Date.now() / 1000));
    if (platform === "csdn" && valid("UserToken") && (valid("UserName") || valid("UserInfo")))
      return { state: "authenticated", nickname: "csdn.net", sessionOnly: true };
    if (platform === "zhihu" && valid("z_c0"))
      return { state: "authenticated", nickname: "zhihu.com", sessionOnly: true };
    if (platform === "douban" && valid("dbcl2"))
      return { state: "authenticated", nickname: "douban.com", sessionOnly: true };
    if (platform === "xiaohongshu" && valid("web_session"))
      return { state: "authenticated", nickname: "xiaohongshu.com", sessionOnly: true };
    if (platform === "weibo" && (valid("SUB") || valid("SUBP")))
      return { state: "authenticated", nickname: "weibo.com", sessionOnly: true };
    if (platform === "youtube" && [
      "SID", "HSID", "SSID", "APISID", "SAPISID", "LOGIN_INFO",
      "__Secure-1PSID", "__Secure-3PSID",
    ].some(valid))
      return { state: "authenticated", nickname: "youtube.com", sessionOnly: true };
    if (platform === "twitter" && valid("auth_token") && valid("ct0"))
      return { state: "authenticated", nickname: "x.com", sessionOnly: true };
    if (platform === "toutiao" && ["sessionid", "sessionid_ss", "sid_tt", "uid_tt", "uid_tt_ss"].some(valid))
      return { state: "authenticated", nickname: "toutiao.com", sessionOnly: true };
    if (platform === "kuaishou" && valid("userId"))
      return { state: "authenticated", nickname: "kuaishou.com", sessionOnly: true };
    if (platform === "xiaoyuzhou" && valid("x-jike-access-token"))
      return { state: "authenticated", nickname: "xiaoyuzhoufm.com", sessionOnly: true };
    if (platform === "applepodcasts" && valid("media-user-token"))
      return { state: "authenticated", nickname: "podcasts.apple.com", sessionOnly: true };
    if (platform === "lizhi" && valid("lztacokefu"))
      return { state: "authenticated", nickname: "lizhi.fm", sessionOnly: true };
    if (platform === "lizhi" && win &&
        (await this.frameStorages(platform, win)).some(storageAuthenticatesLizhi))
      return { state: "authenticated", nickname: "lizhi.fm", sessionOnly: true };
    if (platform === "wechat-channel" && win &&
        (await this.currentStorages(platform, win)).some(storageAuthenticatesYuanbao))
      return { state: "authenticated", nickname: "yuanbao.tencent.com", sessionOnly: true };
    return undefined;
  }
  /**
   * A re-login can reuse an isolated partition containing the previous,
   * still-valid Cookie. Compare only stable first-party auth values so an old
   * session cannot make a challenge window close before the user acts.
   */
  async cookieAuthFingerprint(platform: LoginPlatform): Promise<string> {
    return authFingerprint(await this.authorizedCookies(platform), platform);
  }
  /** Bind a resumable import to all saved authorization state, including localStorage-only logins. */
  async authorizationFingerprint(platform: LoginPlatform): Promise<string> {
    return createHash('sha256')
      .update(await this.cookieAuthFingerprint(platform))
      .update('\n')
      .update(this.app.secretStorage.getSecret(this.secret(platform)) || '')
      .digest('hex');
  }
  async cookies(platform: LoginPlatform): Promise<SiteCookie[]> {
    return (await this.session(platform)).cookies.get({});
  }
  private async frameStorages(platform: LoginPlatform, win: SiteWindow): Promise<StorageState[]> {
    if (win.isDestroyed()) return [];
    const web = win.webContents;
    const frames = frameTree(web.mainFrame as FrameLike | undefined);
    if (!frames.length && typeof web.executeJavaScript === "function") {
      const url: unknown = web.getURL?.();
      if (typeof url === "string" && this.allowed(platform, url))
        frames.push({ url, executeJavaScript: web.executeJavaScript.bind(web) });
    }
    const storages: StorageState[] = [];
    for (const frame of frames.slice(0, 12)) {
      try {
        const url = frame.url;
        if (typeof url !== "string" || !this.allowed(platform, url) ||
            typeof frame.executeJavaScript !== "function") continue;
        const values = await frame.executeJavaScript(READ_LOCAL_STORAGE, false);
        if (!values || typeof values !== "object" || Array.isArray(values) ||
            !Object.values(values).every(value => typeof value === "string") ||
            JSON.stringify(values).length > 512 * 1024) continue;
        const storage = { origin: new URL(url).origin, values: values as Record<string, string> };
        if (Object.keys(storage.values).length) storages.push(storage);
      } catch { /* A frame can navigate or be destroyed while it is inspected. */ }
    }
    return storages;
  }
  private async currentStorages(platform: LoginPlatform, win: SiteWindow): Promise<StorageState[]> {
    if (win.isDestroyed()) return [];
    const web = win.webContents;
    const url: unknown = web.getURL?.();
    const frame = web.mainFrame as FrameLike | undefined;
    const candidates = [
      { url: frame?.url, execute: frame?.executeJavaScript?.bind(frame) },
      {
        url,
        execute: typeof web.executeJavaScript === "function"
          ? web.executeJavaScript.bind(web)
          : undefined,
      },
    ];
    const merged = new Map<string, Record<string, string>>();
    for (const candidate of candidates) {
      if (typeof candidate.url !== "string" || !this.allowed(platform, candidate.url) ||
          typeof candidate.execute !== "function") continue;
      try {
        const values = await candidate.execute(READ_LOCAL_STORAGE, false);
        if (!values || typeof values !== "object" || Array.isArray(values) ||
            !Object.values(values).every(value => typeof value === "string") ||
            JSON.stringify(values).length > 512 * 1024) continue;
        const origin = new URL(candidate.url).origin;
        merged.set(origin, {
          ...merged.get(origin),
          ...(values as Record<string, string>),
        });
      } catch {
        // The frame can navigate while either top-level view is inspected.
      }
    }
    return [...merged]
      .filter(([, values]) => Object.keys(values).length > 0)
      .map(([origin, values]) => ({ origin, values }));
  }
  async save(
    platform: LoginPlatform,
    signal?: AbortSignal,
    win?: SiteWindow,
    confirmed = false,
    verifiedProfile?: Extract<AccountProfile, { state: "authenticated" }>,
  ): Promise<void> {
    signal?.throwIfAborted();
    const expectedScope = this.scope;
    const secret = this.secret(platform);
    const cookies = (await this.cookies(platform)).filter((c) =>
      this.allowed(platform, "https://" + c.domain.replace(/^\./, "") + "/"),
    );
    const names: Partial<Record<LoginPlatform, string[]>> = {
      bilibili: ["SESSDATA"],
      douyin: ["sessionid", "sessionid_ss"],
      xiaohongshu: ["web_session"],
      zhihu: ["z_c0"],
    };
    const storages = win
      ? [...await this.currentStorages(platform, win), ...await this.frameStorages(platform, win)]
        .filter((storage, index, rows) =>
          rows.findIndex(row => row.origin === storage.origin) === index,
        )
      : [];
    const validCookies = cookies.filter(c => !!c.value && (!c.expirationDate || c.expirationDate > Date.now()/1000));
    // A first-party self endpoint is stronger proof than a legacy
    // localStorage shape. Yuanbao can keep the session in HttpOnly cookies and
    // stop writing the old yb_user_id keys while /api/getuserinfo stays valid.
    // Only pass the profile returned by readAccountProfile here; the generic
    // confirmed flag still cannot authorize an observed platform.
    const apiVerified = platform === "wechat-channel" && !!verifiedProfile;
    const authorized = apiVerified || (platform === "lizhi"
      ? validCookies.some(cookie => cookie.name === "lztacokefu") ||
        storages.some(storageAuthenticatesLizhi)
      : platform === "wechat-channel"
        ? storages.some(storageAuthenticatesYuanbao)
      : observedAccount(platform)
        ? validCookies.some(c => names[platform]?.includes(c.name))
        : confirmed && (validCookies.length > 0 || storages.length > 0));
    if (!authorized)
      throw new AuthorizationRequired(
        "尚未检测到原站登录，请完成登录后保存授权",
      );
    if (this.scope !== expectedScope) throw new Error("原站授权上下文已变化");
    signal?.throwIfAborted();
    const value = storages.length
      ? JSON.stringify({ version: 3, cookies, storages })
      : JSON.stringify(cookies);
    this.app.secretStorage.setSecret(secret, value);
    if (this.app.secretStorage.getSecret(secret) !== value)
      throw new Error("登录凭据保存失败");
  }
  async revoke(platform: LoginPlatform): Promise<void> {
    this.app.secretStorage.setSecret(this.secret(platform), "");
    await this.sessions.get(platform)?.clearStorageData();
    this.sessions.delete(platform);
  }
  async open(platform: LoginPlatform, show = true): Promise<SiteWindow> {
    const session = await this.session(platform);
    const win = new (this.runtime().BrowserWindow)({
      show,
      width: 1100,
      height: 850,
      webPreferences: {
        session,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
      },
    });
    this.windows.add(win);
    win.webContents.setUserAgent?.(LOGIN_USER_AGENT);
    // Restore each allowed frame independently. Lizhi's listener token lives in
    // a Taco subframe whose origin differs from the main login application.
    // One reload makes the site's startup code consume the restored value.
    if (this.hasLocalStorageAuthorization(platform)) {
      let restoring = false;
      const restore = async () => {
        if (restoring || win.isDestroyed()) return;
        restoring = true;
        try {
          const stored = this.savedState(platform).storages;
          const frames = frameTree(win.webContents.mainFrame as FrameLike | undefined);
          if (!frames.length && typeof win.webContents.executeJavaScript === 'function')
            frames.push({ url: win.webContents.getURL?.(), executeJavaScript: win.webContents.executeJavaScript.bind(win.webContents) });
          for (const frame of frames.slice(0, 12)) {
            const url = frame.url;
            if (typeof url !== 'string' || !this.allowed(platform, url) ||
                typeof frame.executeJavaScript !== 'function') continue;
            const state = stored.find(item => item.origin === new URL(url).origin);
            if (!state || !this.allowed(platform, state.origin + '/')) continue;
            await frame.executeJavaScript(RESTORE_LOCAL_STORAGE(state.values), false);
          }
        } catch { /* Cookie restoration already reports damaged credentials. */ }
        finally { restoring = false; }
      };
      win.webContents.on('dom-ready', () => { void restore(); });
      win.webContents.on('did-frame-finish-load', () => { void restore(); });
    }
    win.webContents.setWindowOpenHandler((details: { url?: string }) => {
      if (typeof details.url === "string" && (this.allowed(platform, details.url) || this.allowedOAuth(platform, details.url))) {
        if (usesExternalGoogleOAuth(platform) && googleOAuthUrl(details.url)) openExternal(details.url);
        else void win.loadURL(details.url);
      }
      return { action: "deny" };
    });
    win.on("closed", () => this.windows.delete(win));
    // Obsidian installs an app-page navigation handler on every WebContents.
    // It cancels source-site reloads and opens them externally, so Douyin's
    // initial cookie challenge remains an empty document. Replace that handler
    // only on this owned, sandboxed window with our site-specific policy.
    win.webContents.removeAllListeners('will-navigate');
    for (const name of ["will-navigate", "will-redirect"])
      win.webContents.on(
        name,
        (event: { preventDefault(): void }, url: string) => {
          if (usesExternalGoogleOAuth(platform) && googleOAuthUrl(url)) {
            event.preventDefault();
            openExternal(url);
          } else if (!this.allowed(platform, url) && !this.allowedOAuth(platform, url)) event.preventDefault();
        },
      );
    return win;
  }
  private allowedOAuth(platform: LoginPlatform, value: string): boolean {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password &&
        oauthDomains(platform).some(domain => url.hostname === domain || url.hostname.endsWith("." + domain));
    } catch {
      return false;
    }
  }
  async login(platform: LoginPlatform, beforeNavigate?: (win: SiteWindow) => Promise<void>, targetUrl?: string): Promise<SiteWindow> {
    const win = await this.open(platform);
    try {
      await beforeNavigate?.(win);
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          win.webContents.removeListener?.('dom-ready', ready);
          win.webContents.removeListener?.('did-fail-load', failed);
          win.removeListener?.('closed', closed);
          if (error) reject(error); else resolve();
        };
        // Waiting for every homepage/analytics request can leave a visible but
        // blank login window indefinitely. A trusted main document is enough.
        const ready = () => {
          const url: unknown = win.webContents.getURL?.();
          if (typeof url === 'string' && this.allowed(platform, url)) finish();
        };
        const failed = (_event: unknown, code: number, _description: string, _url: string, mainFrame: boolean) => {
          // Chromium reports -3/ERR_ABORTED for an expected redirect or a
          // second navigation started by the site. Keep waiting for the
          // trusted destination's dom-ready event.
          if (mainFrame && code !== -3)
            finish(new LoginWindowError(`NET_${Number.isInteger(code) ? code : 'FAILED'}`));
        };
        const closed = () => finish(new LoginWindowError('LOGIN_CLOSED'));
        const timer = setTimeout(() => finish(new LoginWindowError('LOGIN_TIMEOUT')), this.loginTimeoutMs);
        win.webContents.on('dom-ready', ready);
        win.webContents.on('did-fail-load', failed);
        win.on('closed', closed);
        const destination = typeof targetUrl === "string" && this.allowed(platform, targetUrl)
          ? targetUrl
          : loginOrigin(platform);
        void Promise.resolve().then(() => win.loadURL(destination)).then(async () => {
          // Xiaoyuzhou and Toutiao expose login as a modal on the home page.
          // Open it for the user instead of leaving a blank-looking homepage.
          // Weibo's live page can spend several seconds hydrating its header,
          // so wait for an exact first-party trigger instead of clicking broad
          // navigation controls.
          if (platform === "weibo" || platform === "wechat-channel") {
            const overlaySelector = platform === "wechat-channel"
              ? '.hyc-login__dialog,.hyc-login__content,[class*="hyc-login__dialog"],iframe[src*="open.weixin.qq.com/connect/qrconnect"]'
              : '[node-type="loginForm"],[class*="LoginPanel"],[class*="login-dialog"],[class*="login-modal"],[class*="loginDialog"]';
            const trigger = `(() => {
                  const overlay = document.querySelector(${JSON.stringify(overlaySelector)});
                  if (overlay) return "opened";
                  const candidates = [...document.querySelectorAll(${JSON.stringify(platform === "wechat-channel"
                    ? '.agent-dialogue__tool__login,button,a,[role="button"]'
                    : '[node-type="loginBtn"],.loginBtn,a[action-type="login"],[data-testid="loginButton"],button,a,[role="button"]')})];
                  const visible = el => {
                    const rect = el.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0 &&
                      getComputedStyle(el).visibility !== "hidden" &&
                      getComputedStyle(el).display !== "none";
                  };
                  const explicit = candidates.find(el => {
                    if (!visible(el)) return false;
                    return ${platform === "wechat-channel"
                      ? 'el.matches(".agent-dialogue__tool__login")'
                      : 'el.matches("[node-type=\\"loginBtn\\"],.loginBtn,a[action-type=\\"login\\"],[data-testid=\\"loginButton\\"]")'};
                  });
                  const labelled = candidates.find(el => {
                    if (!visible(el)) return false;
                    const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
                    return /^(?:登录|登录\\s*\\/\\s*注册|登录注册)$/.test(text) &&
                      el.matches("button,a,[role=button]");
                  });
                  const node = explicit || labelled;
                  if (!(node instanceof HTMLElement)) return "waiting";
                  node.click();
                  return "clicked";
                })()`;
            const openOverlay = async () => {
              let overlayClicked = false;
              for (let index = 0; index < 60 && !win.isDestroyed(); index++) {
                const state = await win.webContents.executeJavaScript?.(trigger, false).catch(() => "waiting");
                if (state === "opened") {
                  if (platform === "wechat-channel") {
                    const chooseWechat = `(() => {
                      const node = [...document.querySelectorAll(
                        ".t-radio-button,[role=radio]"
                      )].find(el => {
                        const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
                        const rect = el.getBoundingClientRect();
                        return text === "微信" && rect.width > 0 && rect.height > 0;
                      });
                      if (!(node instanceof HTMLElement)) return false;
                      node.click();
                      return true;
                    })()`;
                    await Promise.resolve(
                      win.webContents.executeJavaScript?.(chooseWechat, false),
                    ).catch(() => false);
                  }
                  return;
                }
                if (state === "clicked") overlayClicked = true;
                // The click may synchronously create the overlay, but hydrated
                // sites sometimes open it on the following task. Stop clicking
                // once it appears and keep the window open for the login.
                if (overlayClicked) {
                  const opened = await win.webContents.executeJavaScript?.(
                    `Boolean(document.querySelector(${JSON.stringify(overlaySelector)}))`,
                    false,
                  ).catch(() => false);
                  if (opened) {
                    await pause(250);
                    const selected = await Promise.resolve(
                      win.webContents.executeJavaScript?.(
                        `(() => {
                        const node = [...document.querySelectorAll(
                          ".t-radio-button,[role=radio]"
                        )].find(el => {
                          const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
                          const rect = el.getBoundingClientRect();
                          return text === "微信" && rect.width > 0 && rect.height > 0;
                        });
                        if (!(node instanceof HTMLElement)) return false;
                        node.click();
                        return true;
                      })()`,
                        false,
                      ),
                    ).catch(() => false);
                    if (selected === true || platform !== "wechat-channel") return;
                  }
                }
                await pause(250);
              }
            };
            // The native window and the confirmation modal should appear
            // immediately. Header hydration and overlay opening continue in
            // the background on this same first-party window.
            void openOverlay();
          } else if (platform === "xiaoyuzhou" || platform === "toutiao") {
            const trigger = `(() => {
                  const nodes = [...document.querySelectorAll("button,a,[role=button],span,div")];
                  const node = nodes.find(el => {
                    const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
                    return /^(?:登录|登录\\s*\\/\\s*注册|登录注册)$/.test(text);
                  });
                  if (!(node instanceof HTMLElement)) return false;
                  node.click();
                  return true;
                })()`;
            await win.webContents.executeJavaScript?.(trigger, false).catch(() => false);
          }
          finish();
        }, (error: unknown) => {
          const raw = error instanceof Error ? error.message : '';
          if (/\bERR_ABORTED\b/.test(raw)) return;
          finish(new LoginWindowError(raw.match(/\bERR_[A-Z_]+\b/)?.[0] || 'LOAD_FAILED'));
        });
      });
      if (win.isDestroyed()) throw new LoginWindowError('LOGIN_CLOSED');
      win.show?.(); win.focus?.();
      return win;
    } catch (error) {
      this.release(win);
      throw error;
    }
  }
  release(win: SiteWindow): void {
    try { if (!win.isDestroyed()) win.destroy(); } catch { /* The native window may already be gone. */ }
    this.windows.delete(win);
  }
  close(): Promise<void> {
    this.transitions = this.transitions
      .catch(() => undefined)
      .then(async () => {
        await this.disposeCurrent(false);
        this.scope = "";
      });
    return this.transitions;
  }
  private async disposeCurrent(clearStorage = true): Promise<void> {
    for (const win of this.windows) this.release(win);
    if (clearStorage)
      await Promise.all(
        [...this.sessions.values()].map((session) =>
          session.clearStorageData().catch(() => undefined),
        ),
      );
    this.sessions.clear();
  }
}

function pause(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
