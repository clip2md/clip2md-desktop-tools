import type { App } from 'obsidian';
import { favoriteIdentity, type FavoriteImportItemResult, type FavoritePlatform } from './companion-protocol';
import type { FavoriteItem, FavoriteProgress } from './favorite-import';
import { deviceId, directories, replaceStaged } from './persistent-config';
import { diagnosticId } from './sha256-portable';

export interface FavoriteEntry extends FavoriteItem {
    selected: boolean;
    requestKey: string;
    result?: FavoriteImportItemResult;
}
export interface FavoriteDraft {
    version: 1;
    bindingScope: string;
    platform: FavoritePlatform;
    sessionFingerprint: string;
    entries: FavoriteEntry[];
    complete: boolean;
    skipped: number;
    duplicates: number;
}
export function createFavoriteDraft(scope: string, platform: FavoritePlatform, sessionFingerprint: string): FavoriteDraft {
    return { version: 1, bindingScope: scope, platform, sessionFingerprint, entries: [], complete: false, skipped: 0, duplicates: 0 };
}
const identityIndexes = new WeakMap<FavoriteDraft, Set<string>>();
export function mergeFavoritePage(draft: FavoriteDraft, progress: FavoriteProgress): void {
    let known = identityIndexes.get(draft);
    if (!known) {
        known = new Set(draft.entries.map(item => favoriteIdentity(item.url)!.key));
        identityIndexes.set(draft, known);
    }
    draft.skipped += progress.page.skipped;
    for (const item of progress.page.items) {
        const identity = favoriteIdentity(item.url, draft.platform);
        if (!identity) { draft.skipped++; continue; }
        if (known.has(identity.key)) { draft.duplicates++; continue; }
        known.add(identity.key);
        draft.entries.push({ ...item, selected: true, requestKey: diagnosticId() });
    }
}
export function pendingFavoriteEntries(draft: FavoriteDraft): FavoriteEntry[] {
    return draft.entries.filter(entry => entry.selected && (!entry.result || ['failed', 'quota_skipped'].includes(entry.result.status)));
}
function validEntry(entry: FavoriteEntry, platform: FavoritePlatform): boolean {
    const identity = entry && favoriteIdentity(entry.url, platform);
    const result = entry?.result;
    return !!identity && entry.id === identity.id && entry.platform === platform && typeof entry.title === 'string' && entry.title.length <= 240
        && typeof entry.selected === 'boolean' && /^[a-f0-9-]{36}$/.test(entry.requestKey)
        && (!result || result.url === entry.url && ['created', 'duplicate', 'quota_skipped', 'invalid', 'failed'].includes(result.status)
            && (result.taskId === undefined || Number.isSafeInteger(result.taskId) && result.taskId > 0)
            && (!['created', 'duplicate'].includes(result.status) || result.taskId !== undefined)
            && (result.uncertain === undefined || typeof result.uncertain === 'boolean')
            && (result.syncPending === undefined || typeof result.syncPending === 'boolean'));
}
function validDraft(value: unknown, scope: string, platform: FavoritePlatform): value is FavoriteDraft {
    if (!value || typeof value !== 'object') return false;
    const draft = value as FavoriteDraft;
    return draft.version === 1 && draft.bindingScope === scope && draft.platform === platform
        && /^[a-f0-9]{64}$/.test(draft.sessionFingerprint) && typeof draft.complete === 'boolean'
        && Number.isSafeInteger(draft.skipped) && draft.skipped >= 0 && Number.isSafeInteger(draft.duplicates) && draft.duplicates >= 0
        && Array.isArray(draft.entries) && draft.entries.every(entry => validEntry(entry, platform))
        && new Set(draft.entries.map(entry => favoriteIdentity(entry.url)?.key)).size === draft.entries.length;
}
type JournalRecord = { kind: 'page'; start: number; entries: FavoriteEntry[]; skipped: number; duplicates: number }
    | { kind: 'result'; index: number; selected: boolean; result: FavoriteImportItemResult };
