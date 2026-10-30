import { PlatformSettingsView } from "./platform-settings";
import { readAccountProfile, type AccountProfile } from "./account-profile";
import { observeLogin, type LoginObserver, type LoggedInProfile } from "./login-observer";
import { checkTranscription, transcribe } from "./transcription";
import { resolveSource, saveArticle } from "./collector";
import { downloadPublicMedia } from "./adapters/media-download";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { TOOL_LABELS, toolsRoot, agentRepairInstructions, type ToolId, type ToolStatus } from './tool-setup';
import { runTool } from "./tools";
import { pendingUpdate } from "./update-gate";
import { PersistentConfig, deviceId, record, directories, replaceStaged } from "./persistent-config";
import { LocalLogger, pluginInstallation } from "./local-diagnostics";
import { DiagnosticsUI } from "./diagnostics-ui";
import { BUILD_CHANNEL } from "./build-channel";
import { cleanupAuthorizationFiles } from "./cookie-file";
import { FolderPickerModal } from "./folder-picker";
import { Events, FuzzySuggestModal, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting, SettingPage, type App, type SettingDefinitionItem, } from "obsidian";
import { BRIDGE_EVENTS, BRIDGE_VERSION, isTaskContext, isLocalRetryContext, type LocalRetryContext, type LocalRetryResult, type HostBridge, type TaskContext, type LocalProperties, type FavoritePlatform, LOCAL_PLATFORM_LABELS, } from "./companion-protocol";
import { normalizeSettings, validPreferences, validMaterialFolder, FEATURES, loginFor, observedAccount, platformFor, supportsFeature, CLIP2MD_USAGE_DOC_URL, type DesktopSettings, type Feature, type LoginPlatform, type PlatformName, } from "./config";
import { AuthorizationRequired, LoginWindowError, SiteSessions } from "./auth";
import { setCredentialProvider } from "./adapters/network";
import { collect, LocalMediaNoAudio } from "./collector";
import { MaterialStore } from "./storage";
import { enqueue, readQueueState, serializeQueueState, taskKey, pauseQueueForUpdate, queueBucket, queueCounts, clearFailedJobs, clearAllJobs, type Job, type QueueState, } from "./queue";
import { checkTool } from "./tools";
import { nowBeijingDateTime } from "./date-format";
import { FavoriteImportModal } from './favorite-import-modal';
const STATE_KEY = "clipmd-desktop-state-v1";
const labels: Record<Feature, string> = {
    metadata: "来源属性",
    article: "正文图文",
    video: "视频／音频",
    comments: "评论",
    subtitles: "字幕与本地转写",
    images: "封面／原图",
};
function localFailureReason(error: unknown): string {
    const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
    if (/评论/.test(text) && !(error instanceof AuthorizationRequired)) return "comments";
    if (error instanceof AuthorizationRequired || /登录|授权/.test(text)) return "authorization";
    if (/媒体|视频|音频|播放器|CDN|下载/.test(text)) return "media";
    if (/工具|ffmpeg|yt-dlp|解析器/.test(text)) return "tools";
    if (/验证|风控|验证码/.test(text)) return "challenge";
    if (/网络|连接|超时|HTTP/.test(text)) return "network";
    return "unknown";
}
export function commentsNeedAuthorization(error: unknown): boolean {
    const message = error instanceof Error ? error.message : "";
    return (/登录|授权|访问验证|登录态/.test(message) &&
        !/不等同于登录失效/.test(message));
}
export async function assertPersistedCookieLogin<T extends AccountProfile>(
    detected: T | undefined,
    inspect: () => Promise<AccountProfile>,
): Promise<AccountProfile> {
    return detected || inspect();
}
function isBilibiliOpusSource(value: string): boolean {
    try {
        const url = new URL(value);
        return (url.hostname === "bilibili.com" || url.hostname.endsWith(".bilibili.com")) && /^\/opus\/[A-Za-z0-9]+(?:\/|$)/.test(url.pathname);
    } catch { return false; }
}
function isKnownNoLoginSource(job: Pick<Job, "context" | "feature">): boolean {
    try {
        const url = new URL(job.context.sourceUrl);
        if ((url.hostname === "zhihu.com" || url.hostname.endsWith(".zhihu.com")) &&
            /^\/question\/[1-9]\d*(?:\/|$)/.test(url.pathname) &&
            !/\/answer\//.test(url.pathname) && job.feature === "comments") return true;
        if ((url.hostname === "douyin.com" || url.hostname.endsWith(".douyin.com")) &&
            /^\/(?:share\/)?article\//.test(url.pathname)) return true;
    } catch { /* stale source is handled by normal queue validation */ }
    return false;
}
class TaskPicker extends FuzzySuggestModal<TaskContext> {
    constructor(app: App, private readonly tasks: TaskContext[], private readonly selected: (context: TaskContext) => void) {
        super(app);
        this.setPlaceholder("选择要补充本地素材的笔记");
    }
    getItems(): TaskContext[] {
        return this.tasks;
    }
    getItemText(c: TaskContext): string {
        return `${c.notePath} · #${c.taskId}`;
    }
    onChooseItem(c: TaskContext): void {
        this.selected(c);
    }
}
class FeaturePicker extends FuzzySuggestModal<Feature> {
    constructor(app: App, private readonly context: TaskContext, private readonly selected: (feature: Feature) => void) {
        super(app);
        this.setPlaceholder("选择需要补充的素材");
    }
    getItems(): Feature[] {
        return FEATURES.filter((f) => supportsFeature(platformFor(this.context.sourceUrl), f));
    }
    getItemText(f: Feature): string {
        return labels[f];
    }
    onChooseItem(f: Feature): void {
        this.selected(f);
    }
}
class DesktopPage extends SettingPage {
    private cleanup?: () => void;
    constructor(private readonly owner: DesktopTools) {
        super();
        this.title = "本地剪藏扩展";
    }
    display(): void {
        this.cleanup?.();
        this.cleanup = this.owner.renderSettings(this.containerEl);
    }
    hide(): void { this.cleanup?.(); this.cleanup=undefined; }
}
class DesktopSettingsTab extends PluginSettingTab {
    constructor(app: App, private readonly owner: DesktopTools) {
        super(app, owner);
    }
    getSettingDefinitions(): SettingDefinitionItem[] {
        return [
            {
                type: "page",
                name: "本地剪藏扩展",
                desc: "自动补充、原站授权、外部工具与素材队列",
                page: () => new DesktopPage(this.owner),
            },
        ];
    }
}
export default class DesktopTools extends Plugin {
    private manuallyEnabled = false;
    private templateWork: Promise<Record<string, string | number | string[]>> | null = null;
    private templateController: AbortController | null = null;
    private preparing: Promise<LocalRetryResult> | null = null;
    private asrReady = false;
    private asrFingerprint = "";
    private verifiedFileState = "";
    private toolSetup: Promise<void> | null = null;
    private setupController: AbortController | null = null;
    private setupError = '';
    private setupViews = new Set<() => void>();
    private toolStatus: Record<ToolId, ToolStatus> = {
        whisper: { phase: 'pending', message: '首次开启时准备' },
        ffmpeg: { phase: 'pending', message: '首次开启时准备' },
        ytdlp: { phase: 'pending', message: '首次开启时准备' },
        model: { phase: 'pending', message: '由插件管理，无需配置模型' },
    };
    private integrated = this.manifest?.name?.includes("(integrated)") === true;
    private retainedConfig?: PersistentConfig;
    private logger?: LocalLogger;
    private diagnostics?: DiagnosticsUI;
    private configurationCleared = false;
    private updatePaused = false;
    private readonly toolVersions: Record<string, string> = {
        whisper: "not-checked",
        whisperCapabilities: "not-checked",
        ffmpeg: "not-checked",
        ytdlp: "not-checked",
        ffmpegCapabilities: "not-checked",
        ytdlpCapabilities: "not-checked",
    };
    private async savePreferences(): Promise<void> {
        if (this.configurationCleared)
            return;
        this.sessions?.setWebDomains?.(this.settings.webDomains);
        const device = deviceId(this.app);
        const { ffmpeg, ytdlp, whisper, whisperModel, language, asrTimeoutMinutes, ...shared } = this.settings;
        await this.retainedConfig?.save(shared);
        this.app.saveLocalStorage(`clip2md-tools-${device}`, { ffmpeg, ytdlp, whisper, whisperModel, language, asrTimeoutMinutes });
        await this.saveData(shared);
    }
    async onExternalSettingsChange(): Promise<void> {
        const raw: unknown = await this.loadData();
        if (!validPreferences(raw)) {
            new Notice("外部配置格式无效");
            return;
        }
        const paths = { ffmpeg: this.settings.ffmpeg, ytdlp: this.settings.ytdlp, whisper: this.settings.whisper, whisperModel: this.settings.whisperModel, language: this.settings.language, asrTimeoutMinutes: this.settings.asrTimeoutMinutes };
        this.settings = { ...normalizeSettings(raw), ...paths };
        await this.savePreferences();
    }
    private async dependencyGuide(): Promise<void> {
        const state = await pluginInstallation(this.app.vault.adapter, this.app.vault.configDir, "clipmd");
        const modal = new Modal(this.app);
        modal.titleEl.setText("需要 Clip2MD 主插件");
        modal.contentEl.createEl("p", {
            text: state.installed
                ? "请在设置 → 社区插件中启用 Clip2MD 主插件。已启用时请检查两个插件版本、绑定状态和更新事务状态。"
                : "桌面扩展需要主插件完成云端绑定、同步与笔记写入。请先安装并启用主插件。",
        });
        modal.contentEl.createEl("a", {
            text: BUILD_CHANNEL === "market"
                ? "打开主插件社区页面"
                : "下载网站组合包与安装说明",
            href: BUILD_CHANNEL === "market"
                ? "obsidian://show-plugin?id=clipmd"
                : "https://clip2.md/app/sync",
        });
        modal.open();
    }
    declare settings: DesktopSettings;
    private state!: QueueState;
    private bridge: HostBridge | null = null;
    private events!: Events;
    private sessions!: SiteSessions;
    private store!: MaterialStore;
    private scope = "";
    private active: AbortController | null = null;
    private alive = true;
    private running: Promise<void> | null = null;
    private retryTimer: number | null = null;
    private queuePaused = false;
    private queueFilter: 'all' | 'cloud-failed' | 'failed' = 'all';
    private authNotified = new Set<string>();
    private authRetrySuppressedUntil = new Map<LoginPlatform, number>();
    private autoRetriedJobs = new Set<string>();
    private favoriteModal?: FavoriteImportModal;
    /** Prevent a burst of failed jobs for one source from opening duplicate login windows. */
    private loginPrompts = new Set<LoginPlatform>();
    private status = "等待 Clip2MD 主插件";
    private statusElements = new Set<HTMLElement>();
    private settingsViews = new Map<HTMLElement, () => void>();
    private profileViews = new Set<PlatformSettingsView>();
    private generation = 0;
    private attaching: Promise<void> = Promise.resolve();
    private initialization?: Promise<void>;
    onload(): Promise<void> { return this.initialization ??= this.initialize(); }
    private async initialize(): Promise<void> {
        if (!Platform.isDesktopApp ||
            !(["darwin", "win32"].includes(process.platform) &&
                ["arm64", "x64"].includes(process.arch) &&
                !(process.platform === "win32" && process.arch !== "x64"))) {
            new Notice("桌面扩展首期仅支持 macOS 与 Windows x64");
            return;
        }
        this.logger = new LocalLogger(this.app, "clipmd-desktop-tools", this.manifest.version);
        this.logger.log("plugin.start");
        this.retainedConfig = new PersistentConfig(this.app.vault.adapter, this.app.vault.configDir, "clipmd-desktop-tools", (value) => {
            const shared: Record<string, unknown> = { ...normalizeSettings(value) };
            delete shared.ffmpeg;
            delete shared.ytdlp;
            delete shared.whisper;
            delete shared.whisperModel;
            delete shared.language;
            delete shared.asrTimeoutMinutes;
            return shared;
        }, validPreferences);
        let legacy: unknown;
        const restored = await this.retainedConfig
            .load(async () => {
            legacy = await this.loadData();
            return legacy;
        })
            .catch((error: unknown) => {
            this.logger?.log("config.recovery.failed", {}, "error");
            new Notice("保留配置无法恢复，已保留原文件，请检查备份后重新启用扩展", 15000);
            throw error instanceof Error ? error : new Error("配置恢复失败");
        });
        const paths: unknown = this.app.loadLocalStorage(`clip2md-tools-${deviceId(this.app)}`);
        this.settings = normalizeSettings({
            ...restored.data,
            ...(record(paths)
                ? paths
                : record(legacy)
                    ? { ffmpeg: legacy.ffmpeg, ytdlp: legacy.ytdlp }
                    : {}),
        });
        this.manuallyEnabled = this.app.loadLocalStorage("clip2md-desktop-enabled-v1") === true;
        await this.savePreferences();
        this.logger.log("config.loaded", { source: restored.source });
        this.diagnostics = new DiagnosticsUI({
            app: this.app,
            logger: this.logger,
            apiBase: "https://api.clip2md.cn/api/v1",
            website: "https://clip2.md",
            enabled: () => ({ clipmd: !!this.bridge, "clipmd-desktop-tools": true }),
            tools: () => this.toolVersions,
            delegate: () => {
                if (!this.bridge?.openFeedback)
                    return false;
                this.bridge.openFeedback();
                return true;
            },
        });
        this.addCommand({
            id: "feedback",
            name: "反馈问题",
            callback: () => this.diagnostics?.open(),
        });
        this.addCommand({
            id: "export-diagnostics",
            name: "导出诊断报告",
            callback: () => {
                void this.diagnostics?.export();
            },
        });
        this.state = await this.restoreQueueState();
        this.queuePaused = this.app.loadLocalStorage('clip2md-desktop-queue-paused-v1') === true;
        this.events = this.app.workspace;
        this.sessions = new SiteSessions(this.app);
        this.sessions.setBrowserCookieProvider(async (platform, signal) => {
            if (BUILD_CHANNEL !== "website" || (platform !== "youtube" && platform !== "twitter")) return [];
            try {
                const { readChromeCookies } = await import("./browser-cookies");
                const cookies = await readChromeCookies(this.settings.ytdlp, signal);
                this.logger?.log("auth.browser_cookies", { platform, count: cookies.length, available: cookies.length > 0 });
                return cookies;
            } catch (error) {
                this.logger?.log("auth.browser_cookies_failed", { platform, code: error instanceof Error ? error.name : "unknown" }, "warn");
                return [];
            }
        });
        this.sessions.setWebDomains(this.settings.webDomains);
        this.store = new MaterialStore(this.app,()=>this.settings.materialFolder);
        try {
            await cleanupAuthorizationFiles();
            await this.store.cleanupCache();
        }
        catch {
            new Notice("任务缓存或临时授权文件无法安全清理，请检查本机临时目录与 Vault 缓存后重新启用扩展");
            return;
        }
        setCredentialProvider((url) => this.sessions.cookieHeader(url));
        this.registerEvent(this.events.on(BRIDGE_EVENTS.ready, (value) => {
            this.updateStatus("已发现主插件，正在连接");
            this.attaching = this.attaching
                .catch(() => undefined)
                .then(() => this.attach(value));
            void this.attaching.catch(() => this.updateStatus("主插件接口初始化失败，素材处理已暂停"));
        }));
        this.registerEvent(this.events.on(BRIDGE_EVENTS.saved, (value) => {
            if (isTaskContext(value))
                void this.attaching
                    .then(() => this.onTaskSaved(value))
                    .catch(() => this.updateStatus("素材任务未能加入队列"));
        }));
        this.registerEvent(this.events.on(BRIDGE_EVENTS.offline, () => {
            this.generation++;
            this.active?.abort();
            this.bridge = null;
            this.scope = "";
            for(const cleanup of this.settingsViews.values())cleanup();
            void this.sessions.setScope("");
            this.updateStatus("主插件已停用或绑定变化，素材处理暂停");
        }));
        if (!this.integrated)
            this.addSettingTab(new DesktopSettingsTab(this.app, this));
        this.addCommand({
            id: "open-desktop-tools",
            name: "打开本地素材与授权",
            callback: () => this.openSettings(),
        });
        this.addCommand({
            id: "supplement-existing-note",
            name: "为已有剪藏补充素材",
            callback: () => {
                void this.chooseTask();
            },
        });
        this.addCommand({
            id: "refresh-local-properties",
            name: "刷新来源属性并确认替换本地属性",
            callback: () => {
                void this.confirmRefresh();
            },
        });
        this.addCommand({
            id: "cancel-local-download",
            name: "停止当前素材任务",
            callback: () => {
                this.active?.abort();
            },
        });
        if (BUILD_CHANNEL === "website" && (await pendingUpdate(this.app))) {
            this.updatePaused = true;
            this.updateStatus("配套更新等待主插件恢复并重启，请先启用主插件");
        }
        this.emit(BRIDGE_EVENTS.hello, BRIDGE_VERSION);
        this.updateStatus(this.status);
        const dependencyTimer = window.setTimeout(() => {
            if (this.alive && !this.bridge)
                new Notice("桌面扩展需要 Clip2MD 主插件。请打开扩展设置，点击“安装或启用主插件”。", 12000);
        }, 2500);
        this.register(() => window.clearTimeout(dependencyTimer));
        await this.attaching;
    }
    private async restoreQueueState(): Promise<QueueState> {
        const raw: unknown = this.app.loadLocalStorage(STATE_KEY);
        try {
            return readQueueState(raw);
        }
        catch {
            const backup = await this.backupQueueState(raw);
            this.app.saveLocalStorage(STATE_KEY, { version: 1, jobs: [], properties: {} });
            this.logger?.log(
                backup ? "queue.recovered" : "queue.recovery_failed",
                { status: backup ? "reset" : "reset_without_backup" },
                backup ? "warn" : "error",
            );
            new Notice(
                backup
                    ? "本地素材队列格式异常，旧队列已备份并重新初始化；请重新开启本地剪藏。"
                    : "本地素材队列格式异常，已重新初始化，但旧队列备份失败；请先导出诊断再继续。",
                12000,
            );
            return readQueueState(null);
        }
    }
    private async backupQueueState(raw: unknown): Promise<string | null> {
        const directory = `${this.app.vault.configDir}/clip2md/recovery`;
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const path = `${directory}/queue-state-${timestamp}.json`;
        try {
            try {
                await this.app.vault.adapter.mkdir(directory);
            }
            catch {
                // The recovery directory may already exist.
            }
            await this.app.vault.adapter.write(
                path,
                JSON.stringify(
                    {
                        schema: 1,
                        source: STATE_KEY,
                        state: raw ?? null,
                    },
                    null,
                    2,
                ),
            );
            return path;
        }
        catch (error) {
            console.warn("Clip2MD: 本地素材队列备份失败", error);
            return null;
        }
    }
    onunload(): void {
        this.logger?.log("plugin.stop");
        this.diagnostics?.stop();
        this.alive = false;
        this.favoriteModal?.close();
        this.generation++;
        this.active?.abort();
        this.setupController?.abort();
        this.templateController?.abort();
        setCredentialProvider(async () => "");
        void this.sessions?.close();
        if (this.events)
            this.emit(BRIDGE_EVENTS.state, {
                version: BRIDGE_VERSION,
                deployment: this.integrated ? "integrated" : "companion",
                available: false,
                enabled: false,
                message: "桌面扩展已停用",
            });
        for (const cleanup of this.settingsViews.values()) cleanup();
        this.settingsViews.clear();
        this.statusElements.clear();
        this.setupViews.clear();
    }
    private emit(event: string, ...args: unknown[]): void {
        try {
            this.events.trigger(event, ...args);
        }
        catch {
            /* Optional listeners never stop the queue. */
        }
    }
    private updateStatus(message: string): void {
        this.status = message;
        if (!this.alive)
            return;
        for (const el of this.statusElements) {
            if (el.isConnected)
                el.setText(message);
            else
                this.statusElements.delete(el);
        }
        if (this.events)
            this.emit(BRIDGE_EVENTS.state, {
                version: BRIDGE_VERSION,
                deployment: this.integrated ? "integrated" : "companion",
                available: !!this.bridge && !!this.scope,
                enabled: this.manuallyEnabled,
                runtimeVersion: this.manifest.version,
                getRecoveryReadiness: () => this.recoveryReadiness(),
                cancelLocalRetry: () => { if (this.preparing) this.active?.abort(); },
                readyFeatures: !this.manuallyEnabled || !this.bridge || !this.scope ? [] : this.asrReady && this.asrFingerprint === this.toolFingerprint() ? ["metadata", "transcription", "local-retry"] : ["metadata", "local-retry"],
                setEnabled: (enabled: boolean) => this.setEnabled(enabled),
                renderSettings: (container: HTMLElement) => this.renderSettings(container, false),
                prepareTemplateValues: (context: LocalRetryContext, names: string[]) => this.prepareTemplateValues(context, names),
                prepareLocalRetry: (context: LocalRetryContext) => this.prepareLocalRetry(context),
                capabilities: ["update-pause-v1", "desktop-control-v1", "local-retry-v1", "local-template-v1"],
                tools: this.toolVersions,
                prepareUpdate: async () => {
                    this.updatePaused = true;
                    this.setupController?.abort();
                    await this.toolSetup;
                    this.templateController?.abort();
                    const scope = this.scope;
                    await pauseQueueForUpdate(this.state, this.active, this.running || this.preparing?.then(() => undefined).catch(() => undefined) || null, () => this.scope === scope && !!this.bridge);
                    await this.templateWork?.catch(() => undefined);
                    this.persist();
                },
                resumeAfterUpdate: () => {
                    this.updatePaused = false;
                    if (this.manuallyEnabled && !this.asrReady) void this.prepareTools();
                    this.drain();
                },
                message,
                openSettings: () => this.openSettings(),
            });
    }
    private valuesPath(context: {
        bindingScope: string;
        taskId: number;
    }): string {
        return `${this.app.vault.configDir}/clip2md/local-values/${deviceId(this.app)}/${context.bindingScope}/${context.taskId}.json`;
    }
    private async readValues(context: {
        bindingScope: string;
        taskId: number;
    }): Promise<Record<string, string | number | string[]>> {
        const file = this.valuesPath(context);
        if (!(await this.app.vault.adapter.exists(file)))
            return {};
        const value: unknown = JSON.parse(await this.app.vault.adapter.read(file));
        if (!record(value))
            throw new Error("本地字段快照无效");
        return Object.fromEntries(Object.entries(value).filter(([key, v]) => /^local_[a-z_]+$/.test(key) && (typeof v === 'string' || typeof v === 'number' || Array.isArray(v) && v.every(s => typeof s === 'string')))) as Record<string, string | number | string[]>;
    }
    private async writeValues(context: {
        bindingScope: string;
        taskId: number;
    }, values: Record<string, string | number | string[]>): Promise<void> {
        const file = this.valuesPath(context);
        await directories(this.app.vault.adapter, file.split('/').slice(0, -1).join('/'));
        await this.app.vault.adapter.write(file + '.tmp', JSON.stringify(values));
        await replaceStaged(this.app.vault.adapter, file + '.tmp', file);
    }
    private prepareTemplateValues(context: LocalRetryContext, names: string[]): Promise<Record<string, string | number | string[]>> {
        if(!isLocalRetryContext(context))return Promise.reject(new Error("模板任务身份无效"));
        if (this.templateWork || this.preparing || this.running || this.active)
            return Promise.reject(new Error("请等待当前本地任务完成"));
        const controller = new AbortController();
        this.templateController = controller;
        const timeout = window.setTimeout(() => controller.abort(), this.settings.asrTimeoutMinutes * 60000);
        const work = this.collectTemplateValues(context, names, controller.signal);
        this.templateWork = work;
        return work.finally(() => { window.clearTimeout(timeout); if (this.templateWork === work)
            this.templateWork = null; if (this.templateController === controller)
            this.templateController = null; this.drain(); });
    }
    private async collectTemplateValues(context: LocalRetryContext, names: string[], signal: AbortSignal): Promise<Record<string, string | number | string[]>> {
        if (!this.manuallyEnabled || !this.bridge || await this.bridge.bindingScope?.() !== context.bindingScope)
            throw new Error("桌面功能或绑定尚未准备好");
        await this.requirePlatformLogin(context.sourceUrl,signal);
        if (names.some(name => name.startsWith("local_transcript") || name === "local_transcribed_at")) {
            if (!this.settings.platforms[platformFor(context.sourceUrl)].subtitles)
                throw new Error("请先在该平台开启字幕与本地转写");
            await this.prepareLocalRetry(context, true);
        }
        const cached = await this.readValues(context);
        const resolved=await this.bridge.resolveTask?.(context.taskId);
        const c: TaskContext = { ...context, contentVersion: context.revision, notePath: resolved?.notePath || [context.targetFolder ?? 'Clip2MD',`${context.taskId}.md`].filter(Boolean).join('/'), daily: false };
        const values: Record<string, string | number | string[]> = { ...(cached || {}) };
        for (const feature of ["metadata", "images", "video", "comments"] as const) {
            const materialNames = ['local_assets', 'local_cover', 'local_media', 'local_gallery'];
            const needed = feature === "metadata"
                ? names.some(name => !name.startsWith("local_transcript") && name !== "local_transcribed_at" && !materialNames.includes(name))
                : names.includes('local_assets') || (feature === 'images' && names.some(name => name === 'local_cover' || name === 'local_gallery'))
                    || (feature === 'video' && names.includes('local_media'));
            if (needed && this.settings.platforms[platformFor(context.sourceUrl)][feature]) {
                const result = await collect(c, feature, this.settings, this.sessions, this.store, signal, message => this.updateStatus(message));
                for (const [name, value] of Object.entries(result.properties))
                    if (value !== undefined)
                        values[`local_${name}`] = value;
                if (result.assets.length)
                    values.local_assets = [...new Set([...(Array.isArray(values.local_assets) ? values.local_assets : []), ...result.assets])];
                if (feature === 'images') {
                    values.local_cover = result.assets[0] || '';
                    values.local_gallery = [...new Set(result.assets)];
                }
                if (feature === 'video') values.local_media = [...new Set(result.assets.filter(file=>/\.(?:mp4|m4v|mkv|webm|mov|ogv|mpeg|mpg|mp3|m4a|wav|ogg|oga|flac|opus|aac|3gp|m3u8|ts|flv)$/i.test(file)))];
            }
        }
        await this.writeValues(context, values);
        return values;
    }
    private async requirePlatformLogin(sourceUrl:string,signal:AbortSignal):Promise<void> {
        const platform=loginFor(sourceUrl,this.settings.webDomains);
        if(platform.startsWith('web:') && !this.settings.webDomains.includes(platform.slice(4)))throw new AuthorizationRequired('请先在通用网页中添加该域名并完成登录');
        // Generic web pages are often public. Probe them anonymously and
        // request authorization only if the rendered page is actually a
        // login or access-challenge page.
        if(platform.startsWith('web:'))return;
        const checked = await (async()=>{
            if(platform==='youtube'||platform==='twitter')return readAccountProfile(this.sessions,platform,AbortSignal.any([signal,AbortSignal.timeout(platform==='youtube'?60000:15000)]));
            return await this.sessions.cookieLoginProfile(platform) || await readAccountProfile(this.sessions,platform,AbortSignal.any([signal,AbortSignal.timeout(15000)]));
        })();
        signal.throwIfAborted();
        const sessionCookies = typeof (this.sessions as unknown as { authorizedCookies?: unknown }).authorizedCookies === "function"
            ? await this.sessions.authorizedCookies(platform)
            : [];
        const cookieNames: Partial<Record<LoginPlatform, string[]>> = {
            bilibili: ['SESSDATA'],
            douyin: ['sessionid', 'sessionid_ss'],
            xiaohongshu: ['web_session'],
            zhihu: ['z_c0'],
        };
        const hasStoredAuthorization = typeof (this.sessions as unknown as { hasStoredAuthorization?: unknown }).hasStoredAuthorization === "function" &&
            this.sessions.hasStoredAuthorization(platform);
        const hasLocalStorageAuthorization = typeof (this.sessions as unknown as { hasLocalStorageAuthorization?: unknown }).hasLocalStorageAuthorization === "function" &&
            this.sessions.hasLocalStorageAuthorization(platform);
        // Xiaohongshu may keep the usable session in localStorage or opaque
        // partition state instead of `web_session`; the saved SecretStorage
        // record is the only reliable local proof after a restart.
        const savedSession = hasStoredAuthorization && (
            platform === "xiaohongshu"
            || sessionCookies.some(cookie =>
                (cookieNames[platform] || []).includes(cookie.name) && !!cookie.value &&
                (!cookie.expirationDate || cookie.expirationDate > Date.now() / 1000),
            )
        );
        this.logger?.log("auth.check", {
            platform: platform.startsWith("web:") ? "web" : platform,
            status: checked.state,
            available: hasStoredAuthorization,
            count: sessionCookies.length,
            source: hasLocalStorageAuthorization ? "local-storage" : savedSession ? "stored" : "none",
        });
        if(checked.state!=='authenticated' && !savedSession) {
            for(const view of this.profileViews)view.expired(platform);
            throw new AuthorizationRequired('请先在本地剪藏扩展中完成原站登录，登录完成前所有功能不可用');
        }
    }
    private async enqueuePlatformArticles(platform: PlatformName): Promise<void> {
        if(!this.bridge||!this.scope||!this.manuallyEnabled)return;
        const tasks=await this.bridge.listTasks();
        for(const context of tasks) {
            if(platformFor(context.sourceUrl)!==platform||context.bindingScope!==this.scope)continue;
            const key=taskKey(context);
            if(!this.state.jobs.some(job=>job.context.bindingScope===this.scope&&taskKey(job.context)===key&&job.feature==='article'&&['queued','waiting-auth','running','waiting-write','complete'].includes(job.status)))
                enqueue(this.state,context,'article');
        }
        this.persist();this.drain();
    }
    private async localToolState():Promise<string> {
        return JSON.stringify(await Promise.all([this.settings.ffmpeg,this.settings.whisper,this.settings.whisperModel].map(async file=>{const stat=await fs.stat(file);return [stat.size,stat.mtimeMs,stat.ino];})));
    }
    private async recoveryReadiness(): Promise<import("./companion-protocol").RecoveryReadiness> {
        const busy = !!(this.active || this.running || this.preparing || this.templateWork || this.toolSetup);
        if (!this.manuallyEnabled) return {ready:false,busy,reason:"disabled"};
        if (!this.bridge || !this.scope || await this.bridge.bindingScope?.() !== this.scope) return {ready:false,busy,reason:"unbound"};
        if (this.updatePaused || this.bridge.updatePaused?.()) return {ready:false,busy,reason:"updating"};
        return {ready:true,busy,reason:"ready"};
    }
    private async assertASRReady():Promise<void> {
        if(!this.asrReady || this.asrFingerprint!==this.toolFingerprint() || this.verifiedFileState!==await this.localToolState()) {
            this.asrReady=false;this.toolVersions.whisperCapabilities="not-checked";this.updateStatus(this.toolSetup ? "正在准备本地工具" : "本地工具未就绪，请在扩展设置中重试检查");throw new Error("请先在扩展设置中完成工具准备");
        }
    }
    private toolFingerprint(): string { return JSON.stringify([this.settings.whisper, this.settings.whisperModel, this.settings.ffmpeg, this.settings.language]); }
    async setEnabled(enabled: boolean): Promise<void> {
        if (enabled && (!this.bridge || (this.bridge.integratedDesktop && !this.integrated)))
            throw new Error("请先安装并启用主插件；网站版使用整合实例");
        this.manuallyEnabled = enabled;
        this.logger?.log("desktop.enabled", { status: enabled ? "enabled" : "disabled" });
        this.app.saveLocalStorage("clip2md-desktop-enabled-v1", enabled);
        if (!enabled) {
            this.setupController?.abort();
            for(const cleanup of this.settingsViews.values())cleanup();
            this.generation++;
            this.active?.abort();
            this.templateController?.abort();
            await this.running;
            await this.preparing?.catch(() => undefined);
            await this.templateWork?.catch(() => undefined);
            await this.toolSetup?.catch(() => undefined);
            await this.sessions.close();
        }
        if (enabled)
            await this.sessions.setScope(this.scope);
        this.updateStatus(enabled ? "已开启，请检查能力配置" : "桌面扩展已关闭，配置保留");
        if (enabled && !this.asrReady) void this.prepareTools();
        if (enabled)
            this.drain();
    }
    private setToolStatus(tool: ToolId, phase: ToolStatus['phase'], message: string): void {
        const changed = this.toolStatus[tool].phase !== phase;
        this.toolStatus[tool] = { phase, message };
        if (changed) this.logger?.log('tools.setup', { source: tool, status: phase });
        for (const refresh of this.setupViews) refresh();
    }
    private prepareTools(): Promise<void> {
        if (this.toolSetup) return this.toolSetup;
        if (!this.alive || !this.manuallyEnabled || !this.bridge || this.updatePaused) return Promise.resolve();
        const controller = new AbortController();
        this.setupController = controller;
        this.setupError = '';
        this.asrReady = false;
        for (const tool of Object.keys(this.toolStatus) as ToolId[]) this.setToolStatus(tool, 'pending', '等待本次准备或检查');
        this.updateStatus(BUILD_CHANNEL === 'website' ? '正在自动准备本地工具与固定转写资源' : '正在检查已安装的本地工具');
        const operation = (async () => {
            const installer = BUILD_CHANNEL === 'website' ? await import('./tool-installer') : await import('./tool-installer-market');
            const paths = await installer.prepareManagedTools(toolsRoot(), controller.signal, (tool, phase, message) => this.setToolStatus(tool, phase, message));
            controller.signal.throwIfAborted();
            if (!this.alive || !this.manuallyEnabled) return;
            Object.assign(this.settings, paths, { language: 'auto' });
            await this.savePreferences();
            const work = await fs.mkdtemp(path.join(os.tmpdir(), 'clip2md-tools-check-'));
            try {
                for (const kind of ['ffmpeg', 'ytdlp'] as const) {
                    this.setToolStatus(kind, 'checking', '正在检查版本与所需能力');
                    this.toolVersions[kind] = await checkTool(kind, this.settings, work, controller.signal);
                    this.toolVersions[`${kind}Capabilities`] = 'verified';
                    this.setToolStatus(kind, 'ready', this.toolVersions[kind]);
                }
                this.setToolStatus('whisper', 'checking', '正在执行真实短音频转写自检');
                await this.verifyASR(controller.signal);
                controller.signal.throwIfAborted();
                this.setToolStatus('whisper', 'ready', '转写自检通过');
                this.setToolStatus('model', 'ready', '固定多语言转写资源已就绪，无需选择模型');
                this.updateStatus('本地工具已准备好，请分别开启并配置平台');
                this.drain();
            } finally { await fs.rm(work, { recursive: true, force: true }); }
        })().catch((error: unknown) => {
            this.asrReady = false;
            if (controller.signal.aborted || !this.alive || !this.manuallyEnabled) return;
            this.setupError = error instanceof Error ? error.message : '工具准备失败';
            for (const tool of Object.keys(this.toolStatus) as ToolId[])
                if (this.toolStatus[tool].phase === 'checking' || this.toolStatus[tool].phase === 'pending' || this.toolStatus[tool].phase === 'installing' || this.toolStatus[tool].phase === 'downloading')
                    this.setToolStatus(tool, 'failed', '准备未完成，请重试或使用 Agent 修复');
            this.updateStatus('本地工具准备失败，可在扩展设置中重试；建议使用 Agent 安装并修复');
            new Notice('本地工具准备失败。请在本地剪藏扩展中重试，或复制修复说明交给 Agent。', 12000);
        }).finally(() => {
            if (this.setupController === controller) this.setupController = null;
            this.toolSetup = null;
            for (const refresh of this.setupViews) refresh();
        });
        this.toolSetup = operation;
        for (const refresh of this.setupViews) refresh();
        return operation;
    }
    private async verifyASR(signal = AbortSignal.timeout(180000)): Promise<void> {
        if (!this.manuallyEnabled)
            throw new Error("请先手动开启桌面扩展");
        if (!this.bridge) throw new Error('请先启用主插件');
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clip2md-asr-check-'));
        this.asrReady = false;
        try {
            this.toolVersions.whisper = await checkTranscription(this.settings, directory, signal);
            signal.throwIfAborted();
            this.asrReady = true;
            this.asrFingerprint = this.toolFingerprint();
            this.verifiedFileState=await this.localToolState();this.toolVersions.whisperCapabilities="verified";
        }
        finally {
            await fs.rm(directory, { recursive: true, force: true });
            this.updateStatus(this.asrReady ? "本地转写已准备好" : "本地转写检查失败");
        }
    }
    private prepareLocalRetry(request: LocalRetryContext, fromTemplate = false): Promise<LocalRetryResult> {
        if (this.templateWork && !fromTemplate)
            return Promise.reject(new Error("模板素材正在处理"));
        if (this.preparing)
            return Promise.reject(new Error("请等待当前本地任务完成"));
        const work = this.runLocalRetry(request).catch((error: unknown) => {
            if (error instanceof AuthorizationRequired) {
                const platform=platformFor(request.sourceUrl);
                if(platform==="bilibili"||platform==="douyin"||platform==="xiaohongshu")for(const view of this.profileViews)view.expired(platform);
                throw new Error("local_authorization_required");
            }
            throw error;
        });
        this.preparing = work;
        return work.finally(() => { if (this.preparing === work)
            this.preparing = null; });
    }
    private async runLocalRetry(request: LocalRetryContext): Promise<LocalRetryResult> {
        if(!isLocalRetryContext(request))throw new Error("本地任务身份无效");
        if (!this.manuallyEnabled || !this.bridge || this.active || this.running || this.updatePaused || this.bridge.updatePaused?.())
            throw new Error("请先开启桌面功能，等待当前任务或更新完成");
        if (!this.settings.platformEnabled[platformFor(request.sourceUrl)]) throw new Error("请先在本地剪藏扩展中开启并配置该平台");
        if (await this.bridge.bindingScope?.() !== request.bindingScope)
            throw new Error("绑定已变化");
        const generation = this.generation, controller = new AbortController();
        this.active = controller;
        const timer = window.setTimeout(() => controller.abort(), this.settings.asrTimeoutMinutes * 60000);
        const context: TaskContext = { ...request, contentVersion: request.revision, notePath: [request.targetFolder ?? 'Clip2MD',`${request.taskId}.md`].filter(Boolean).join('/'), daily: false };
        let directory = "", complete = false;
        try {
            const resolved=await this.bridge.resolveTask?.(request.taskId);
            if(resolved)context.notePath=resolved.notePath;
            await this.requirePlatformLogin(request.sourceUrl,controller.signal);
            const result = await resolveSource(context, this.sessions, controller.signal);
            let markdown = result.content.markdown, provenance = result.content.transcription_source || "source-page";
            if(platformFor(request.sourceUrl)==='web') {
                const article=await saveArticle(context,result,this.settings,this.store,controller.signal);
                markdown=article.markdown;
                provenance='authenticated-web-page';
                if(this.settings.platforms.web.video && (result.media || result.detectedMedia)) {
                    const captured=await collect(context,'video',this.settings,this.sessions,this.store,controller.signal,()=>{});
                    markdown+='\n\n'+captured.body;
                }
            }
            else if (result.media) {
                await this.assertASRReady();
                directory = await this.store.checkpoint(context);
                const sources = result.media.parts?.length ? result.media.parts : [{ ...result.media, duration_seconds: result.media.expectedDurationSeconds || result.content.duration_seconds }];
                let remaining = this.settings.maxBytes, offset = 0;
                const transcripts: string[] = [];
                let allEmbedded = true;
                for (const [index, source] of sources.entries()) {
                    const part = path.join(directory, String(index));
                    await fs.mkdir(part, { recursive: true, mode: 0o700 });
                    const media = await downloadPublicMedia(source.url, controller.signal, request.sourceUrl, part, undefined, { maxBytes: remaining, timeoutMs: this.settings.timeoutMinutes * 60000 });
                    remaining -= media.bytes;
                    const embedded = path.join(part, "embedded.srt");
                    let text = "";
                    try {
                        await fs.rm(embedded, { force: true });
                        await runTool(this.settings.ffmpeg, ["-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", media.path, "-map", "0:s:0", "-c:s", "srt", "-n", embedded], part, controller.signal);
                        text = await fs.readFile(embedded, "utf8");
                        if (!text.trim() || Buffer.byteLength(text) > 4 * 1024 * 1024)
                            throw new Error("字幕为空或超过上限");
                    }
                    catch {
                        controller.signal.throwIfAborted();
                        text = await transcribe(media.path, part, this.settings, controller.signal, source.duration_seconds, offset);
                        allEmbedded = false;
                    }
                    transcripts.push(text);
                    offset += (source.duration_seconds || 0) * 1000;
                }
                markdown = transcripts.join("\n\n");
                provenance = allEmbedded ? "embedded-subtitle" : "whisper.cpp";
            }
            if (!result.media && !result.content.transcription_source && result.content.duration_seconds && ["bilibili", "douyin"].includes(platformFor(request.sourceUrl)))
                throw new Error("来源未提供完整字幕或媒体，未用简介冒充转写");
            if (!markdown.trim() || Buffer.byteLength(markdown) > 10 * 1024 * 1024)
                throw new Error("原文为空或超过回传限制");
            if (generation !== this.generation || await this.bridge?.bindingScope?.() !== request.bindingScope)
                throw new Error("绑定或桌面状态已变化");
            const capturedAt = nowBeijingDateTime();
            const sourceTitle = result.content.source_title || result.content.title || "";
            const transcriptFile = await this.store.text(context, "local-retry-source", markdown);
            await this.writeValues(request, { local_transcript: markdown, local_transcript_link: transcriptFile, local_transcript_language: this.settings.language, local_transcript_source: provenance, local_transcribed_at: capturedAt, local_source_title: sourceTitle });
            this.logger?.log("local_retry.prepared", { taskId: request.taskId, status: "complete" });
            complete = true;
            return { markdown, sourceTitle, provenance, capturedAt };
        }
        finally {
            window.clearTimeout(timer);
            if (this.active === controller)
                this.active = null;
            if (directory) {
                await fs.rm(path.join(directory, "active.json"), { force: true });
                if (complete)
                    await fs.rm(directory, { recursive: true, force: true });
            }
            this.drain();
        }
    }
    private persist(): void {
        const serialized = serializeQueueState(this.state);
        this.app.saveLocalStorage(STATE_KEY, JSON.parse(serialized));
        this.app.saveLocalStorage('clip2md-desktop-queue-paused-v1', this.queuePaused);
        const saved: unknown = this.app.loadLocalStorage(STATE_KEY);
        if (JSON.stringify(saved) !== serialized)
            throw new Error("本机素材队列保存失败，已停止");
    }
    private async attach(value: unknown): Promise<void> {
        if (!this.alive)
            return;
        if (!value ||
            typeof value !== "object" ||
            (value as HostBridge).version !== BRIDGE_VERSION ||
            typeof (value as HostBridge).listTasks !== "function" ||
            typeof (value as HostBridge).resolveTask !== "function" ||
            typeof (value as HostBridge).applyMetadata !== "function") {
            this.bridge = null;
            this.active?.abort();
            this.updateStatus("联动协议不兼容，请分别更新两个插件");
            return;
        }
        if (BUILD_CHANNEL === "website" && (await pendingUpdate(this.app))) {
            this.updatePaused = true;
            this.updateStatus("配套更新尚未恢复或等待重启");
            return;
        }
        this.updatePaused = false;
        const bridge = value as HostBridge;
        if (bridge.integratedDesktop && !this.integrated) {
            this.manuallyEnabled = false;
            this.updateStatus("网站版已整合桌面功能，请使用主插件中的设置");
            return;
        }
        const generation = ++this.generation;
        this.active?.abort();
        const tasks = await bridge.listTasks();
        if (!this.alive || generation !== this.generation)
            return;
        const scope = await bridge.bindingScope?.() || tasks.find(isTaskContext)?.bindingScope || "";
        if(this.scope!==scope)for(const cleanup of this.settingsViews.values())cleanup();
        await this.sessions.setScope(scope);
        if (generation !== this.generation)
            return;
        this.scope = scope;
        this.bridge = bridge;
        this.updateStatus(scope
            ? "已连接主插件；请在本地剪藏扩展中配置平台"
            : "已连接主插件；请绑定并同步一篇笔记");
        if (this.manuallyEnabled && !this.asrReady) void this.prepareTools();
        this.drain();
        void this.autoRetryProtectedPlatformJobs();
        void this.autoRetryKnownSourceJobs();
        void this.pauseFailedAuthorizationJobs();
        void this.promptWaitingAuthJobs();
    }
    /** Reopen one login window for each paused platform after a plugin restart. */
    private async promptWaitingAuthJobs(): Promise<void> {
        if (!this.alive || !this.manuallyEnabled || !this.scope) return;
        const platforms = new Set<LoginPlatform>();
        for (const job of this.state.jobs) {
            if (job.status !== "waiting-auth" || job.context.bindingScope !== this.scope) continue;
            try { platforms.add(loginFor(job.context.sourceUrl, this.settings.webDomains)); }
            catch { /* Invalid stale task identities are ignored. */ }
        }
        let changed = false;
        for (const platform of platforms) {
            // YouTube and X are authorized from the user's Chrome profile.
            // Check that bridge after reconnecting as well; otherwise a task
            // that was paused before an Obsidian restart would never resume
            // even after the browser login completed.
            if (platform === "youtube" || platform === "twitter") {
                if (!this.sessions) continue;
                let profile: AccountProfile | undefined;
                try {
                    profile = await readAccountProfile(
                        this.sessions,
                        platform,
                        AbortSignal.timeout(platform === "youtube" ? 60_000 : 35_000),
                    );
                } catch {
                    /* Chrome may still be completing an OAuth/passkey handoff. */
                }
                if (profile?.state === "authenticated") {
                    for (const job of this.state.jobs)
                        if (job.status === "waiting-auth" && job.context.bindingScope === this.scope && loginFor(job.context.sourceUrl, this.settings.webDomains) === platform) {
                            job.status = "queued";
                            job.message = `${LOCAL_PLATFORM_LABELS[platform]} 浏览器登录已确认，自动重试`;
                            changed = true;
                        }
                    this.authNotified.delete(platform);
                } else void this.promptLogin(platform);
                continue;
            }
            let profile: AccountProfile | undefined;
            try { profile = await readAccountProfile(this.sessions, platform, AbortSignal.timeout(35_000)); }
            catch { /* Fall through to the visible login window. */ }
            if (profile?.state === "authenticated") {
                for (const job of this.state.jobs)
                    if (job.status === "waiting-auth" && job.context.bindingScope === this.scope && loginFor(job.context.sourceUrl, this.settings.webDomains) === platform) {
                        job.status = "queued";
                        job.message = `${LOCAL_PLATFORM_LABELS[platform as keyof typeof LOCAL_PLATFORM_LABELS] || platform} 登录态已从本机浏览器确认，自动重试`;
                        changed = true;
                    }
                this.authNotified.delete(platform);
            } else void this.promptLogin(platform);
        }
        if (changed) { this.persist(); this.drain(); }
    }
    private async autoRetryProtectedPlatformJobs(): Promise<void> {
        if (!this.alive || !this.manuallyEnabled || !this.bridge || !this.scope)
            return;
        const retryable = new Set(["failed", "waiting-auth", "cancelled"]);
        for (const platform of ["douyin", "xiaohongshu"] as const) {
            const jobs = this.state.jobs.filter(
                (job) => job.context.bindingScope === this.scope &&
                    platformFor(job.context.sourceUrl) === platform &&
                    retryable.has(job.status) && !this.autoRetriedJobs.has(job.key),
            );
            if (!jobs.length) continue;
            let profile: AccountProfile;
            try {
                if (platform === "douyin") {
                    const cookies = await this.sessions.authorizedCookies(platform);
                    const hasSessionCookie = cookies.some(cookie =>
                        ["sessionid", "sessionid_ss"].includes(cookie.name) && !!cookie.value &&
                        (!cookie.expirationDate || cookie.expirationDate > Date.now() / 1000));
                    profile = hasSessionCookie
                        ? { state: "authenticated", nickname: "抖音账号", sessionOnly: true }
                        : await readAccountProfile(this.sessions, platform, AbortSignal.timeout(15000));
                } else {
                    profile = await readAccountProfile(this.sessions, platform, AbortSignal.timeout(15000));
                }
            } catch { continue; }
            if (profile.state !== "authenticated" &&
                !(profile.state === "unknown" && this.sessions.hasStoredAuthorization(platform))) continue;
            for (const job of jobs) {
            this.autoRetriedJobs.add(job.key);
            job.status = "queued";
            job.message = `${LOCAL_PLATFORM_LABELS[platform]}登录已确认，自动重试`;
            this.logger?.log("queue.auto_retry", {
                taskId: job.context.taskId,
                feature: job.feature,
                attempt: job.attempts + 1,
            });
            }
        }
        if (!this.autoRetriedJobs.size) return;
        this.persist();
        this.drain();
    }
    /** Requeue jobs whose source adapter was repaired while the task was paused. */
    private async autoRetryKnownSourceJobs(): Promise<void> {
        if (!this.alive || !this.manuallyEnabled || !this.bridge || !this.scope) return;
        const retryable = new Set(["failed", "cancelled"]);
        const jobs = this.state.jobs.filter(job =>
            job.context.bindingScope === this.scope &&
            (isBilibiliOpusSource(job.context.sourceUrl) || isKnownNoLoginSource(job)) &&
            (retryable.has(job.status) || (isKnownNoLoginSource(job) && job.status === "waiting-auth")) &&
            !this.autoRetriedJobs.has(job.key),
        );
        if (!jobs.length) return;
        for (const job of jobs) {
            this.autoRetriedJobs.add(job.key);
            job.status = "queued";
            job.retryCount = 0;
            delete job.nextAttemptAt;
            delete job.lastError;
            const platform = platformFor(job.context.sourceUrl);
            const label = LOCAL_PLATFORM_LABELS[platform] || platform;
            job.message = `${label} 适配已修复，自动重试`;
            this.logger?.log("queue.auto_retry", {
                taskId: job.context.taskId,
                feature: job.feature,
                attempt: job.attempts + 1,
            });
        }
        this.persist();
        this.drain();
    }
    /** Move persisted authorization failures into the explicit paused state. */
    private async pauseFailedAuthorizationJobs(): Promise<void> {
        if (!this.alive || !this.manuallyEnabled || !this.bridge || !this.scope) return;
        const jobs = this.state.jobs.filter(job =>
            job.context.bindingScope === this.scope &&
            job.status === "failed" &&
            /登录|授权|访问验证|登录态/.test(`${job.message} ${job.lastError || ""}`),
        );
        const staleComments = this.state.jobs.filter(job =>
            job.context.bindingScope === this.scope &&
            job.status === "waiting-auth" &&
            job.feature === "comments" &&
            /未取得可核验的评论|没有一级评论|评论接口未返回|未返回可核验/.test(`${job.message} ${job.lastError || ""}`),
        );
        for (const job of staleComments) {
            job.status = "queued";
            job.retryCount = 0;
            delete job.nextAttemptAt;
            job.message = "评论未返回可核验内容，重新执行一次";
        }
        if (!jobs.length && !staleComments.length) return;
        for (const job of jobs) {
            job.status = "waiting-auth";
            job.message = "需要原站登录或访问验证，已暂停等待授权";
            delete job.nextAttemptAt;
        }
        this.persist();
        this.drain();
        void this.promptWaitingAuthJobs();
    }
    private async promptLogin(platform: LoginPlatform): Promise<void> {
        if (!this.alive || !this.manuallyEnabled || this.loginPrompts.has(platform)) return;
        this.loginPrompts.add(platform);
        try {
            const waiting = this.state?.jobs?.find(job => {
                if (job.status !== "waiting-auth" || job.context.bindingScope !== this.scope) return false;
                try { return loginFor(job.context.sourceUrl, this.settings?.webDomains || []) === platform; }
                catch { return false; }
            });
            // Only ordinary WeChat articles need the source page as their login
            // document. Dedicated account applications must keep their own
            // login routes; opening a protected content URL can return JSON or
            // start the wrong consumer/broadcaster flow.
            const targetUrl = platform === "wechat" ? waiting?.context.sourceUrl : undefined;
            const login = await this.login(platform, targetUrl);
            if (login === false)
                this.disableQueuedPlatform(platform);
        } finally {
            this.loginPrompts.delete(platform);
        }
    }
    private disableQueuedPlatform(platform: LoginPlatform): void {
        const platformName = (platform.startsWith("web:") ? "web" : platform) as PlatformName;
        this.settings.platformEnabled[platformName] = false;
        for (const view of this.profileViews) view.expired(platform);
        for (const job of this.state.jobs) {
            if (job.context.bindingScope !== this.scope || !["queued", "waiting-auth", "running"].includes(job.status)) continue;
            try {
                if (loginFor(job.context.sourceUrl, this.settings.webDomains) === platform) {
                    if (job.status === "running") this.active?.abort();
                    job.status = "cancelled";
                    job.message = "登录未完成，平台已关闭";
                    delete job.nextAttemptAt;
                }
            } catch { /* Ignore stale source identities. */ }
        }
        void this.savePreferences().catch(() => undefined);
        this.persist();
    }
    /** Backward-compatible test and extension hook retained for older runtimes. */
    private async autoRetryDouyinJobs(): Promise<void> {
        await this.autoRetryProtectedPlatformJobs();
    }
    private async onTaskSaved(context: TaskContext): Promise<void> {
        if (!this.alive || !this.bridge || !this.manuallyEnabled)
            return;
        if (this.scope !== context.bindingScope) {
            this.generation++;
            this.active?.abort();
            this.scope = context.bindingScope;
            await this.sessions.setScope(this.scope);
        }
        const platform = platformFor(context.sourceUrl);
        if (!this.settings.platformEnabled[platform]) return;
        for (const feature of FEATURES)
            if (this.settings.platforms[platform][feature] &&
                supportsFeature(platform, feature))
                enqueue(this.state, context, feature);
        this.persist();
        this.drain();
    }
    private drain(): void {
        if (!this.alive ||
            !this.manuallyEnabled ||
            this.active !== null ||
            this.templateWork !== null ||
            !this.bridge ||
            !this.scope ||
            this.running ||
            this.configurationCleared ||
            this.updatePaused ||
            this.bridge.updatePaused?.())
            return;
        if (this.queuePaused) return;
        const now = Date.now();
        const next = this.state.jobs
            .filter(j => j.status === 'queued' && j.context.bindingScope === this.scope && (j.nextAttemptAt || 0) > now)
            .sort((a, b) => (a.nextAttemptAt || 0) - (b.nextAttemptAt || 0))[0];
        if (next) {
            if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
            this.retryTimer = window.setTimeout(() => { this.retryTimer = null; this.drain(); }, Math.max(250, (next.nextAttemptAt || now) - now));
            return;
        }
        this.running = this.runQueue()
            .catch(() => this.updateStatus("本地素材处理暂停，请检查队列状态"))
            .finally(() => {
            this.running = null;
            if (this.alive &&
                !this.updatePaused &&
                !this.bridge?.updatePaused?.() &&
                this.bridge &&
                this.state.jobs.some((j) => j.status === "queued" && j.context.bindingScope === this.scope))
                this.drain();
        });
    }
    private async runQueue(): Promise<void> {
        const generation = this.generation;
        while (this.alive &&
            this.manuallyEnabled &&
            this.bridge &&
            generation === this.generation &&
            !this.updatePaused &&
            !this.bridge.updatePaused?.()) {
            const job = this.state.jobs.find((j) => j.status === "queued" && j.context.bindingScope === this.scope && (!j.nextAttemptAt || j.nextAttemptAt <= Date.now()));
            if (!job)
                return;
            const operation = crypto.randomUUID();
            const controller = new AbortController();
            this.active = controller;
            const timeout = window.setTimeout(() => controller.abort(new Error("本地素材任务超过时间上限")), this.settings.timeoutMinutes * 60000);
            let failure: unknown;
            try {
                const context = await this.bridge.resolveTask(job.context.taskId);
                if (!context ||
                    context.bindingScope !== job.context.bindingScope ||
                    context.sourceUrl !== job.context.sourceUrl) {
                    job.status = "cancelled";
                    job.message = "绑定或来源变化，已停止旧任务";
                    this.persist();
                    continue;
                }
                const previousContentVersion = job.context.contentVersion;
                // The cloud may publish a newer note-content version while a
                // local feature is queued. The source identity is unchanged,
                // and completed assets remain valid for the same task. Keep
                // the job's cloud revision aligned so later checks and local
                // property application target the current note.
                job.context = context;
                this.logger?.log("queue.started", { taskId: job.context.taskId, feature: job.feature }, "info", operation);
                job.status = "running";
                job.attempts++;
                job.message = "正在处理";
                this.persist();
                let saved = job.saved;
                if (saved) {
                    for (const reference of saved.assets)
                        await this.store.localFile(reference);
                    const checked = await this.store.manifest(saved.files.map((f) => f.path), controller.signal);
                    if (JSON.stringify(checked) !== JSON.stringify(saved.files))
                        throw new Error("已保存素材被修改或损坏，已保留原文件，未自动覆盖");
                }
                else {
                    await this.requirePlatformLogin(context.sourceUrl,controller.signal);
                    if(job.feature==="subtitles" && this.settings.whisper)await this.assertASRReady();
                    // Reuse material produced by an earlier feature in the same task.
                    // The property cache intentionally contains only frontmatter values,
                    // while the completed job keeps the authoritative asset references.
                    // This is especially important for subtitles: once video is saved,
                    // transcription must work from that local file even when the source
                    // page is behind a challenge or has an inaccurate duration.
                    // Across cloud revisions, only Douyin image assets are safe to
                    // reuse for video detection: a graphic post may be published
                    // first and then receive a new note revision. Reusing an older
                    // video or transcript for another feature could silently attach
                    // material from a different content revision.
                    const canReuseAsset = (file: string, version: string) =>
                        version === context.contentVersion ||
                        (job.feature === "video" &&
                            platformFor(context.sourceUrl) === "douyin" &&
                            /\.(?:png|jpe?g|webp|gif|svg|bmp|avif)$/i.test(file));
                    const completedAssets = this.state.jobs
                        .filter((candidate) => candidate !== job &&
                            candidate.status === "complete" &&
                            candidate.context.bindingScope === context.bindingScope &&
                            candidate.context.taskId === context.taskId &&
                            candidate.context.sourceUrl === context.sourceUrl)
                        .flatMap((candidate) => (candidate.saved?.assets || [])
                            .filter((file) => canReuseAsset(file, candidate.context.contentVersion)));
                    const priorAssets = [...new Set(completedAssets)];
                    const cachedAssets = Array.isArray(this.state.properties[taskKey(context)]?.assets)
                        ? (this.state.properties[taskKey(context)].assets as string[])
                            .filter((file) =>
                                canReuseAsset(file, previousContentVersion))
                        : [];
                    const result = await collect(context, job.feature, this.settings, this.sessions, this.store, controller.signal, (message) => this.updateStatus(`${labels[job.feature]} · ${message}`), [...new Set([...priorAssets, ...cachedAssets])]);
                    controller.signal.throwIfAborted();
                    if (generation !== this.generation || !this.bridge)
                        throw new Error("主插件绑定已变化");
                    const latest = await this.bridge.resolveTask(context.taskId);
                    if (!latest ||
                        latest.bindingScope !== context.bindingScope ||
                        latest.sourceUrl !== context.sourceUrl)
                        throw new Error("笔记身份变化，未关联旧素材");
                    const previous = this.state.properties[taskKey(context)] || {};
                    job.context = latest;
                    const supplement = await this.store.supplement(latest, job.feature, result.body, result.properties, previous, job.replaceUserValues === true);
                    const assets = [...result.assets, supplement];
                    saved = {
                        properties: result.properties,
                        assets,
                        files: await this.store.manifest(result.assets, controller.signal),
                    };
                    job.saved = saved;
                    this.persist();
                }
                controller.signal.throwIfAborted();
                if (generation !== this.generation || !this.bridge)
                    throw new Error("主插件绑定已变化");
                const latest = await this.bridge.resolveTask(context.taskId);
                if (!latest ||
                    latest.bindingScope !== context.bindingScope ||
                    latest.sourceUrl !== context.sourceUrl)
                    throw new Error("笔记身份变化，未关联旧素材");
                job.context = latest;
                const key = taskKey(latest), previous = this.state.properties[key] || {};
                const assets = [
                    ...new Set([
                        ...(Array.isArray(previous.assets) ? previous.assets : []),
                        ...saved.assets,
                    ]),
                ];
                const mediaAssets = assets.filter((file) => /\.(?:mp4|m4v|mkv|webm|mov|ogv|mpeg|mpg|mp3|m4a|wav|ogg|oga|flac|opus|aac|3gp|m3u8|ts|flv)$/i.test(file));
                const imageAssets = assets.filter((file) => /\.(?:png|jpe?g|webp|gif|svg|bmp|avif)$/i.test(file));
                const incoming: LocalProperties = {
                    ...previous,
                    ...saved.properties,
                    assets,
                };
                const applied = await this.bridge.applyMetadata({
                    context: latest,
                    properties: latest.daily ? { assets } : incoming,
                    previous,
                    localValues: {
                        local_assets: assets,
                        local_media: mediaAssets,
                        local_cover: imageAssets[0] || "",
                        local_gallery: imageAssets,
                    },
                    replaceUserValues: job.replaceUserValues === true,
                });
                if (applied.status === "applied") {
                    this.state.properties[key] = {
                        ...previous,
                        ...Object.fromEntries(Object.entries(incoming).filter(([k]) => !applied.preserved.includes(k as never))),
                    };
                    job.status = "complete";
                    job.replaceUserValues = false;
                    job.message = applied.preserved.length
                        ? "已保存；保留用户修改的属性"
                        : "素材与关联已保存";
                }
                else {
                    job.status = "waiting-write";
                    job.message =
                        applied.status === "deferred"
                            ? "素材已保存，等待旧版同步回执完成后重试关联"
                            : "素材已保存，笔记版本变化，等待重新选择";
                }
            }
            catch (error) {
                failure = error;
                const retryCount = job.retryCount || 0;
                const commentNeedsAuthorization = job.feature === "comments" &&
                    commentsNeedAuthorization(error);
                const hardFailure = controller.signal.aborted || error instanceof LocalMediaNoAudio || error instanceof AuthorizationRequired || commentNeedsAuthorization;
                const canRetry = !hardFailure && retryCount < 3;
                job.status = controller.signal.aborted
                    ? "cancelled"
                    : error instanceof LocalMediaNoAudio
                        ? "cancelled"
                    : error instanceof AuthorizationRequired || commentNeedsAuthorization
                        ? "waiting-auth"
                        : canRetry ? "queued" : "failed";
                if (canRetry) {
                    job.retryCount = retryCount + 1;
                    job.nextAttemptAt = Date.now() + (2 ** retryCount) * 60_000;
                } else delete job.nextAttemptAt;
                job.lastError = error instanceof Error ? error.message.slice(0, 200) : "素材处理失败";
                job.message = controller.signal.aborted
                    ? "已停止，可手动重试"
                    : error instanceof LocalMediaNoAudio
                        ? error.message
                    : error instanceof Error
                        ? canRetry ? `处理失败，将在 ${2 ** retryCount} 分钟后自动重试` : error.message.slice(0, 200)
                        : "素材处理失败";
                const platform = loginFor(job.context.sourceUrl,this.settings.webDomains);
                if (job.status === "waiting-auth")for(const view of this.profileViews)view.expired(platform);
                if (job.status === "waiting-auth" && (platform === "youtube" || platform === "twitter")) {
                    void this.promptWaitingAuthJobs();
                }
                const suppressPrompt = (this.authRetrySuppressedUntil.get(platform) || 0) > Date.now();
                if (job.status === "waiting-auth" && !this.authNotified.has(platform) && !suppressPrompt) {
                    this.authNotified.add(platform);
                    new Notice(`${platform.startsWith('web:')?platform.slice(4):LOCAL_PLATFORM_LABELS[platform as keyof typeof LOCAL_PLATFORM_LABELS]} 需要原站授权。已打开登录窗口，完成后会自动恢复任务。`, 10000);
                    // Keep the failed job paused while the user completes the
                    // source login. A single shared window handles all jobs
                    // for this platform and saving the session requeues them.
                    void this.promptLogin(platform);
                }
                // Diagnostics never include source URLs, CLI arguments, cookies or raw platform responses.
            }
            finally {
                this.logger?.log("queue.finished", {
                    taskId: job.context.taskId,
                    feature: job.feature,
                    status: job.status,
                    message: job.message
                        .replace(/https?:\/\/\S+/gi, "[url]")
                        .replace(/(?:\/Users\/|[A-Za-z]:[\\/])\S+/g, "[path]")
                        .slice(0, 240),
                    reason: job.status === "failed" || job.status === "waiting-auth"
                        ? localFailureReason(failure)
                        : undefined,
                }, job.status === "failed" ? "error" : "info", operation);
                window.clearTimeout(timeout);
                if (this.active === controller)
                    this.active = null;
                this.persist();
                this.updateStatus(`${labels[job.feature]} · ${job.message}`);
            }
        }
    }
    private openFavoriteImport(platform?: FavoritePlatform): void {
        if (!this.manuallyEnabled || !this.bridge?.submitFavoriteLinks || !this.scope) {
            new Notice('请开启本地剪藏并更新主插件后使用收藏导入');
            return;
        }
        if (this.favoriteModal?.isActive()) return;
        const scope = this.scope, bridge = this.bridge;
        this.favoriteModal = new FavoriteImportModal(this.app, {
            scope,
            sessions: this.sessions,
            available: platform => this.alive && this.manuallyEnabled && this.scope === scope && this.bridge === bridge
                && this.settings.platformEnabled[platform] && !this.updatePaused && !bridge.updatePaused?.(),
            authorize: (platform, signal) => this.requirePlatformLogin(`https://www.${platform === 'bilibili' ? 'bilibili.com' : platform === 'douyin' ? 'douyin.com' : 'xiaohongshu.com'}/`, signal),
            submit: request => bridge.submitFavoriteLinks!(request),
        }, platform);
        this.favoriteModal.open();
    }
    private async chooseTask(): Promise<void> {
        if (!this.bridge || !this.manuallyEnabled) {
            new Notice("请先启用 Clip2MD 主插件");
            return;
        }
        const tasks = await this.bridge.listTasks();
        if (!tasks.length) {
            new Notice("没有可关联的剪藏笔记，请先同步");
            return;
        }
        new TaskPicker(this.app, tasks, (context) => new FeaturePicker(this.app, context, (feature) => {
            enqueue(this.state, context, feature, true);
            this.persist();
            this.drain();
        }).open()).open();
    }
    private async confirmRefresh(): Promise<void> {
        const tasks = await this.bridge?.listTasks();
        if (!tasks?.length) {
            new Notice("请先同步一篇笔记");
            return;
        }
        new TaskPicker(this.app, tasks, (context) => {
            const modal = new Modal(this.app);
            modal.titleEl.setText("替换本地来源属性");
            modal.contentEl.createEl("p", {
                text: "这将重新读取来源属性，并替换您修改过的来源属性值（以主插件笔记属性模板为准）。云端属性与正文不受影响。",
            });
            new Setting(modal.contentEl).addButton((b) => b.setButtonText("确认刷新并替换").onClick(() => {
                enqueue(this.state, context, "metadata", true);
                const job = this.state.jobs.find((j) => j.context.bindingScope === context.bindingScope &&
                    j.context.taskId === context.taskId &&
                    j.feature === "metadata");
                if (job && job.status !== "running") {
                    job.replaceUserValues = true;
                    delete job.saved;
                    this.persist();
                    this.drain();
                }
                modal.close();
            }));
            modal.open();
        }).open();
    }
    private async login(platform: LoginPlatform, targetUrl?: string): Promise<AccountProfile | false> {
        if (!this.bridge || !this.manuallyEnabled || !this.scope || this.updatePaused || this.bridge.updatePaused?.()) {
            new Notice("请先启用并绑定主插件，或等待更新完成");
            return false;
        }
        const diagnosticPlatform=platform.startsWith("web:")?"web":platform;
        this.logger?.log("auth.requested", { platform:diagnosticPlatform });
        let observer: LoginObserver | undefined;
        try {
            const expectedScope = this.scope;
            const win = await this.sessions.login(platform, async window => {
                try {
                    // A login handoff can be requested after a source page is
                    // blocked by a CAPTCHA/access challenge. In that case the
                    // isolated session already contains the previously saved
                    // Cookie, so the first self-profile response is only the
                    // old session being replayed. Treating it as a fresh login
                    // closes the window immediately and starts the same prompt
                    // again. Require an explicit save when an authorization is
                    // already stored; this also gives the user time to finish
                    // the challenge in the native window.
                    if (this.shouldAutoObserveLogin(platform))
                        observer = await observeLogin(window, platform);
                }
                catch { this.logger?.log('auth.observe.unavailable', { platform:diagnosticPlatform }, 'warn'); }
            }, targetUrl);
            this.logger?.log('auth.window.ready', { platform:diagnosticPlatform });
            const modal = new Modal(this.app);
            const autoObserve = this.shouldAutoObserveLogin(platform);
            // A stored Cookie is restored into the isolated partition before
            // the challenge page opens. Require a changed stable auth Cookie
            // before treating the window as freshly authorized; otherwise the
            // old session closes it before the user can complete verification.
            const previousFingerprint = this.sessions.hasStoredAuthorization(platform)
                ? await this.sessions.cookieAuthFingerprint(platform).catch(() => "")
                : "";
            modal.titleEl.setText(`${platform.startsWith('web:')?platform.slice(4):LOCAL_PLATFORM_LABELS[platform as keyof typeof LOCAL_PLATFORM_LABELS]}登录`);
            modal.contentEl.createEl("p", { text: observedAccount(platform)
                ? autoObserve
                    ? '请在原站首页点击登录，确认账号接口登录成功后自动保存。登录态仅保存在此设备，不上传云端。'
                    : '当前已保存本机登录态。请在原站完成访问验证或重新登录，确认可以访问目标内容后点击“检查并保存登录”；不会根据旧登录态自动关闭此窗口。登录态仅保存在此设备，不上传云端。'
                : platform === 'twitter' || platform === 'youtube'
                    ? `${platform === 'twitter' ? 'X' : 'YouTube'} 的 Google 登录可能拒绝内置浏览器。请在 Chrome 完成登录后回到这里点击“我已登录，保存登录态”；插件会读取本机 Chrome 的登录 Cookie，仅保存在此设备。`
                : ['csdn', 'zhihu', 'douban', 'weibo'].includes(platform)
                    ? '请在原站窗口完成登录。检测到有效登录 Cookie 后会自动保存并关闭窗口；如果原站没有返回可验证状态，也可以点击“我已登录，保存登录态”。登录态仅保存在此设备，不上传云端。'
                    : '请在原站窗口完成登录并确认可以访问目标内容，再点击“我已登录，保存登录态”。本站按域名保存 Cookie 与本地存储，不将普通访客状态自动判定为登录。登录态仅保存在此设备，不上传云端.'  });
            return await new Promise<AccountProfile | false>(resolve => {
                const controller = new AbortController();
                let saved: LoggedInProfile | false = false, saving = false, closed = false;
                let cookieTimer: number | undefined;
                let cookieCheck = 0;
                const save = async (detected?: LoggedInProfile) => {
                    if (saving || saved || closed) return;
                    saving = true;
                    try {
                        if (!this.alive || !this.manuallyEnabled || this.scope !== expectedScope) throw new Error('主插件绑定或启用状态已变化，请重新授权');
                        if (platform === 'twitter' || platform === 'youtube') await this.sessions.authorizedCookies(platform, controller.signal);
                        // Only a stable first-party login cookie or the user's
                        // explicit generic-site confirmation may authorize a
                        // non-observed platform. This is also the path used by
                        // Weibo's SUB/SUBP polling, so waiting jobs can resume.
                        if(!observedAccount(platform)) {
                            const confirmed = !!detected || platform === 'lizhi' || platform.startsWith('web:');
                            await this.sessions.save(platform, controller.signal, win, confirmed);
                        }
                        // Cookie polling has already confirmed a stable
                        // first-party authorization and sessions.save has
                        // persisted it. Opening another hidden profile page
                        // before closing this login window can hang on sites
                        // that use a hydrated account header (notably Weibo).
                        // The generic nickname is intentionally sufficient;
                        // authorization state is determined by the verified
                        // Cookie, not by a best-effort page nickname.
                        const profile = await assertPersistedCookieLogin(
                            detected,
                            () => readAccountProfile(this.sessions, platform, controller.signal),
                        );
                        controller.signal.throwIfAborted();
                        if (profile.state !== 'authenticated') throw new Error('尚未确认原站登录，请在首页完成登录后重试');
                        if (this.scope !== expectedScope) throw new Error('主插件绑定已变化，请重新授权');
                        if(observedAccount(platform) || platform === 'lizhi')await this.sessions.save(
                            platform,
                            controller.signal,
                            win,
                            false,
                            profile,
                        );
                        controller.signal.throwIfAborted();
                        if (this.scope !== expectedScope) return;
                        this.authNotified.delete(platform);
                        this.authRetrySuppressedUntil.set(platform, Date.now() + 120_000);
                        for (const job of this.state.jobs)
                            if (job.status === "waiting-auth" && job.context.bindingScope === this.scope && loginFor(job.context.sourceUrl,this.settings.webDomains) === platform) job.status = "queued";
                        this.persist(); saved = profile;
                        this.logger?.log('auth.saved', { platform:diagnosticPlatform, source: detected ? 'network' : 'manual-check' });
                        modal.close(); this.drain();
                    } catch (error) {
                        if (!controller.signal.aborted && !closed) {
                            this.logger?.log('auth.save.failed', { platform:diagnosticPlatform }, 'warn');
                            new Notice(error instanceof Error ? error.message : '授权保存失败，请检查原站登录状态');
                        }
                    } finally { saving = false; }
                };
                new Setting(modal.contentEl).addButton(button => button.setButtonText(observedAccount(platform)?'检查并保存登录':'我已登录，保存登录态').onClick(() => { void save(); }));
                const windowClosed = () => modal.close();
                win.on('closed', windowClosed);
                modal.onClose = () => {
                    closed = true; controller.abort(); observer?.dispose();
                    if (cookieTimer) window.clearInterval(cookieTimer);
                    win.removeListener?.('closed', windowClosed); this.sessions.release(win);
                    if (!saved) this.logger?.log('auth.cancelled', { platform:diagnosticPlatform });
                    resolve(saved);
                };
                modal.open(); win.show?.(); win.focus?.();
                if (observer) void observer.profile.then(profile => { if (profile && !closed) return save(profile); });
                if (['csdn', 'douban', 'weibo', 'toutiao', 'youtube', 'twitter', 'kuaishou', 'xiaoyuzhou', 'lizhi', 'applepodcasts', 'wechat-channel'].includes(platform)) {
                    const checkCookies = async () => {
                        const current = ++cookieCheck;
                        try {
                            const profile = await this.sessions.cookieLoginProfile(platform, win);
                            const fingerprint = previousFingerprint
                                ? await this.sessions.cookieAuthFingerprint(platform).catch(() => "")
                                : "";
                            if (profile && current === cookieCheck && !closed &&
                                (!previousFingerprint || fingerprint !== previousFingerprint))
                                await save(profile);
                        } catch { /* Login may still be writing its cookies. */ }
                    };
                    void checkCookies();
                    cookieTimer = window.setInterval(() => { void checkCookies(); }, 800);
                }
            });
        } catch (error) {
            this.logger?.log('auth.window.failed', { platform:diagnosticPlatform, code: error instanceof LoginWindowError ? error.code : 'LOGIN_UNAVAILABLE' }, 'warn');
            new Notice(error instanceof Error ? error.message : "无法打开原站授权窗口");
            return false;
        } finally { observer?.dispose(); }
    }

    openSettings(): void {
        const modal = new Modal(this.app);
        modal.titleEl.setText("本地剪藏扩展");
        let cleanup: (() => void) | undefined;
        modal.onOpen=()=>{ cleanup=this.renderSettings(modal.contentEl); };
        modal.onClose=()=>cleanup?.();
        modal.open();
    }
    private renderProcessingLimits(container: HTMLElement): void {
        const limits = [
            { key: 'asrTimeoutMinutes', name: '单任务转写上限（分钟）', max: 240, scale: 1 },
            { key: 'commentLimit', name: '一级评论数量上限（1–1000）', max: 1000, scale: 1 },
            { key: 'maxBytes', name: '单任务下载上限（MiB）', max: 10240, scale: 1024 ** 2 },
            { key: 'timeoutMinutes', name: '单任务时间上限（分钟）', max: 120, scale: 1 },
        ] as const;
        for (const { key, name, max, scale } of limits) {
            const help = `请输入 1–${max} 的整数；完成输入后保存。`;
            const row = new Setting(container).setName(name).setDesc(help);
            row.addText(text => {
                const input = text.inputEl;
                input.inputMode = 'numeric';
                text.setValue(String(this.settings[key] / scale));
                const valid = () => /^\d+$/.test(input.value.trim()) && Number.isSafeInteger(Number(input.value))
                    && Number(input.value) >= 1 && Number(input.value) <= max;
                text.onChange(() => {
                    input.setAttribute('aria-invalid', String(!valid()));
                    row.setDesc(valid() ? help : `未保存：请输入 1–${max} 的整数；仍使用 ${this.settings[key] / scale}。`);
                });
                const save = async () => {
                    if (input.disabled) return;
                    if (!valid()) {
                        row.setDesc(`未保存：请输入 1–${max} 的整数；仍使用 ${this.settings[key] / scale}。`);
                        text.setValue(String(this.settings[key] / scale));
                        input.setAttribute('aria-invalid', 'false');
                        return;
                    }
                    const previous = this.settings[key], next = Number(input.value) * scale;
                    text.setValue(String(next / scale));
                    input.setAttribute('aria-invalid', 'false');
                    if (next === previous) { row.setDesc(help); return; }
                    input.disabled = true;
                    this.settings[key] = next;
                    try { await this.savePreferences(); row.setDesc(help); }
                    catch {
                        this.settings[key] = previous;
                        text.setValue(String(previous / scale));
                        row.setDesc(`保存失败，请重试；仍使用 ${previous / scale}。`);
                    } finally { input.disabled = false; }
                };
                input.addEventListener('change', () => { void save(); });
                input.addEventListener('keydown', event => {
                    if (event.key === 'Enter') { event.preventDefault(); void save(); }
                });
            });
        }
    }
    private renderToolSetup(container: HTMLDetailsElement): () => void {
        const panel = container.createDiv({ cls: 'clip2md-settings-group-content' });
        panel.createEl('p', { text: BUILD_CHANNEL === 'website'
            ? '首次开启会自动准备 Whisper、FFmpeg、yt-dlp 和固定转写资源，保存在本机，不进入 Vault。'
            : '检查本机 Whisper、FFmpeg、yt-dlp 和固定转写资源，不自动安装依赖。', cls: 'setting-item-description' });
        const rows = new Map<ToolId, Setting>();
        for (const key of Object.keys(TOOL_LABELS) as ToolId[]) rows.set(key, new Setting(panel).setName(TOOL_LABELS[key]));
        const error = panel.createEl('p', { cls: 'clip2md-tool-setup-error', attr: { role: 'alert' } });
        const controls = new Setting(panel).setName('工具准备');
        const refresh = () => {
            for (const [key, row] of rows) {
                const state = this.toolStatus[key];
                const phase = { pending: '待准备', downloading: '下载中', installing: '安装中', checking: '检查中', ready: '已就绪', failed: '未完成' }[state.phase];
                row.setDesc(`${phase} · ${state.message}`);
            }
            error.setText(this.setupError ? `${this.setupError}。建议使用 Agent 进行安装和修复，完成后返回重试。` : '');
            if (this.setupError) container.open = true;
            refreshButton();
        };
        let refreshButton = () => {};
        controls.addButton(button => {
            button.onClick(() => { void this.prepareTools(); });
            refreshButton = () => { button.setButtonText(this.toolSetup ? '准备中…' : this.asrReady ? '重新检查' : BUILD_CHANNEL === 'website' ? '重试安装与检查' : '重试检查')
                .setDisabled(!!this.toolSetup || !this.manuallyEnabled || !this.bridge || this.updatePaused); };
        }).addButton(button => button.setButtonText('复制 Agent 修复说明').onClick(() => {
            void navigator.clipboard.writeText(agentRepairInstructions(toolsRoot())).then(() => new Notice('已复制修复说明，请交给 Agent 执行')).catch(() => new Notice('复制失败，请使用设置中的反馈与诊断入口'));
        }));
        this.setupViews.add(refresh);
        refresh();
        return () => this.setupViews.delete(refresh);
    }
    renderSettings(container: HTMLElement, standalone = true): () => void {
        const scroll = container.scrollTop;
        const activeElement = container.contains(document.activeElement) ? document.activeElement : null;
        const focused = activeElement?.getAttribute('data-control');
        const selection = activeElement instanceof HTMLInputElement ? [activeElement.selectionStart, activeElement.selectionEnd, activeElement.selectionDirection] as const : null;
        const previousOpen = new Map(Array.from(container.querySelectorAll<HTMLDetailsElement>('details[data-disclosure]')).map(el => [el.dataset.disclosure || '', el.open]));
        const hadDisclosures = previousOpen.size > 0;
        this.settingsViews.get(container)?.();
        if (standalone)
            container.empty();
        else for (const child of Array.from(container.children)) if (child.hasAttribute('data-desktop-runtime')) child.remove();
        container.classList.add('clip2md-desktop-settings');
        const runtimeRoot = container.createDiv({ cls: 'clip2md-desktop-runtime', attr: { 'data-desktop-runtime': '' } });
        const disclosure = (name: string, label: string, initial = false) => {
            const details = runtimeRoot.createEl('details', { cls: 'clip2md-settings-group', attr: { 'data-disclosure': name } });
            details.open = hadDisclosures ? previousOpen.get(name) === true : initial;
            details.createEl('summary', { text: label });
            return details;
        };
        const restoreView = () => {
            if (focused) {
                const target = Array.from(container.querySelectorAll<HTMLElement>('[data-control]')).find(el => el.dataset.control === focused);
                target?.focus({ preventScroll: true });
                if (target instanceof HTMLInputElement && selection && selection[0] !== null && selection[1] !== null)
                    target.setSelectionRange(selection[0], selection[1], selection[2] || undefined);
            }
            container.scrollTop = scroll;
        };
        let accountCleanup: (() => void) | undefined;
        if (standalone) {
            const accountBar = runtimeRoot.createDiv({ cls: 'clip2md-desktop-account-bar' });
            if (this.bridge?.renderCloudAccount) {
                accountCleanup = this.bridge.renderCloudAccount(accountBar);
            } else {
                accountBar.createEl("p",{text:this.bridge?"Clip2MD 当前账号：请更新主插件以显示登录昵称":"Clip2MD 当前账号：请先安装并启用主插件",cls:"clip2md-desktop-account"});
            }
            const help = accountBar.createDiv({ cls: 'clip2md-desktop-help-actions' });
            help.createEl('a', { text: '打开 Clip2MD 使用说明', href: CLIP2MD_USAGE_DOC_URL });
            help.createEl('button', { text: '复制给 AI Agent' }).addEventListener('click', () => {
                void navigator.clipboard?.writeText(`请先阅读 Clip2MD 产品使用说明，再根据说明回答我的问题：\n${CLIP2MD_USAGE_DOC_URL}`)
                    .then(() => new Notice('Clip2MD: AI Agent 使用说明链接已复制。', 3000))
                    .catch(() => new Notice(`Clip2MD 使用说明：${CLIP2MD_USAGE_DOC_URL}`, 6000));
            });
        }
        if (standalone)
            new Setting(runtimeRoot).setName("启用本地剪藏扩展").setDesc('首次开启会准备本地工具；关闭后停止任务，保留配置和素材。').addToggle(t => t.setValue(this.manuallyEnabled).onChange(async (enabled) => {
                if (!this.bridge?.setDesktopEnabled) {
                    new Notice("请先安装并启用兼容的主插件");
                    this.renderSettings(container);
                    return;
                }
                await this.bridge.setDesktopEnabled(enabled);
                this.renderSettings(container);
            })).settingEl.classList.add('clip2md-desktop-primary-setting');
        const restoreDisabled = () => { restoreView(); if (this.settingsViews.get(container) === cleanup) this.settingsViews.delete(container); };
        const cleanup = () => { accountCleanup?.(); if (this.settingsViews.get(container) === cleanup) this.settingsViews.delete(container); };
        this.settingsViews.set(container, cleanup);
        if (!this.manuallyEnabled) {
            const overview = runtimeRoot.createDiv({ cls: 'clip2md-desktop-overview clip2md-desktop-disabled-overview' });
            overview.createEl('strong', { text: '本地剪藏未开启' });
            overview.createEl('p', { text: '开启后按平台配置补充正文、媒体、评论和字幕。首次使用需准备本地工具。' });
            restoreDisabled();
            return cleanup;
        }
        const runtimeStatus = runtimeRoot.createDiv({ cls: "clip2md-desktop-overview" });
        runtimeStatus.createEl("strong", { text: this.manuallyEnabled ? "本地剪藏已开启" : "本地剪藏未开启" });
        runtimeStatus.createSpan({ text: this.bridge ? '主插件已连接' : '等待主插件连接', cls: 'setting-item-description' });
        const toolsSection = disclosure('tools-group', '工具准备', !!this.setupError);
        const toolsCleanup = this.renderToolSetup(toolsSection);
        if (!this.bridge || !this.scope)
            new Setting(runtimeRoot)
                .setName("等待主插件连接")
                .setDesc("素材采集与原站登录已暂停；配置和诊断仍可使用。")
                .addButton((b) => b.setButtonText("安装或启用主插件").onClick(() => {
                void this.dependencyGuide();
            }));
        const status = runtimeStatus.createEl("p", {
            cls: "clip2md-desktop-status",
            text: this.status,
        });
        this.statusElements.add(status);
        const saveSection = disclosure('save', '保存与处理');
        const materialSetting = new Setting(saveSection).setName('资料存放目录')
            .setDesc('留空跟随主笔记目录；资料保存至“目录/_local/剪藏ID”，已有资料不移动。');
        let materialInput: HTMLInputElement | undefined;
        materialSetting.addText(text => {
            materialInput = text.inputEl;
            text.setPlaceholder('默认：主笔记目录/_local').setValue(this.settings.materialFolder).onChange(async value=>{
                if(!validMaterialFolder(value)){new Notice('请填写知识库内相对目录，不能包含 .. 或系统绝对路径');return;}
                const before=this.settings.materialFolder;
                this.settings.materialFolder=value.trim().replace(/\\/g,'/');
                try{await this.savePreferences();}
                catch{this.settings.materialFolder=before;text.setValue(before);new Notice('资料目录保存失败，请重试');}
            });
        });
        materialSetting.addExtraButton(button => button.setIcon('folder').setTooltip('选择资料存放目录').onClick(() => {
            new FolderPickerModal(this.app, this.settings.materialFolder === '/' ? '' : this.settings.materialFolder, folder => {
                const value = folder || '/';
                if (!validMaterialFolder(value)) return;
                const before = this.settings.materialFolder;
                this.settings.materialFolder = value;
                if (materialInput) materialInput.value = value;
                void this.savePreferences().catch(() => {
                    this.settings.materialFolder = before;
                    if (materialInput) materialInput.value = before;
                    new Notice('资料目录保存失败，请重试');
                });
            }).open();
        }));
        const platformDetails = disclosure('platforms', '平台与登录', true);
        platformDetails.classList.add('clip2md-platforms-group');
        const platformRoot=platformDetails.createDiv({ cls: 'clip2md-settings-group-content' });
        const platforms=new PlatformSettingsView(platformRoot,{
            settings:this.settings,
            available:()=>this.alive && this.manuallyEnabled && !!this.bridge && !!this.scope,
            scope:()=>this.scope,
            save:()=>this.savePreferences(),
            enableProperties:async()=>{await this.bridge?.enableSourceProperties?.();},
            platformChanged:(platform,enabled)=>{
                if(enabled)void this.enqueuePlatformArticles(platform);
                if(!enabled) {
                    for(const job of this.state.jobs)if(job.context.bindingScope===this.scope && platformFor(job.context.sourceUrl)===platform && ['queued','waiting-auth','running'].includes(job.status)) {
                        if(job.status==='running')this.active?.abort();
                        job.status='cancelled';job.message='该平台已关闭，配置与素材保留';
                    }
                    this.persist();
                }
            },
            login:platform=>this.login(platform),
            revoke:async platform=>{await this.sessions.revoke(platform);this.active?.abort();this.logger?.log("auth.revoked",{platform});},
            profile:(platform,signal)=>readAccountProfile(this.sessions,platform,signal),
            importFavorites: this.bridge?.submitFavoriteLinks ? platform => this.openFavoriteImport(platform) : undefined,
        });
        this.profileViews.add(platforms);
        platforms.render();
        const saveAdvanced = disclosure('limits', '处理上限');
        saveSection.appendChild(saveAdvanced);
        this.renderProcessingLimits(saveAdvanced);
        new Setting(saveSection).setName("已有笔记补充").setDesc('选择已同步笔记，补充本地资料。').addButton((b) => b.setButtonText("选择笔记").onClick(() => {
            void this.chooseTask();
        }));
        new Setting(saveSection).setName('从平台收藏导入').setDesc('全量读取 B站、小红书和抖音收藏；提交前检查额度，额度不足的部分不导入。').addButton(b => b.setButtonText('打开收藏导入').setDisabled(!this.bridge?.submitFavoriteLinks || !this.scope).onClick(() => this.openFavoriteImport()));
        const queueSection = disclosure('queue', '本地任务', true);
        const queueTools = queueSection.createDiv({ cls: 'clip2md-queue-tools' });
        const queueSummary = queueTools.createDiv({ cls: 'clip2md-queue-summary', attr: { role: 'status', 'aria-live': 'polite' } });
        const queue = queueSection.createDiv({ cls: "clip2md-material-queue" });
        const filter = queue.createEl('select', { attr: { 'aria-label': '任务筛选' } });
        filter.dataset.control = 'queue-filter';
        filter.createEl('option', { value: 'all', text: '全部任务' });
        filter.createEl('option', { value: 'cloud-failed', text: '云端失败' });
        filter.createEl('option', { value: 'failed', text: '本地失败' });
        filter.value = this.queueFilter;
        filter.addEventListener('change', () => { this.queueFilter = filter.value as typeof this.queueFilter; this.renderSettings(container); });
        const retryable = new Set(["failed", "waiting-write", "cancelled", "waiting-auth"]);
        const scopedJobs = this.state.jobs.filter((j) => j.context.bindingScope === this.scope);
        const jobs = scopedJobs
            .filter(j => this.queueFilter === 'all' || (this.queueFilter === 'cloud-failed' ? j.context.cloudStatus === 'failed' : j.status === 'failed'))
            .slice(-30).reverse();
        const counts = queueCounts(scopedJobs);
        const queueCountText = ([['进行中', counts['in-progress']], ['失败', counts.failed], ['成功', counts.complete]] as Array<[string, number]>)
            .filter(([, count]) => count > 0).map(([label, count]) => `${label} ${count}`).join(' · ');
        queueSummary.setText(queueCountText || '暂无任务');
        const groups: Array<[string, 'in-progress' | 'failed' | 'complete']> = [['进行中', 'in-progress'], ['失败', 'failed'], ['成功', 'complete']];
        for (const [label, bucket] of groups) {
            const matching = jobs.filter(job => queueBucket(job) === bucket);
            if (!matching.length) continue;
            const group = queue.createEl("details", { cls: "clip2md-queue-group", attr: { 'data-disclosure': `queue-${bucket}` } });
            group.open = hadDisclosures ? previousOpen.get(`queue-${bucket}`) === true : label !== "成功";
            group.createEl("summary", { text: `${label}（${matching.length}）` });
            for (const job of matching) {
                const row = group.createDiv({ cls: "clip2md-queue-item" });
                const title = job.context.noteTitle || job.context.sourceTitle || job.context.notePath.split('/').pop()?.replace(/\.md$/i, '') || `任务 #${job.context.taskId}`;
                const platform = LOCAL_PLATFORM_LABELS[platformFor(job.context.sourceUrl)] || platformFor(job.context.sourceUrl);
                const stateLabel = { queued: '排队中', running: '处理中', 'waiting-auth': '等待授权', 'waiting-write': '等待写入', failed: '失败', cancelled: '已停止', complete: '已完成' }[job.status];
                const cloud = job.context.cloudStatus === 'failed' ? ' · 云端失败' : '';
                new Setting(row).setName(title).setDesc(`任务 #${job.context.taskId} · ${platform} · ${labels[job.feature]} · ${stateLabel}${cloud}${job.retryCount ? ` · 重试 ${job.retryCount}/3` : ''}\n${job.lastError || job.message}`)
                    .addButton(button => { button.buttonEl.dataset.control = `retry-${job.key}`; return button.setButtonText("重试").setDisabled(!retryable.has(job.status)).onClick(() => {
                        job.status = "queued";
                        job.retryCount = 0;
                        delete job.nextAttemptAt;
                        delete job.lastError;
                        this.persist();
                        this.drain();
                        this.renderSettings(container);
                    }); });
            }
        }
        if (!jobs.length) {
            const empty = queue.createDiv({ cls: 'clip2md-empty-state', attr: { role: 'status' } });
            empty.createEl('strong', { text: scopedJobs.length ? '没有符合当前筛选的任务' : '尚无本地素材任务' });
            empty.createEl('p', { text: scopedJobs.length ? '切换筛选条件查看其他任务。' : '选择一篇已同步笔记，开始补充本地资料。' });
            if (!scopedJobs.length) new Setting(empty).addButton(b => b.setButtonText('选择笔记补充').onClick(() => void this.chooseTask()));
        }
        const queueActions = queueSection.createEl('details', { cls: 'clip2md-queue-actions', attr: { 'data-disclosure': 'queue-actions' } });
        queueActions.open = hadDisclosures ? previousOpen.get('queue-actions') === true : false;
        queueActions.createEl('summary', { text: '队列操作' });
        new Setting(queueActions)
            .setName("停止与恢复")
            .addButton((b) => { b.buttonEl.dataset.control = 'queue-pause'; return b.setButtonText(this.queuePaused ? "恢复队列" : "暂停全部任务").onClick(() => {
                this.queuePaused = !this.queuePaused;
                if (this.queuePaused) this.active?.abort(); else this.drain();
                this.persist();
                this.renderSettings(container);
            }); })
            .addButton((b) => b.setButtonText("停止当前任务").onClick(() => this.active?.abort()))
            .addButton((b) => b.setButtonText("重试失败和待写入项").onClick(() => {
            for (const job of this.state.jobs)
                if (job.context.bindingScope === this.scope &&
                    ["failed", "waiting-write", "cancelled"].includes(job.status))
                    { job.status = "queued"; job.retryCount = 0; delete job.nextAttemptAt; }
            this.persist();
            this.drain();
        }))
            .addButton((b) => b.setButtonText("清空失败任务").setDisabled(!scopedJobs.some(job => queueBucket(job) === "failed")).onClick(() => {
                this.state.jobs = clearFailedJobs(this.state.jobs, this.scope);
                this.persist();
                this.renderSettings(container);
            }))
            .addButton((b) => b.setButtonText("清空全部任务").setDisabled(!scopedJobs.length).onClick(() => {
                this.state.jobs = clearAllJobs(this.state.jobs, this.scope, () => this.active?.abort());
                this.persist();
                this.renderSettings(container);
            }));
        const maintenance = disclosure('maintenance', '扩展信息与维护');
        maintenance.classList.add('clip2md-maintenance-group');
        const maintenancePanel = maintenance.createDiv({ cls: 'clip2md-settings-group-content' });
        if (standalone) maintenancePanel.createEl('p', { text: `版本 ${this.manifest.version} · ${BUILD_CHANNEL === 'market' ? '社区市场版本' : '网站下载版本'}`, cls: 'setting-item-description' });
        this.diagnostics?.render(maintenancePanel, async () => {
            this.configurationCleared = true;
            this.active?.abort();
            await this.retainedConfig?.clear();
            this.app.saveLocalStorage(`clip2md-tools-${deviceId(this.app)}`, null);
            await this.saveData({});
        });
        const enabledCleanup=()=>{cleanup();toolsCleanup();platforms.dispose();this.profileViews.delete(platforms);this.statusElements.delete(status);};
        this.settingsViews.set(container,enabledCleanup);
        restoreView();
        return enabledCleanup;
    }

    private shouldAutoObserveLogin(platform: LoginPlatform): boolean {
        return observedAccount(platform) && !this.sessions.hasStoredAuthorization(platform);
    }
}
