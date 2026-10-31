import { withAbort } from './async';
import { SiteSessions, AuthorizationRequired, type SiteWindow } from './auth';
import { favoriteIdentity, type FavoritePlatform } from './companion-protocol';

export interface FavoriteItem {
    platform: FavoritePlatform;
    id: string;
    url: string;
    title: string;
    author?: string;
    collectedAt?: string;
    thumbnail?: string;
}
export interface FavoritePage { items: FavoriteItem[]; skipped: number; hasMore: boolean; cursor: string; }
export interface FavoriteProgress { page: FavoritePage; label: string; }
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 240) : '';
function address(value: unknown): string | undefined {
    try { const url = new URL(String(value)); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return; }
}
function date(value: unknown): string | undefined {
    const timestamp = Number(value);
    if (timestamp > 0 && Number.isFinite(timestamp)) {
        const date = new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp);
        if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
    return undefined;
}
function unavailable(row: Record<string, unknown>): boolean {
    const status = object(row.status || row.aweme_status);
    return row.is_deleted === true || row.is_deleted === 1 || row.is_private === true || row.is_private === 1
        || status.is_delete === true || status.is_prohibited === true || status.item_is_private === true || status.private_status === 1
        || /^(?:已失效(?:(?:的)?视频)?|视频已删除|已删除|私密作品)$/.test(text(row.title || row.desc));
}
function item(platform: FavoritePlatform, raw: unknown): FavoriteItem | undefined {
    const row = object(raw), card = object(row.note_card || row.noteCard);
    if (unavailable(row)) return;
    let url = '', title = '', author = '', thumbnail: unknown, collected: unknown;
    if (platform === 'bilibili') {
        if (row.type !== 2 || Number(row.attr) & 1) return;
        const id = text(row.bvid) || (Number.isSafeInteger(row.id) && Number(row.id) > 0 ? `av${Number(row.id)}` : '');
        url = `https://www.bilibili.com/video/${id}`; title = text(row.title); author = text(object(row.upper).name); thumbnail = row.cover; collected = row.fav_time;
    } else if (platform === 'xiaohongshu') {
        if (row.model_type && row.model_type !== 'note' || unavailable(card)) return;
        const id = text(row.note_id || row.noteId || row.id || card.note_id || card.noteId);
        if (!/^[a-f0-9]{24}$/i.test(id)) return;
        url = `https://www.xiaohongshu.com/explore/${id}`;
        const token = text(row.xsec_token || row.xsecToken || card.xsec_token);
        if (token) url += `?xsec_token=${encodeURIComponent(token)}`;
        title = text(card.display_title || card.displayTitle || card.title || row.display_title || row.displayTitle || row.title);
        author = text(object(card.user || row.user).nickname);
        thumbnail = object(card.cover || row.cover).url_default || object(card.cover || row.cover).urlDefault || object(card.cover || row.cover).url;
        collected = row.collect_time;
    } else {
        const id = typeof row.aweme_id === 'string' ? row.aweme_id : '';
        if (!/^[1-9]\d{0,19}$/.test(id) || ![0, 4, 68, 150].includes(Number(row.aweme_type))) return;
        const gallery = Array.isArray(row.images) && row.images.length > 0 || Number(row.aweme_type) === 68;
        url = `https://www.douyin.com/${gallery ? 'note' : 'video'}/${id}`;
        title = text(row.desc); author = text(object(row.author).nickname);
        const covers = object(object(row.video).cover).url_list;
        thumbnail = Array.isArray(covers) ? covers[0] : undefined;
        collected = row.collect_time;
    }
    const identity = favoriteIdentity(url, platform);
    return identity ? { platform, id: identity.id, url: identity.url, title: title || identity.id,
        ...(author ? { author } : {}), ...(date(collected) ? { collectedAt: date(collected) } : {}), ...(address(thumbnail) ? { thumbnail: address(thumbnail) } : {}) } : undefined;
}
/** Parse only an explicitly identified favorites response, never a feed or arbitrary page state. */
export function parseFavoritePage(platform: FavoritePlatform, payload: unknown): FavoritePage {
    const root = object(payload), data = platform === 'douyin' ? root : object(root.data);
    const code = platform === 'douyin' ? root.status_code : root.code;
    if (code === -101 || code === -100 || code === 8) throw new AuthorizationRequired('原站登录已失效，请重新登录后读取收藏');
    if (code !== 0 || platform === 'xiaohongshu' && root.success !== true) throw new Error('原站收藏接口暂不可用，请在原站完成验证后重试');
    const rows = platform === 'bilibili' ? data.medias : platform === 'xiaohongshu' ? data.notes : data.aweme_list;
    const more = data.has_more ?? data.hasMore;
    if (!Array.isArray(rows) && rows !== null || ![true, false, 0, 1].includes(more as boolean | number)) throw new Error('收藏分页格式发生变化，读取已停止');
    const source = Array.isArray(rows) ? rows : [];
    const items = source.map(row => item(platform, row)).filter((row): row is FavoriteItem => !!row);
    const cursorValue = data.cursor ?? data.max_cursor ?? (platform === 'xiaohongshu' ? object(source.at(-1)).id ?? object(source.at(-1)).note_id : undefined);
    const cursor = typeof cursorValue === 'string' || typeof cursorValue === 'number' && Number.isSafeInteger(cursorValue) ? String(cursorValue) : '';
    const hasMore = more === true || more === 1;
    if (hasMore && (!source.length || platform !== 'bilibili' && !cursor)) throw new Error('收藏分页未推进，读取已停止');
    return { items, skipped: source.length - items.length, hasMore, cursor };
}
export function favoriteEndpoint(platform: FavoritePlatform, value: string, selfId: string): boolean {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
        if (platform === 'xiaohongshu') return ['edith.xiaohongshu.com', 'www.xiaohongshu.com'].includes(url.hostname)
            && ['/api/sns/web/v1/note/collect/page', '/api/sns/web/v2/note/collect/page'].includes(url.pathname) && url.searchParams.get('user_id') === selfId;
        return platform === 'douyin' && url.hostname === 'www.douyin.com' && url.pathname === '/aweme/v1/web/aweme/listcollection/';
    } catch { return false; }
}
async function delay(ms: number, signal: AbortSignal): Promise<void> {
    await withAbort(new Promise<void>(resolve => window.setTimeout(resolve, ms)), signal);
}
/** Invoked in an owned first-party renderer. No cookies or page response text cross to the UI. */
async function requestJson(url: string): Promise<unknown> {
    // This function executes in a first-party renderer, where the site session signs its own requests.
    const response = await window.fetch(url, { credentials: 'include', cache: 'no-store' });
    if (!response.ok) throw new Error('收藏请求失败');
    return response.json() as Promise<unknown>;
}
/** Advances the favorites tab's actual scroller; visible-only controls avoid hidden template tabs. */
export function advanceFavoritePage(activate = false): boolean {
    const visible = (el: Element) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
    const tab = Array.from(document.querySelectorAll('button,[role=tab],a,span'))
        .find(el => visible(el) && el.textContent?.trim() === '收藏');
    if (activate && tab instanceof HTMLElement && tab.getAttribute('aria-selected') !== 'true' && !/active|selected/.test(tab.className)) tab.click();
    const scrollers = [document.scrollingElement, ...Array.from(document.querySelectorAll('main,[class*="scroll"],[class*="content"],[class*="container"]'))]
        .filter((el): el is HTMLElement => el instanceof HTMLElement && visible(el) && el.scrollHeight > el.clientHeight + 4);
    for (const el of scrollers) { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll', { bubbles: true })); }
    return tab instanceof HTMLElement;
}
interface FavoriteWebContents {
    getURL(): string;
    executeJavaScript(script: string, gesture: boolean): Promise<unknown>;
    debugger: {
        attach(version: string): void; detach(): void;
        on(event: string, fn: (event: unknown, method: string, params: { requestId: string; response?: { url: string; status: number } }) => void): void;
        removeListener(event: string, fn: (event: unknown, method: string, params: { requestId: string; response?: { url: string; status: number } }) => void): void;
        sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
    };
}
export async function loadFavoriteItems(platform: FavoritePlatform, sessions: SiteSessions, signal: AbortSignal, onPage: (progress: FavoriteProgress) => Promise<void>): Promise<void> {
    signal.throwIfAborted();
    const win = await sessions.open(platform, false), web = win.webContents as FavoriteWebContents;
    const stop = () => sessions.release(win);
    signal.addEventListener('abort', stop, { once: true });
    const run = async (script: string) => {
        signal.throwIfAborted();
        if (!sessions.allowed(platform, web.getURL())) throw new Error('收藏页面已离开原站，读取已停止');
        return withAbort(web.executeJavaScript(script, false), AbortSignal.any([signal, AbortSignal.timeout(20000)]));
    };
    const navigate = async (url: string) => { signal.throwIfAborted(); await withAbort(win.loadURL(url), AbortSignal.any([signal, AbortSignal.timeout(30000)])); };
    try {
        if (platform === 'bilibili') {
            await navigate('https://www.bilibili.com/');
            const get = async (url: string) => object(await run(`(${requestJson.toString()})(${JSON.stringify(url)})`));
            const nav = await get('https://api.bilibili.com/x/web-interface/nav'), me = object(nav.data);
            if (nav.code !== 0 || me.isLogin !== true || !Number.isSafeInteger(me.mid)) throw new AuthorizationRequired('请先登录 B站账号');
            const folderResponse = await get(`https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${Number(me.mid)}&type=2`);
            const folders = object(folderResponse.data).list ?? [];
            if (folderResponse.code !== 0 || !Array.isArray(folders)) throw new Error('无法读取 B站收藏夹，请稍后重试');
            for (const raw of folders) {
                const folder = object(raw);
                if (!Number.isSafeInteger(folder.id) || Number(folder.id) <= 0) throw new Error('收藏夹标识无效');
                const cursors = new Set<string>();
                for (let pn = 1; ; pn++) {
                    const payload = await get(`https://api.bilibili.com/x/v3/fav/resource/list?media_id=${Number(folder.id)}&pn=${pn}&ps=20&order=mtime&platform=web`);
                    const page = parseFavoritePage(platform, payload);
                    const medias = object(payload.data).medias;
                    const fingerprint = Array.isArray(medias) ? medias.map(row => String(object(row).id)).join(',') : '';
                    if (page.hasMore && cursors.has(fingerprint)) throw new Error('B站收藏分页未推进，请刷新后重试');
                    cursors.add(fingerprint);
                    await onPage({ page, label: `${text(folder.title) || '收藏夹'} · 第 ${pn} 页` });
                    if (!page.hasMore) break;
                    await delay(300, signal);
                }
            }
        } else await readSignedFavorites(platform, sessions, win, run, navigate, signal, onPage);
    } finally {
        signal.removeEventListener('abort', stop);
        sessions.release(win);
    }
}
async function readSignedFavorites(platform: Exclude<FavoritePlatform, 'bilibili'>, sessions: SiteSessions, win: SiteWindow,
    run: (script: string) => Promise<unknown>, navigate: (url: string) => Promise<void>, signal: AbortSignal,
    onPage: (progress: FavoriteProgress) => Promise<void>): Promise<void> {
    const web = win.webContents as FavoriteWebContents;
    let selfId = '', failure: Error | undefined, reading = false, finished = false, pages = 0;
    const pending = new Map<string, { self: boolean; url: string }>(), received: FavoritePage[] = [], cursors = new Set<string>();
    let processing: Promise<void> = Promise.resolve();
    const listener = (_event: unknown, method: string, params: { requestId: string; response?: { url: string; status: number } }) => {
        if (signal.aborted) return;
        if (method === 'Network.responseReceived' && params.response) {
            let url: URL;
            try { url = new URL(params.response.url); } catch { return; }
            const self = platform === 'xiaohongshu'
                ? url.hostname === 'edith.xiaohongshu.com' && ['/api/sns/web/v1/user/selfinfo', '/api/sns/web/v2/user/me'].includes(url.pathname)
                : url.hostname === 'www.douyin.com' && url.pathname === '/aweme/v1/web/user/profile/self/';
            const favorite = reading && favoriteEndpoint(platform, url.href, selfId);
            if (!self && !favorite) return;
            if (url.protocol !== 'https:' || url.username || url.password) return;
            if (params.response.status === 401) failure = new AuthorizationRequired('原站登录已失效，请重新登录');
            if (params.response.status !== 200) {
                if (favorite && !failure) failure = new Error('原站收藏列表访问受限，请完成验证后重试');
                return;
            }
            pending.set(params.requestId, { self, url: url.href });
        }
        if (method !== 'Network.loadingFinished') return;
        const request = pending.get(params.requestId); if (!request) return; pending.delete(params.requestId);
        processing = processing.then(async () => {
            const response = object(await withAbort(web.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId }), AbortSignal.any([signal, AbortSignal.timeout(10000)])));
            if (signal.aborted) return;
            if (typeof response.body !== 'string' || response.body.length > 4 * 1024 * 1024 || response.base64Encoded) throw new Error('收藏响应无法读取');
            const payload: unknown = JSON.parse(response.body), root = object(payload), data = object(root.data);
            if (request.self) {
                const id = platform === 'xiaohongshu' && root.code === 0 && root.success === true && data.guest !== true ? data.user_id ?? data.userId
                    : platform === 'douyin' && root.status_code === 0 ? object(root.user).uid : undefined;
                if (typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id)) {
                    if (selfId && selfId !== id) throw new AuthorizationRequired('原站账号已变化，请重新读取收藏');
                    selfId = id;
                }
            } else received.push(parseFavoritePage(platform, payload));
        }).catch((error: unknown) => { failure = error instanceof Error ? error : new Error('收藏读取失败'); });
    };
    web.debugger.attach('1.3');
    web.debugger.on('message', listener);
    try {
        await withAbort(web.debugger.sendCommand('Network.enable', { maxResourceBufferSize: 4 * 1024 * 1024, maxTotalBufferSize: 8 * 1024 * 1024 }), AbortSignal.any([signal, AbortSignal.timeout(10000)]));
        await navigate(platform === 'xiaohongshu' ? 'https://www.xiaohongshu.com/explore' : 'https://www.douyin.com/');
        const selfDeadline = Date.now() + 20000;
        while (!selfId) {
            if (failure) throw failure;
            if (Date.now() > selfDeadline) throw new AuthorizationRequired('无法确认原站账号，请登录并完成访问验证后重试');
            await delay(300, signal);
        }
        reading = true;
        await navigate(platform === 'xiaohongshu' ? `https://www.xiaohongshu.com/user/profile/${selfId}?tab=collect` : 'https://www.douyin.com/user/self?showTab=favorite_collection');
        let deadline = Date.now() + 30000, tabActivated = false;
        while (!finished) {
            signal.throwIfAborted();
            if (failure) throw failure;
            if (win.isDestroyed() || !sessions.allowed(platform, web.getURL())) throw new Error('收藏窗口已关闭或离开原站');
            for (const page of received.splice(0)) {
                if (page.hasMore && cursors.has(page.cursor)) throw new Error('收藏分页未推进，未宣称全量读取完成；请刷新后重试');
                cursors.add(page.cursor); pages++;
                await onPage({ page, label: `第 ${pages} 页` }); deadline = Date.now() + 30000;
                if (!page.hasMore) { finished = true; break; }
            }
            if (!finished) {
                if (Date.now() > deadline) throw new Error('收藏加载超时，已保留读取到的条目；请在原站完成验证后重新读取');
                const activated = await run(`(${advanceFavoritePage.toString()})(${!tabActivated})`);
                tabActivated ||= activated === true;
                await delay(600, signal);
            }
        }
    } finally {
        web.debugger.removeListener('message', listener);
        await processing;
        if (!win.isDestroyed()) try { web.debugger.detach(); } catch { /* Closed owned renderer. */ }
    }
}
