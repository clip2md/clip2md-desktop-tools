import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import type { App } from 'obsidian';
import type { SiteSessions } from './auth';
const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('./favorite-import', () => ({ loadFavoriteItems: mocks.load }));
vi.mock('obsidian', async original => ({ ...await original<Record<string, unknown>>(), Modal: class {
    modalEl = document.body.appendChild(document.createElement('div'));
    contentEl = this.modalEl.appendChild(document.createElement('div'));
    titleEl = document.createElement('h2');
    constructor(public app: unknown) {}
    close() { (this as unknown as { onClose(): void }).onClose(); }
} }));
import { FavoriteImportModal, type FavoriteImportOptions } from './favorite-import-modal';
import type { FavoriteImportRequest } from './companion-protocol';
beforeAll(() => {
    function createEl(this: HTMLElement, tag: string, opts: { text?: string; cls?: string; attr?: Record<string, string> } = {}) {
        const node = document.createElement(tag); node.textContent = opts.text || ''; node.className = opts.cls || '';
        for (const [key, value] of Object.entries(opts.attr || {})) node.setAttribute(key, value);
        this.appendChild(node); return node;
    }
    Object.assign(HTMLElement.prototype, { createEl, createDiv(this: HTMLElement, opts: object) { return createEl.call(this, 'div', opts); }, createSpan(this: HTMLElement, opts: object) { return createEl.call(this, 'span', opts); },
        setText(this: HTMLElement, text: string) { this.textContent = text; }, empty(this: HTMLElement) { this.replaceChildren(); }, addClass(this: HTMLElement, cls: string) { this.classList.add(cls); } });
});
const modals: FavoriteImportModal[] = [];
beforeEach(() => { document.body.replaceChildren(); mocks.load.mockReset(); Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }); });
afterEach(() => { for (const modal of modals.splice(0)) modal.onClose(); });
function fixture(count = 250, available = true) {
    const files = new Map<string, string>(), folders = new Set<string>(), local = new Map<string, unknown>();
    const app = { loadLocalStorage: (key: string) => local.get(key), saveLocalStorage: (key: string, value: unknown) => { local.set(key, value); }, vault: { configDir: '.obsidian', adapter: {
        exists: async (path: string) => files.has(path) || folders.has(path), read: async (path: string) => files.get(path)!, write: async (path: string, text: string) => { files.set(path, text); }, mkdir: async (path: string) => { folders.add(path); },
        append: async (path: string, text: string) => { files.set(path, (files.get(path) || '') + text); },
        rename: async (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from); }, remove: async (path: string) => { files.delete(path); },
    } } } as unknown as App;
    const options: FavoriteImportOptions = { scope: 'a'.repeat(64), sessions: { authorizationFingerprint: async () => 'b'.repeat(64) } as unknown as SiteSessions,
        available: () => available, authorize: vi.fn(async () => {}), submit: vi.fn(async request => {
            for (const [i, entry] of request.entries.entries()) await request.onResult({ url: entry.url, status: i === 0 ? 'created' : 'quota_skipped', ...(i === 0 ? { taskId: 42 } : {}) });
            return { dailyQuota: 1, permanentQuota: 0, syncTriggered: true };
        }) };
    mocks.load.mockImplementation(async (platform, _sessions, _signal, onPage) => { await onPage({ label: 'page 1', page: { items: Array.from({ length: count }, (_, i) => ({ platform, id: String(i + 1), url: `https://www.douyin.com/video/${i + 1}`, title: `收藏 ${i + 1}` })), hasMore: false, skipped: 0, cursor: '' } }); });
    const open = () => { const modal = new FavoriteImportModal(app, options, 'douyin'); modals.push(modal); modal.onOpen(); return modal; };
    return { app, options, files, open, modal: open() };
}
const button = (modal: FavoriteImportModal, text: string) => [...modal.contentEl.querySelectorAll('button')].find(node => node.textContent === text)!;
async function read(modal: FavoriteImportModal) { await vi.waitFor(() => expect(button(modal, '重新读取全部收藏').disabled).toBe(false)); button(modal, '重新读取全部收藏').click(); await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('全部收藏读取完成')); }
describe('favorites import modal', () => {
    it('selects the entire list while rendering only one page, and supports all/none and single-item selection', async () => {
        const f = fixture(); await read(f.modal);
        expect(f.modal.contentEl.querySelectorAll('.clip2md-favorite-row')).toHaveLength(100);
        expect(f.modal.contentEl.textContent).toContain('已选待导入 250 条');
        button(f.modal, '下一页').click(); expect(f.modal.contentEl.textContent).toContain('收藏 101');
        const input = f.modal.contentEl.querySelector<HTMLInputElement>('.clip2md-favorite-row input')!; input.click();
        await vi.waitFor(() => expect(f.modal.contentEl.textContent).toContain('已选待导入 249 条'));
        button(f.modal, '取消全选').click(); await vi.waitFor(() => expect(f.modal.contentEl.textContent).toContain('已选待导入 0 条'));
        button(f.modal, '全选待导入项').click(); await vi.waitFor(() => expect(f.modal.contentEl.textContent).toContain('已选待导入 250 条'));
    });
    it('restores checkpoints and retries only unsent/quota-skipped items with their original keys', async () => {
        const f = fixture(3); await read(f.modal);
        button(f.modal, '检查额度并导入全部选中项').click();
        await vi.waitFor(() => expect(f.modal.contentEl.textContent).toContain('本次导入完成'));
        expect(f.modal.contentEl.textContent).toContain('额度不足，未导入 2');
        const first = vi.mocked(f.options.submit).mock.calls[0][0]; f.modal.close();
        const restored = f.open(); await vi.waitFor(() => expect(restored.contentEl.textContent).toContain('已恢复上次'));
        button(restored, '继续未导入和失败项').click();
        await vi.waitFor(() => expect(vi.mocked(f.options.submit)).toHaveBeenCalledTimes(2));
        expect(vi.mocked(f.options.submit).mock.calls[1][0].entries).toEqual(first.entries.slice(1));
    });
    it('requires the platform to be enabled and authorized before reading', async () => {
        const f = fixture(3, false); await vi.waitFor(() => expect(f.modal.contentEl.textContent).toContain('点击读取收藏'));
        expect(button(f.modal, '重新读取全部收藏').disabled).toBe(true); expect(mocks.load).not.toHaveBeenCalled();
    });
    it('cancels future submissions when closed, while allowing the accepted in-flight result to be saved', async () => {
        const f = fixture(3); await read(f.modal);
        let request!: FavoriteImportRequest, finish!: () => void;
        vi.mocked(f.options.submit).mockImplementation(async req => { request = req; await new Promise<void>(resolve => { finish = resolve; }); await req.onResult({ url: req.entries[0].url, status: 'created', taskId: 9 }); return { dailyQuota: 3, permanentQuota: 0, syncTriggered: true }; });
        button(f.modal, '检查额度并导入全部选中项').click(); await vi.waitFor(() => expect(request).toBeTruthy());
        f.modal.close(); expect(await request.shouldContinue()).toBe(false); finish();
        await vi.waitFor(() => expect([...f.files.values()].some(text => text.includes('"taskId":9'))).toBe(true));
    });
});
