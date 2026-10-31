import { beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import type { App } from 'obsidian';
import { createFavoriteDraft, FavoriteDraftStore, mergeFavoritePage } from './favorite-import-state';
import type { FavoriteItem } from './favorite-import';

const scope = 'a'.repeat(64);
const fingerprint = 'b'.repeat(64);
const item = (id: number): FavoriteItem => ({
    platform: 'douyin', id: String(id), url: `https://www.douyin.com/video/${id}`, title: `收藏 ${id}`,
});

function fixture() {
    const files = new Map<string, string>();
    const folders = new Set<string>();
    const local = new Map<string, unknown>();
    const adapter = {
        exists: async (path: string) => files.has(path) || folders.has(path),
        read: async (path: string) => { if (!files.has(path)) throw new Error(`missing ${path}`); return files.get(path)!; },
        write: vi.fn(async (path: string, text: string) => { files.set(path, text); }),
        append: vi.fn(async (path: string, text: string) => { files.set(path, (files.get(path) || '') + text); }),
        mkdir: async (path: string) => { folders.add(path); },
        rename: vi.fn(async (from: string, to: string) => { if (!files.has(from) || files.has(to)) throw new Error('rename'); files.set(to, files.get(from)!); files.delete(from); }),
        remove: vi.fn(async (path: string) => { files.delete(path); }),
    };
    const app = { loadLocalStorage: (key: string) => local.get(key), saveLocalStorage: (key: string, value: unknown) => local.set(key, value), vault: { configDir: '.obsidian', adapter } } as unknown as App;
    return { app, files, adapter };
}

beforeEach(() => Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }));

describe('favorite import checkpoint boundaries', () => {
    it('replays page and result journal records after a restart', async () => {
        const f = fixture();
        const store = new FavoriteDraftStore(f.app, scope, 'douyin');
        const draft = createFavoriteDraft(scope, 'douyin', fingerprint);
        await store.save(draft);
        mergeFavoritePage(draft, { label: 'first', page: { items: [item(1), item(2)], skipped: 0, hasMore: true, cursor: 'next' } });
        await store.checkpointPage(draft);
        draft.entries[0].result = { url: draft.entries[0].url, status: 'created', taskId: 7, syncPending: true };
        draft.entries[0].selected = false;
        await store.checkpointResult(draft, 0);

        const restored = await new FavoriteDraftStore(f.app, scope, 'douyin').load();
        expect(restored?.entries).toHaveLength(2);
        expect(restored?.entries[0]).toMatchObject({ selected: false, result: { status: 'created', taskId: 7, syncPending: true } });
    });

    it('stops appending after a journal write failure and leaves the committed snapshot recoverable', async () => {
        const f = fixture();
        const store = new FavoriteDraftStore(f.app, scope, 'douyin');
        const draft = createFavoriteDraft(scope, 'douyin', fingerprint);
        await store.save(draft);
        mergeFavoritePage(draft, { label: 'first', page: { items: [item(1)], skipped: 0, hasMore: false, cursor: '' } });
        f.adapter.append.mockRejectedValueOnce(new Error('disk full'));
        await expect(store.checkpointPage(draft)).rejects.toThrow('disk full');
        expect(await new FavoriteDraftStore(f.app, scope, 'douyin').load()).toEqual(createFavoriteDraft(scope, 'douyin', fingerprint));
        await expect(store.checkpointPage(draft)).rejects.toThrow('尚未保存');
    });
});
