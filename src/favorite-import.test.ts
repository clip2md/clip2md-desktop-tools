import { describe, expect, it, vi } from 'vitest';
import { favoriteEndpoint, loadFavoriteItems, parseFavoritePage, type FavoriteProgress } from './favorite-import';
import type { SiteSessions } from './auth';
const BV = 'BV1xx411c7mD', NOTE = '0123456789abcdef01234567';
const bili = (id = 1) => ({ id, bvid: BV, type: 2, title: '标题', attr: 0, upper: { name: '作者' }, fav_time: 1720000000 });
describe('favorites response fixtures', () => {
    it('parses Bilibili works and filters deleted media, profiles and non-video collections', () => {
        const page = parseFavoritePage('bilibili', { code: 0, data: { has_more: false, medias: [bili(), { ...bili(2), attr: 1 }, { ...bili(3), type: 21 }, { type: 'user', id: 4 }] } });
        expect(page.items).toHaveLength(1); expect(page.skipped).toBe(3); expect(page.items[0]).toMatchObject({ url: `https://www.bilibili.com/video/${BV}`, author: '作者', collectedAt: expect.any(String) });
    });
    it('constructs XHS canonical links using the note identity even when sharing uses a short link', () => {
        const page = parseFavoritePage('xiaohongshu', { code: 0, success: true, data: { has_more: true, cursor: NOTE, notes: [
            { id: NOTE, model_type: 'note', xsec_token: 'signed-access', share_url: 'https://xhslink.com/abc', note_card: { display_title: '笔记', user: { nickname: '作者' }, type: 'normal' } },
            { id: NOTE, model_type: 'user' }, { id: NOTE, is_deleted: true },
        ] } });
        expect(page.items).toHaveLength(1); expect(page.items[0].url).toContain(`explore/${NOTE}?xsec_token=signed-access`); expect(page.cursor).toBe(NOTE);
    });
    it('distinguishes Douyin videos from galleries and excludes private works and live streams', () => {
        const page = parseFavoritePage('douyin', { status_code: 0, has_more: 0, cursor: 10, aweme_list: [
            { aweme_id: '7000000000000000001', aweme_type: 0, desc: '视频', author: { nickname: '作者' } },
            { aweme_id: '7000000000000000002', aweme_type: 68, desc: '图文', images: [{}] },
            { aweme_id: '7000000000000000003', aweme_type: 0, status: { item_is_private: true } },
            { aweme_id: '7000000000000000004', aweme_type: 101 },
        ] });
        expect(page.items.map(item => item.url)).toEqual(['https://www.douyin.com/video/7000000000000000001', 'https://www.douyin.com/note/7000000000000000002']); expect(page.skipped).toBe(2);
    });
    it('accepts only an exact favorites endpoint for the self account, never recommendations', () => {
        expect(favoriteEndpoint('xiaohongshu', `https://edith.xiaohongshu.com/api/sns/web/v1/note/collect/page?user_id=${NOTE}`, NOTE)).toBe(true);
        expect(favoriteEndpoint('xiaohongshu', 'https://edith.xiaohongshu.com/api/sns/web/v1/note/collect/page?user_id=other', NOTE)).toBe(false);
        expect(favoriteEndpoint('douyin', 'https://www.douyin.com/aweme/v1/web/aweme/listcollection/', 'self')).toBe(true);
        for (const url of ['https://www.douyin.com/aweme/v1/web/aweme/favorite/', 'https://www.douyin.com/aweme/v1/web/aweme/post/', 'https://www.douyin.com.evil.test/aweme/v1/web/aweme/listcollection/']) expect(favoriteEndpoint('douyin', url, 'self')).toBe(false);
    });
    it('reports auth errors and rejects malformed or stalled pagination instead of false success', () => {
        expect(() => parseFavoritePage('bilibili', { code: -101 })).toThrow('登录');
        expect(() => parseFavoritePage('xiaohongshu', { code: 0, success: true, data: { notes: [], has_more: true } })).toThrow('未推进');
        expect(() => parseFavoritePage('douyin', { status_code: 0, aweme_list: [] })).toThrow('格式');
    });
});
describe('Bilibili authenticated pagination', () => {
    function fixture(repeat = false) {
        const calls: string[] = [];
        const execute = vi.fn(async (script: string) => {
            const url = JSON.parse(script.slice(script.lastIndexOf(')(') + 2, -1)) as string; calls.push(url);
            if (url.includes('/nav')) return { code: 0, data: { isLogin: true, mid: 42 } };
            if (url.includes('list-all')) return { code: 0, data: { list: [{ id: 1, title: '收藏一' }, { id: 2, title: '收藏二' }] } };
            const page = Number(new URL(url).searchParams.get('pn'));
            return { code: 0, data: { has_more: repeat || page === 1, medias: [bili(repeat ? 1 : page)] } };
        });
        const release = vi.fn();
        const sessions = { open: async () => ({ loadURL: vi.fn(async () => {}), webContents: { executeJavaScript: execute, getURL: () => 'https://www.bilibili.com/' } }), allowed: () => true, release } as unknown as SiteSessions;
        return { calls, sessions, release };
    }
    it('reads every folder and every page with the authenticated self ID', async () => {
        const f = fixture(), progress: FavoriteProgress[] = [];
        await loadFavoriteItems('bilibili', f.sessions, new AbortController().signal, async page => { progress.push(page); });
        expect(f.calls[1]).toContain('up_mid=42'); expect(progress).toHaveLength(4); expect(f.release).toHaveBeenCalled();
    });
    it('cancels between pages and releases the renderer', async () => {
        const f = fixture(), controller = new AbortController();
        await expect(loadFavoriteItems('bilibili', f.sessions, controller.signal, async () => { controller.abort(); })).rejects.toThrow();
        expect(f.calls.filter(url => url.includes('resource/list'))).toHaveLength(1); expect(f.release).toHaveBeenCalled();
    });
    it('detects a server that repeats a page indefinitely', async () => {
        const f = fixture(true);
        await expect(loadFavoriteItems('bilibili', f.sessions, new AbortController().signal, async () => {})).rejects.toThrow('未推进');
        expect(f.release).toHaveBeenCalled();
    });
});

