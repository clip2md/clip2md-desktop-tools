import { beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import type { App } from 'obsidian';
import { createFavoriteDraft, FavoriteDraftStore, mergeFavoritePage, pendingFavoriteEntries } from './favorite-import-state';
import type { FavoriteItem } from './favorite-import';
const scope = 'a'.repeat(64), fingerprint = 'b'.repeat(64);
const item = (id: number): FavoriteItem => ({ platform: 'douyin', id: String(id), url: `https://www.douyin.com/video/${id}`, title: `收藏 ${id}` });
function fixture() {
    const files = new Map<string, string>(), folders = new Set<string>(), local = new Map<string, unknown>();
    const adapter = {
        exists: async (path: string) => files.has(path) || folders.has(path),
        read: async (path: string) => { if (!files.has(path)) throw new Error('missing'); return files.get(path)!; },
        write: vi.fn(async (path: string, text: string) => { files.set(path, text); }),
        append: vi.fn(async (path: string, text: string) => { files.set(path, (files.get(path) || '') + text); }),
        mkdir: async (path: string) => { folders.add(path); },
        rename: vi.fn(async (from: string, to: string) => { if (!files.has(from) || files.has(to)) throw new Error('rename'); files.set(to, files.get(from)!); files.delete(from); }),
        remove: async (path: string) => { files.delete(path); },
    };
    const app = { loadLocalStorage: (key: string) => local.get(key), saveLocalStorage: (key: string, value: unknown) => { local.set(key, value); }, vault: { configDir: '.obsidian', adapter } } as unknown as App;
    return { app, files, adapter };
}
beforeEach(() => { Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }); });
describe('favorites import journal', () => {
    it('deduplicates across pages and folders without counting valid works as unsupported', () => {
        const draft = createFavoriteDraft(scope, 'douyin', fingerprint);
        mergeFavoritePage(draft, { label: 'page 1', page: { items: [item(1), item(2)], hasMore: true, cursor: 'a', skipped: 2 } });
        mergeFavoritePage(draft, { label: 'page 2', page: { items: [{ ...item(1), url: 'https://www.douyin.com/note/1' }, item(3)], hasMore: false, cursor: '', skipped: 1 } });
        expect(draft.entries).toHaveLength(3); expect(draft.duplicates).toBe(1); expect(draft.skipped).toBe(3);
        expect(draft.entries.every(row => row.selected)).toBe(true);
    });
    it('restores keys, selections, and committed outcomes after restart without a 100-row limit', async () => {
        const f = fixture(), store = new FavoriteDraftStore(f.app, scope, 'douyin'), draft = createFavoriteDraft(scope, 'douyin', fingerprint);
        mergeFavoritePage(draft, { label: 'all', page: { items: Array.from({ length: 250 }, (_, i) => item(i + 1)), hasMore: false, cursor: '', skipped: 0 } });
        draft.complete = true;
        draft.entries[0].result = { url: item(1).url, status: 'created', taskId: 42 }; draft.entries[0].selected = false;
        draft.entries[1].selected = false;
        draft.entries[2].result = { url: item(3).url, status: 'quota_skipped' };
        await store.save(draft);
        const restored = await new FavoriteDraftStore(f.app, scope, 'douyin').load();
        expect(restored).toEqual(draft); expect(pendingFavoriteEntries(restored!)).toHaveLength(248);
        expect(restored!.entries[2].requestKey).toBe(draft.entries[2].requestKey);
        expect(await new FavoriteDraftStore(f.app, 'c'.repeat(64), 'douyin').load()).toBeNull();
        expect(await new FavoriteDraftStore(f.app, scope, 'bilibili').load()).toBeNull();
    });
    it('preserves previous data if publishing a checkpoint fails and restores it on reload', async () => {
        const f = fixture(), store = new FavoriteDraftStore(f.app, scope, 'douyin'), draft = createFavoriteDraft(scope, 'douyin', fingerprint);
        await store.save(draft);
        draft.complete = true;
        const rename = f.adapter.rename.getMockImplementation()!;
        f.adapter.rename.mockImplementation(async (from, to) => { if (from.endsWith('.tmp')) throw new Error('disk full'); return rename(from, to); });
        await expect(store.save(draft)).rejects.toThrow('disk full');
        expect((await new FavoriteDraftStore(f.app, scope, 'douyin').load())!.complete).toBe(false);
    });
    it('rejects malformed/cross-account records and retains original bytes', async () => {
        const f = fixture(), store = new FavoriteDraftStore(f.app, scope, 'douyin'), draft = createFavoriteDraft(scope, 'douyin', fingerprint);
        await store.save(draft); const path = [...f.files.keys()].find(path => path.endsWith('.json'))!;
        f.files.set(path, '{broken'); await expect(store.load()).rejects.toThrow('损坏'); expect(f.files.get(path)).toBe('{broken');
        draft.bindingScope = 'c'.repeat(64); await expect(store.save(draft)).rejects.toThrow('无效');
    });
});