/** One base snapshot and an append-only journal keep full imports linear in bytes written. */
export class FavoriteDraftStore {
    private path: string;
    private journal?: string;
    private draft?: FavoriteDraft;
    private count = 0;
    private faulted = false;
    private writing: Promise<void> = Promise.resolve();
    constructor(private app: App, private scope: string, private platform: FavoritePlatform) {
        if (!/^[a-f0-9]{64}$/.test(scope)) throw new Error('收藏导入绑定无效');
        this.path = `${app.vault.configDir}/clip2md/favorite-imports/${deviceId(app)}/${scope}/${platform}.json`;
    }
    async load(): Promise<FavoriteDraft | null> {
        const io = this.app.vault.adapter;
        let invalid = false;
        for (const suffix of ['', '.previous']) {
            if (!await io.exists(this.path + suffix)) continue;
            let value: FavoriteDraft & { journalId?: string };
            try {
                const parsed: unknown = JSON.parse(await io.read(this.path + suffix));
                if (!validDraft(parsed, this.scope, this.platform)) throw new Error('invalid');
                value = parsed;
            } catch { invalid = true; continue; }
            if (value.journalId !== undefined) {
                if (!/^[a-f0-9-]{36}$/.test(value.journalId)) throw new Error('收藏导入记录损坏，原文件保留');
                this.journal = `${this.path}.${value.journalId}.jsonl`;
                // A missing or damaged committed record must not silently fall
                // back to an older snapshot and forget accepted requests.
                const log = await io.read(this.journal);
                const lines = log.split('\n');
                lines.pop(); // An incomplete final append is uncommitted; retry via cloud preflight.
                for (const line of lines) {
                    const record = JSON.parse(line) as JournalRecord;
                    if (record.kind === 'page' && record.start === value.entries.length && Array.isArray(record.entries)
                        && record.entries.every(entry => validEntry(entry, this.platform))
                        && Number.isSafeInteger(record.skipped) && record.skipped >= value.skipped
                        && Number.isSafeInteger(record.duplicates) && record.duplicates >= value.duplicates) {
                        for (const entry of record.entries) value.entries.push(entry);
                        value.skipped = record.skipped; value.duplicates = record.duplicates;
                    } else if (record.kind === 'result' && Number.isSafeInteger(record.index) && value.entries[record.index]) {
                        const entry = { ...value.entries[record.index], selected: record.selected, result: record.result };
                        if (!record.result || !validEntry(entry, this.platform)) throw new Error('收藏导入进度损坏，已停止提交');
                        value.entries[record.index] = entry;
                    } else throw new Error('收藏导入进度损坏，已停止提交');
                }
                if (!validDraft(value, this.scope, this.platform)) throw new Error('收藏导入进度损坏，已停止提交');
            }
            delete value.journalId;
            this.draft = value; this.count = value.entries.length;
            // Reopening always starts a fresh snapshot before appending, so a
            // torn trailing record can never become part of a later record.
            this.faulted = true;
            return value;
        }
        if (invalid) throw new Error('收藏导入记录损坏，原文件保留；请重新读取收藏');
        return null;
    }
    private enqueue(action: () => Promise<void>): Promise<void> {
        const operation = this.writing.then(action);
        this.writing = operation.catch(() => { this.faulted = true; });
        return operation;
    }
    save(draft: FavoriteDraft): Promise<void> {
        if (!validDraft(draft, this.scope, this.platform)) return Promise.reject(new Error('收藏导入记录无效，已停止提交'));
        const journalId = diagnosticId(), count = draft.entries.length;
        const serialized = JSON.stringify({ ...draft, journalId });
        return this.enqueue(async () => {
            const io = this.app.vault.adapter, oldJournal = this.journal;
            const journal = `${this.path}.${journalId}.jsonl`;
            await directories(io, this.path.split('/').slice(0, -1).join('/'));
            await io.write(journal, '');
            await io.write(this.path + '.tmp', serialized);
            await replaceStaged(io, this.path + '.tmp', this.path);
            if (await io.read(this.path) !== serialized) throw new Error('收藏导入记录保存失败，已停止提交');
            this.journal = journal; this.draft = draft; this.count = count; this.faulted = false;
            if (oldJournal && oldJournal !== journal) try { await io.remove(oldJournal); } catch { /* A stale journal is unreachable from the new snapshot. */ }
        });
    }
    checkpointPage(draft: FavoriteDraft): Promise<void> {
        const entries = draft.entries.slice(this.count);
        if (!entries.every(entry => validEntry(entry, this.platform))) return Promise.reject(new Error('收藏记录无效'));
        return this.append(draft, { kind: 'page', start: this.count, entries, skipped: draft.skipped, duplicates: draft.duplicates });
    }
    checkpointResult(draft: FavoriteDraft, index: number): Promise<void> {
        const entry = draft.entries[index];
        if (!entry?.result || !validEntry(entry, this.platform)) return Promise.reject(new Error('收藏结果无效'));
        return this.append(draft, { kind: 'result', index, selected: entry.selected, result: entry.result });
    }
    private append(draft: FavoriteDraft, record: JournalRecord): Promise<void> {
        const serialized = JSON.stringify(record) + '\n';
        return this.enqueue(async () => {
            if (this.faulted || this.draft !== draft || !this.journal) throw new Error('收藏进度尚未保存，已停止提交');
            await this.app.vault.adapter.append(this.journal, serialized);
            if (record.kind === 'page') this.count += record.entries.length;
        });
    }
}