describe('signed favorites renderer', () => {
    function fixture(platform: 'xiaohongshu' | 'douyin', fail = false) {
        let listener: ((event: unknown, method: string, params: unknown) => void) | undefined;
        let current = '', sequence = 0, advance = 0;
        const bodies = new Map<string, unknown>();
        const emit = (url: string, payload: unknown, status = 200) => {
            const id = String(++sequence); bodies.set(id, payload);
            listener?.({}, 'Network.responseReceived', { requestId: id, response: { url, status } });
            listener?.({}, 'Network.loadingFinished', { requestId: id });
        };
        const payload = (more: boolean, id: string) => platform === 'xiaohongshu'
            ? { code: 0, success: true, data: { has_more: more, cursor: id, notes: [{ note_id: id, display_title: '收藏笔记' }] } }
            : { status_code: 0, has_more: more ? 1 : 0, cursor: Number(id), aweme_list: [{ aweme_id: id, aweme_type: 0, desc: '收藏视频' }] };
        const endpoint = platform === 'xiaohongshu' ? `https://edith.xiaohongshu.com/api/sns/web/v2/note/collect/page?user_id=${NOTE}` : 'https://www.douyin.com/aweme/v1/web/aweme/listcollection/';
        const debug = { attach: vi.fn(), detach: vi.fn(), on: vi.fn((_name, fn) => { listener = fn; }), removeListener: vi.fn(), sendCommand: vi.fn(async (command, params) => command === 'Network.getResponseBody' ? { body: JSON.stringify(bodies.get(params.requestId)), base64Encoded: false } : {}) };
        const window = { isDestroyed: () => false, loadURL: vi.fn(async (url: string) => {
            current = url;
            if (url.endsWith('/explore') || url === 'https://www.douyin.com/') {
                emit(platform === 'xiaohongshu' ? 'https://edith.xiaohongshu.com/api/sns/web/v2/user/me' : 'https://www.douyin.com/aweme/v1/web/user/profile/self/', platform === 'xiaohongshu' ? { code: 0, success: true, data: { user_id: NOTE, guest: false } } : { status_code: 0, user: { uid: '42' } });
            } else {
                // A valid-looking work from a recommendation or somebody else's list must never be imported.
                emit(platform === 'xiaohongshu' ? 'https://edith.xiaohongshu.com/api/sns/web/v1/homefeed' : 'https://www.douyin.com/aweme/v1/web/aweme/post/', payload(false, platform === 'xiaohongshu' ? 'ffffffffffffffffffffffff' : '999'));
                emit(endpoint, payload(true, platform === 'xiaohongshu' ? NOTE : '123'), fail ? 401 : 200);
            }
        }), webContents: { debugger: debug, getURL: () => current, executeJavaScript: vi.fn(async () => {
            if (++advance === 1) emit(endpoint, payload(false, platform === 'xiaohongshu' ? '1123456789abcdef01234567' : '124'));
            return true;
        }) } };
        const release = vi.fn();
        return { sessions: { open: async () => window, allowed: () => true, release } as unknown as SiteSessions, release, debug };
    }
    it.each(['xiaohongshu', 'douyin'] as const)('reads %s pages to explicit end and excludes recommendations', async platform => {
        const f = fixture(platform), pages: FavoriteProgress[] = [];
        await loadFavoriteItems(platform, f.sessions, new AbortController().signal, async page => { pages.push(page); });
        expect(pages).toHaveLength(2); expect(pages.map(page => page.page.hasMore)).toEqual([true, false]);
        expect(pages.flatMap(page => page.page.items).some(item => item.id === '999' || item.id === 'ffffffffffffffffffffffff')).toBe(false);
        expect(f.debug.detach).toHaveBeenCalledOnce(); expect(f.debug.removeListener).toHaveBeenCalled(); expect(f.release).toHaveBeenCalled();
    });
    it('fails explicitly on expired login and releases the owned window', async () => {
        const f = fixture('xiaohongshu', true);
        await expect(loadFavoriteItems('xiaohongshu', f.sessions, new AbortController().signal, async () => {})).rejects.toThrow('登录');
        expect(f.release).toHaveBeenCalled(); expect(f.debug.detach).toHaveBeenCalled();
    });
    it('supports camel-case XHS list fields without changing ownership checks', () => {
        const page = parseFavoritePage('xiaohongshu', { code: 0, success: true, data: { hasMore: false, notes: [{ noteId: NOTE, displayTitle: '新版笔记', xsecToken: 'access' }] } });
        expect(page.items[0].title).toBe('新版笔记'); expect(page.items[0].url).toContain('xsec_token=access');
    });
});
