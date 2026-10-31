import { Modal, type App } from 'obsidian';
import { loadFavoriteItems, type FavoriteProgress } from './favorite-import';
import { createFavoriteDraft, FavoriteDraftStore, mergeFavoritePage, pendingFavoriteEntries, type FavoriteDraft, type FavoriteEntry } from './favorite-import-state';
import { LOCAL_PLATFORM_LABELS, type FavoritePlatform, type FavoriteImportRequest, type FavoriteImportResponse, type FavoriteImportItemResult, type FavoriteImportStatus } from './companion-protocol';
import type { SiteSessions } from './auth';

export interface FavoriteImportOptions {
    scope: string;
    sessions: SiteSessions;
    available(platform: FavoritePlatform): boolean;
    authorize(platform: FavoritePlatform, signal: AbortSignal): Promise<void>;
    submit(request: FavoriteImportRequest): Promise<FavoriteImportResponse>;
}
const labels: Record<FavoriteImportStatus, string> = {
    created: '已创建', duplicate: '已有任务', quota_skipped: '额度不足，未导入', invalid: '无法识别', failed: '提交失败，可继续',
};
export class FavoriteImportModal extends Modal {
    private platform: FavoritePlatform = 'bilibili';
    private draft?: FavoriteDraft;
    private store?: FavoriteDraftStore;
    private controller?: AbortController;
    private alive = false;
    private busy = false;
    private offset = 0;
    private readonly pageSize = 100;
    private monitor?: number;
    private counts: Partial<Record<FavoriteImportStatus, number>> = {};
    private pendingCount = 0;
    private hasPendingSync = false;
    private visibleRows = new Map<string, HTMLElement>();
    private summary!: HTMLElement;
    private status!: HTMLElement;
    private list!: HTMLElement;
    private select!: HTMLSelectElement;
    private readButton!: HTMLButtonElement;
    private submitButton!: HTMLButtonElement;
    private resumeButton!: HTMLButtonElement;
    private allButton!: HTMLButtonElement;
    private noneButton!: HTMLButtonElement;
    private cancelButton!: HTMLButtonElement;
    constructor(app: App, private options: FavoriteImportOptions, platform?: FavoritePlatform) { super(app); if (platform) this.platform = platform; }
    isActive(): boolean { return this.alive || this.busy; }
    onOpen(): void {
        this.alive = true;
        this.modalEl.addClass('clip2md-favorite-import');
        this.titleEl.setText('从平台收藏导入');
        this.contentEl.createEl('p', { text: '读取当前登录账号的全部收藏，默认全选单条作品。导入使用每日额度，随后使用永久额度；额度不足的部分不提交。' });
        this.contentEl.createEl('p', { text: '收藏清单和导入进度保存在本机插件文件中；只把选中的作品链接提交至 Clip2MD，原站登录凭据留在本机。', cls: 'setting-item-description' });
        const controls = this.contentEl.createDiv({ cls: 'clip2md-favorite-controls' });
        this.select = controls.createEl('select', { attr: { 'aria-label': '收藏平台' } });
        for (const platform of ['bilibili', 'xiaohongshu', 'douyin'] as const) this.select.createEl('option', { value: platform, text: LOCAL_PLATFORM_LABELS[platform] });
        this.select.value = this.platform;
        this.select.addEventListener('change', () => { this.platform = this.select.value as FavoritePlatform; void this.restore(); });
        this.readButton = controls.createEl('button', { text: '重新读取全部收藏' });
        this.readButton.addEventListener('click', () => void this.read());
        this.allButton = controls.createEl('button', { text: '全选待导入项' });
        this.allButton.addEventListener('click', () => void this.chooseAll(true));
        this.noneButton = controls.createEl('button', { text: '取消全选' });
        this.noneButton.addEventListener('click', () => void this.chooseAll(false));
        this.summary = this.contentEl.createDiv({ cls: 'clip2md-favorite-summary', attr: { 'aria-live': 'polite' } });
        this.status = this.contentEl.createDiv({ cls: 'clip2md-favorite-status', attr: { role: 'status', 'aria-live': 'polite' } });
        this.list = this.contentEl.createDiv({ cls: 'clip2md-favorite-list' });
        const actions = this.contentEl.createDiv({ cls: 'clip2md-favorite-controls' });
        this.submitButton = actions.createEl('button', { text: '检查额度并导入全部选中项', cls: 'mod-cta' });
        this.submitButton.addEventListener('click', () => void this.submit());
        this.resumeButton = actions.createEl('button', { text: '继续未导入和失败项' });
        this.resumeButton.addEventListener('click', () => void this.submit());
        this.cancelButton = actions.createEl('button', { text: '关闭' });
        this.cancelButton.addEventListener('click', () => { if (this.busy) { this.controller?.abort(); this.status.setText('已暂停；正在提交的单条结果会保存，剩余项不会继续提交。'); } else this.close(); });
        this.monitor = window.setInterval(() => {
            if (!this.options.available(this.platform)) {
                this.controller?.abort(); this.updateControls();
                if (!this.busy) this.status.setText('请在本地剪藏设置中开启并登录该平台；账号或扩展变化时导入会暂停。');
            }
        }, 500);
        void this.restore();
    }
    onClose(): void { this.alive = false; this.controller?.abort(); if (this.monitor !== undefined) window.clearInterval(this.monitor); this.contentEl.empty(); }
    private async restore(): Promise<void> {
        this.busy = true; this.draft = undefined; this.offset = 0; this.updateControls();
        const platform = this.platform;
        this.store = new FavoriteDraftStore(this.app, this.options.scope, platform);
        try {
            const draft = await this.store.load();
            if (!this.alive || platform !== this.platform) return;
            this.draft = draft || undefined;
            this.status.setText(draft ? draft.complete ? '已恢复上次导入记录，可继续未导入项。' : '上次收藏读取未完成，请重新读取全部收藏后导入。' : '点击读取收藏。需先在平台设置中开启并完成原站登录。');
        } catch { if (this.alive) this.status.setText('收藏记录损坏，原文件已保留，请重新读取收藏。'); }
        finally { this.busy = false; if (this.alive) this.render(); }
    }
    private updateControls(): void {
        const available = this.options.available(this.platform), entries = this.draft?.entries || [];
        this.select.disabled = this.busy;
        this.readButton.disabled = this.busy || !available;
        this.allButton.disabled = this.noneButton.disabled = this.busy || !entries.length;
        this.submitButton.disabled = this.resumeButton.disabled = this.busy || !available || !this.draft?.complete || !this.pendingCount && !this.hasPendingSync;
        const resuming = Object.values(this.counts).some(count => !!count);
        this.submitButton.hidden = resuming; this.resumeButton.hidden = !resuming;
        this.cancelButton.setText(this.busy ? '暂停导入' : '关闭');
    }
    private async chooseAll(selected: boolean): Promise<void> {
        if (this.busy || !this.draft || !this.store) return;
        for (const entry of this.draft.entries) if (!entry.result || ['failed', 'quota_skipped'].includes(entry.result.status)) entry.selected = selected;
        try { await this.store.save(this.draft); this.render(); } catch { this.status.setText('选择保存失败，请重新打开后重试'); }
    }
    private render(): void {
        if (!this.alive) return;
        const entries = this.draft?.entries || [];
        this.counts = {};
        for (const entry of entries) if (entry.result) this.counts[entry.result.status] = (this.counts[entry.result.status] || 0) + 1;
        this.pendingCount = this.draft ? pendingFavoriteEntries(this.draft).length : 0;
        this.hasPendingSync = entries.some(entry => this.needsSync(entry));
        this.updateControls(); this.renderSummary();
        this.visibleRows.clear();
        this.list.empty();
        const lastPage = Math.max(0, Math.ceil(entries.length / this.pageSize) - 1);
        this.offset = Math.min(this.offset, lastPage);
        for (const entry of entries.slice(this.offset * this.pageSize, (this.offset + 1) * this.pageSize)) this.renderEntry(entry);
        if (entries.length > this.pageSize) {
            const pager = this.list.createDiv({ cls: 'clip2md-favorite-controls' });
            const back = pager.createEl('button', { text: '上一页' }); back.disabled = this.offset === 0;
            back.addEventListener('click', () => { this.offset--; this.render(); });
            pager.createSpan({ text: `第 ${this.offset + 1} / ${lastPage + 1} 页（全选包含所有页）` });
            const next = pager.createEl('button', { text: '下一页' }); next.disabled = this.offset === lastPage;
            next.addEventListener('click', () => { this.offset++; this.render(); });
        }
    }
    private needsSync(entry: FavoriteEntry): boolean {
        return !!entry.result && (entry.result.syncPending === true || entry.result.status === 'created' && entry.result.syncPending !== false);
    }
    private renderSummary(): void {
        this.summary.setText(`已读取 ${this.draft?.entries.length || 0} 条 · 已选待导入 ${this.pendingCount} 条 · 列表重复 ${this.draft?.duplicates || 0} 条 · 不支持/失效 ${this.draft?.skipped || 0} 条`);
        const totals = Object.entries(this.counts).filter(([, count]) => count).map(([key, count]) => `${labels[key as FavoriteImportStatus]} ${count}`).join(' · ');
        if (totals) this.summary.createEl('p', { text: totals });
    }
    private applyResult(entry: FavoriteEntry, result: FavoriteImportItemResult): void {
        const wasPending = entry.selected && (!entry.result || ['failed', 'quota_skipped'].includes(entry.result.status));
        if (entry.result) this.counts[entry.result.status] = (this.counts[entry.result.status] || 0) - 1;
        entry.result = result;
        this.counts[result.status] = (this.counts[result.status] || 0) + 1;
        if (['created', 'duplicate', 'invalid'].includes(result.status)) entry.selected = false;
        if (wasPending && !entry.selected) this.pendingCount--;
        const row = this.visibleRows.get(entry.url);
        if (this.alive && row) this.renderEntry(entry, row);
    }
    private renderEntry(entry: FavoriteEntry, existing?: HTMLElement): void {
        const label = existing || this.list.createEl('label', { cls: 'clip2md-favorite-row' });
        label.empty(); this.visibleRows.set(entry.url, label);
        const checkbox = label.createEl('input', { attr: { type: 'checkbox', 'aria-label': `导入 ${entry.title}` } });
        checkbox.checked = entry.selected;
        checkbox.disabled = this.busy || !!entry.result && ['created', 'duplicate', 'invalid'].includes(entry.result.status);
        checkbox.addEventListener('change', () => {
            entry.selected = checkbox.checked;
            void this.store?.save(this.draft!).then(() => this.render()).catch(() => { this.status.setText('选择保存失败，请重新打开后重试'); });
        });
        const content = label.createDiv();
        content.createEl('strong', { text: entry.title });
        content.createEl('p', { text: `${entry.author || LOCAL_PLATFORM_LABELS[entry.platform]}${entry.collectedAt ? ` · ${entry.collectedAt.slice(0, 10)}` : ''}${entry.result ? ` · ${labels[entry.result.status]}` : ''}`, cls: 'setting-item-description' });
        if (entry.result?.message) content.createEl('p', { text: entry.result.message, cls: 'setting-item-description' });
    }
    private async read(): Promise<void> {
        if (this.busy || !this.options.available(this.platform)) return;
        this.busy = true; this.controller = new AbortController(); this.updateControls();
        const platform = this.platform, signal = this.controller.signal, store = this.store!;
        try {
            await this.options.authorize(platform, signal);
            const fingerprint = await this.options.sessions.authorizationFingerprint(platform);
            this.draft = createFavoriteDraft(this.options.scope, platform, fingerprint);
            await store.save(this.draft); this.status.setText('正在分页读取全部收藏…');
            const draft = this.draft;
            await loadFavoriteItems(platform, this.options.sessions, signal, async (progress: FavoriteProgress) => {
                mergeFavoritePage(draft, progress); await store.checkpointPage(draft);
                if (this.alive) { this.status.setText(`正在读取 ${progress.label}`); this.render(); }
            });
            signal.throwIfAborted(); draft.complete = true; await store.save(draft);
            if (this.alive) this.status.setText(draft.entries.length ? '全部收藏读取完成，可检查额度并导入。' : '收藏列表为空，或没有支持的单条作品。');
        } catch (error) { if (this.alive) this.status.setText(signal.aborted ? '读取已暂停，条目保留；请重新读取完整列表后导入。' : error instanceof Error ? error.message : '读取失败，请重新登录后重试'); }
        finally { this.busy = false; if (this.alive) this.render(); }
    }
    private async submit(): Promise<void> {
        if (this.busy || !this.draft?.complete || !this.store || !this.options.available(this.platform)) return;
        const draft = this.draft, store = this.store, entries = pendingFavoriteEntries(draft);
        const acceptedTaskIds = draft.entries.filter(entry => this.needsSync(entry)).flatMap(entry => entry.result?.taskId ? [entry.result.taskId] : []);
        if (!entries.length && !acceptedTaskIds.length) return;
        this.busy = true; this.controller = new AbortController(); const signal = this.controller.signal;
        this.render(); this.status.setText('正在检查额度和已有任务…');
        let handled = 0, lastProgress = 0;
        try {
            await this.options.authorize(this.platform, signal);
            if (await this.options.sessions.authorizationFingerprint(this.platform) !== draft.sessionFingerprint) throw new Error('原站登录账号或登录态已变化，请重新读取收藏');
            // Save all operation keys before sending any paid request.
            await store.save(draft);
            const byUrl = new Map(draft.entries.map((entry, index) => [entry.url, { entry, index }]));
            const response = await this.options.submit({
                bindingScope: this.options.scope, platform: this.platform,
                entries: entries.map(({ url, requestKey, result }) => ({ url, requestKey, ...(result?.uncertain ? { reconcile: true } : {}) })),
                acceptedTaskIds,
                onSubmitting: async url => {
                    const row = byUrl.get(url); if (!row) throw new Error('提交链接与收藏不匹配');
                    this.applyResult(row.entry, { url, status: 'failed', uncertain: true, message: '提交结果待确认，继续导入时会检查已有任务' });
                    await store.checkpointResult(draft, row.index);
                },
                shouldContinue: async () => this.alive && !signal.aborted && this.options.available(draft.platform)
                    && await this.options.sessions.authorizationFingerprint(draft.platform) === draft.sessionFingerprint,
                onResult: async result => {
                    const row = byUrl.get(result.url); if (!row) throw new Error('导入结果与收藏不匹配，已停止');
                    this.applyResult(row.entry, result);
                    await store.checkpointResult(draft, row.index); handled++;
                    if (this.alive && Date.now() - lastProgress >= 100) {
                        lastProgress = Date.now();
                        this.status.setText(`已检查/提交 ${handled} / ${entries.length} 条`); this.renderSummary();
                    }
                },
            });
            if (response.syncTriggered) {
                for (const [index, entry] of draft.entries.entries()) {
                    if (!this.needsSync(entry)) continue;
                    entry.result = { ...entry.result!, syncPending: false };
                    await store.checkpointResult(draft, index);
                }
            }
            if (this.alive) this.status.setText(`${response.stopped || '本次导入完成'}。额度不足的部分未提交；未导入项可在补充额度后继续。${response.syncTriggered ? '已触发同步，云端完成后按现有平台设置补充本地素材。' : ''}`);
        } catch (error) { if (this.alive) this.status.setText(error instanceof Error ? error.message : '导入已暂停，已提交结果保留'); }
        finally { this.busy = false; if (this.alive) this.render(); }
    }
}
