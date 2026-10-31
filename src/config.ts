export const PLATFORMS = [
    "bilibili", "douyin", "xiaohongshu", "csdn", "zhihu", "douban",
    "wechat", "wechat-channel", "weibo", "youtube", "twitter", "kuaishou", "toutiao", "xiaoyuzhou", "lizhi", "applepodcasts", "web",
] as const;
export type PlatformName = (typeof PLATFORMS)[number];
export const FEATURES = [
    "metadata",
    "article",
    "video",
    "comments",
    "subtitles",
    "images",
] as const;
export type Feature = (typeof FEATURES)[number];
export interface DesktopSettings {
    platforms: Record<PlatformName, Record<Feature, boolean>>;
    platformEnabled: Record<PlatformName, boolean>;
    materialFolder: string;
    webDomains: string[];
    whisper: string;
    whisperModel: string;
    language: string;
    asrTimeoutMinutes: number;
    ffmpeg: string;
    ytdlp: string;
    commentLimit: number;
    maxBytes: number;
    timeoutMinutes: number;
}
export const CLIP2MD_USAGE_DOC_URL = 'https://static.clip2md.cn/docs/product-guide-for-ai-agents.md';
export function normalizeSettings(raw: unknown): DesktopSettings {
    const v = raw && typeof raw === "object" ? (raw as Partial<DesktopSettings>) : {};
    return {
        platforms: Object.fromEntries(PLATFORMS.map((p) => [
            p,
            Object.fromEntries(FEATURES.map((f) => [f, v.platforms?.[p]?.[f] === true])),
        ])) as DesktopSettings["platforms"],
        platformEnabled: Object.fromEntries(PLATFORMS.map(p => [p,
            typeof v.platformEnabled?.[p] === "boolean" ? v.platformEnabled[p] : FEATURES.some(f => v.platforms?.[p]?.[f] === true),
        ])) as DesktopSettings["platformEnabled"],
        webDomains: [...new Set((Array.isArray(v.webDomains) ? v.webDomains : []).map(value => typeof value === 'string' ? normalizeWebDomain(value) : '').filter(Boolean))],
        materialFolder: typeof v.materialFolder === 'string' ? v.materialFolder.trim().replace(/\\/g, '/') : '',
        whisper: typeof v.whisper === "string" ? v.whisper : "",
        whisperModel: typeof v.whisperModel === "string" ? v.whisperModel : "",
        language: typeof v.language === "string" && /^(auto|[a-z]{2,3})$/.test(v.language) ? v.language : "auto",
        asrTimeoutMinutes: Math.min(240, Math.max(1, Number(v.asrTimeoutMinutes) || 60)),
        ffmpeg: typeof v.ffmpeg === "string" ? v.ffmpeg : "",
        ytdlp: typeof v.ytdlp === "string" ? v.ytdlp : "",
        commentLimit: Math.min(1000, Math.max(1, Number.isSafeInteger(v.commentLimit) ? v.commentLimit! : 100)),
        maxBytes: Math.min(1024 ** 3 * 10, Math.max(1024 ** 2, Number.isSafeInteger(v.maxBytes) ? v.maxBytes! : 1024 ** 3)),
        timeoutMinutes: Math.min(120, Math.max(1, Number.isFinite(v.timeoutMinutes) ? v.timeoutMinutes! : 15)),
    };
}
export function platformFor(value: string): PlatformName {
    const host = new URL(value).hostname.toLowerCase();
    const match = (domain: string) => host === domain || host.endsWith("." + domain);
    for (const [domain, platform] of [
        ['csdn.net', 'csdn'], ['zhihu.com', 'zhihu'], ['douban.com', 'douban'],
        ['weibo.com', 'weibo'], ['weibo.cn', 'weibo'], ['youtube.com', 'youtube'], ['youtu.be', 'youtube'],
        ['x.com', 'twitter'], ['twitter.com', 'twitter'], ['t.co', 'twitter'],
        ['kuaishou.com', 'kuaishou'], ['kwai.com', 'kuaishou'], ['toutiao.com', 'toutiao'], ['toutiaoimg.cn', 'toutiao'],
        ['lizhi.fm', 'lizhi'], ['podcasts.apple.com', 'applepodcasts'], ['itunes.apple.com', 'applepodcasts'],
    ] as const) if (match(domain)) return platform;
    if (match("bilibili.com") || match("b23.tv"))
        return "bilibili";
    if (match("douyin.com") || match("iesdouyin.com"))
        return "douyin";
    if (match("xiaohongshu.com") || match("xhslink.com") || match("xhslink.cn") || match("rednote.com"))
        return "xiaohongshu";
    if (host === "mp.weixin.qq.com") return "wechat";
    // Video Channels use an independent authorization context. A bare
    // weixin.qq.com link is only a Channels share URL for the /sph/ route.
    if (host === "channels.weixin.qq.com" ||
        (host === "weixin.qq.com" && /^\/sph\/[^/]+(?:\/|$)/.test(new URL(value).pathname)))
        return "wechat-channel";
    if (host === "weixin.qq.com") return "wechat";
    if (match("xiaoyuzhoufm.com"))
        return "xiaoyuzhou";
    return "web";
}
export const LOGIN_ORIGINS = {
    csdn: 'https://www.csdn.net/', zhihu: 'https://www.zhihu.com/', douban: 'https://www.douban.com/',
    bilibili: 'https://www.bilibili.com/', douyin: 'https://www.douyin.com/', xiaohongshu: 'https://www.xiaohongshu.com/',
    // The root is the official-account management console. Local capture uses
    // the consumer article route so it never asks for an admin login.
    wechat: 'https://mp.weixin.qq.com/s/',
    // Video Channels are authorized independently through Tencent Yuanbao.
    // The source work is opened after that first-party login context is ready.
    'wechat-channel': 'https://yuanbao.tencent.com/',
    weibo: 'https://weibo.com/', youtube: 'https://www.youtube.com/',
    twitter: 'https://x.com/',
    // The consumer origin can be replaced by an anti-abuse JSON response.
    // First-party PC login is hosted by the passport origin.
    kuaishou: 'https://passport.kuaishou.com/pc/account/login', toutiao: 'https://www.toutiao.com/',
    // The public home page is a download/marketing shell. Account login is
    // hosted by Xiaoyuzhou's first-party unified identity service.
    xiaoyuzhou: 'https://accounts.xiaoyuzhoufm.com/login',
    // Use Lizhi's consumer taco login flow. The standalone page that previously
    // opened here started the broadcaster login instead of the listener login.
    lizhi: 'https://nj.lizhi.fm/static/login/#/taco/redirect', applepodcasts: 'https://podcasts.apple.com/',
} as const;
export type LoginPlatform = keyof typeof LOGIN_ORIGINS | `web:${string}`;
export const LOGIN_DOMAINS: Record<keyof typeof LOGIN_ORIGINS, string[]> = {
    csdn: ['csdn.net'], zhihu: ['zhihu.com'], douban: ['douban.com'],
    bilibili: ['bilibili.com', 'b23.tv'], douyin: ['douyin.com', 'iesdouyin.com'],
    xiaohongshu: ['xiaohongshu.com', 'xhslink.com', 'xhslink.cn', 'rednote.com'],
    wechat: ['mp.weixin.qq.com', 'open.weixin.qq.com', 'weixin.qq.com'],
    'wechat-channel': [
        'yuanbao.tencent.com', 'static.yuanbao.tencent.com',
        'weixin.qq.com', 'channels.weixin.qq.com', 'finder.video.qq.com',
        'open.weixin.qq.com', 'login.weixin.qq.com',
    ],
    weibo: ['weibo.com', 'weibo.cn', 'passport.weibo.com', 'login.sina.com.cn', 'passport.sina.com.cn'],
    youtube: ['youtube.com', 'youtu.be', 'accounts.google.com', 'google.com'], twitter: ['x.com', 'twitter.com', 't.co'],
    kuaishou: ['kuaishou.com', 'kwai.com', 'passport.kuaishou.com'], toutiao: ['toutiao.com'], xiaoyuzhou: ['xiaoyuzhoufm.com', 'accounts.xiaoyuzhoufm.com'],
    lizhi: ['lizhi.fm', 'lizhifm.com'],
    // Apple ID auth hands off through music.apple.com and writes the Music
    // media token as a shared apple.com cookie.
    applepodcasts: ['podcasts.apple.com', 'itunes.apple.com', 'apple.com'],
};
/** A generic site is scoped to the explicitly configured hostname and its subdomains. */
export function normalizeWebDomain(value: string): string {
    try {
        const url = new URL(value.includes('://') ? value.trim() : `https://${value.trim()}`);
        const host = url.hostname.toLowerCase();
        if (url.protocol !== 'https:' || url.username || url.password || url.port || !host.includes('.')
            || host.split('.').some(label=>!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || /[\s:%]/.test(host) || host.endsWith('.') || host === 'localhost' || /^\d+(?:\.\d+){3}$/.test(host)) return '';
        return host;
    } catch { return ''; }
}
export function loginFor(value: string, webDomains: string[] = []): LoginPlatform {
    const platform = platformFor(value);
    if (platform !== 'web') return platform;
    const host = normalizeWebDomain(value);
    if (!host) throw new Error('通用网页登录仅支持有效的 HTTPS 域名');
    const domain = [...webDomains].sort((a,b) => b.length-a.length).find(item => host === item || host.endsWith('.'+item));
    return `web:${domain || host}`;
}
export function loginOrigin(platform: LoginPlatform): string {
    if (platform.startsWith('web:')) {
        const domain = platform.slice(4);
        if (!domain || normalizeWebDomain(domain) !== domain) throw new Error('请先填写有效的站点域名');
        return `https://${domain}/`;
    }
    return LOGIN_ORIGINS[platform as keyof typeof LOGIN_ORIGINS];
}
export function loginDomains(platform: LoginPlatform): string[] {
    return platform.startsWith('web:') ? [new URL(loginOrigin(platform)).hostname] : LOGIN_DOMAINS[platform as keyof typeof LOGIN_ORIGINS];
}
export function supportsFeature(platform: PlatformName, feature: Feature): boolean {
    if (platform === 'web') return !['comments', 'subtitles'].includes(feature);
    if (platform === 'wechat-channel') return feature !== 'comments';
    if (platform === 'lizhi' || platform === 'applepodcasts') return feature !== 'comments';
    return true;
}
export function observedAccount(platform: LoginPlatform): boolean {
    return ['bilibili', 'douyin', 'xiaohongshu', 'zhihu', 'wechat-channel'].includes(platform);
}
/** Validate externally edited settings before normalization can replace a user preference with defaults. */
export function validPreferences(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const v = value as Record<string, unknown>;
    if (v.webDomains !== undefined && (!Array.isArray(v.webDomains) || v.webDomains.some(domain => typeof domain !== 'string' || normalizeWebDomain(domain) !== domain))) return false;
    if (v.materialFolder !== undefined && (typeof v.materialFolder !== 'string' || !validMaterialFolder(v.materialFolder))) return false;
    for (const name of ["commentLimit", "maxBytes", "timeoutMinutes", "asrTimeoutMinutes"]) {
        if (v[name] !== undefined &&
            (typeof v[name] !== "number" || !Number.isFinite(v[name])))
            return false;
    }
    for (const name of ["ffmpeg", "ytdlp", "whisper", "whisperModel", "language"])
        if (v[name] !== undefined && typeof v[name] !== "string")
            return false;
    if (v.platformEnabled !== undefined && (!v.platformEnabled || typeof v.platformEnabled !== "object" || Array.isArray(v.platformEnabled) || Object.values(v.platformEnabled).some(flag => typeof flag !== "boolean"))) return false;
    if (v.platforms !== undefined) {
        if (!v.platforms ||
            typeof v.platforms !== "object" ||
            Array.isArray(v.platforms))
            return false;
        for (const flags of Object.values(v.platforms as Record<string, unknown>)) {
            if (!flags || typeof flags !== "object" || Array.isArray(flags))
                return false;
            if (Object.values(flags as Record<string, unknown>).some((flag) => typeof flag !== "boolean"))
                return false;
        }
    }
    return true;
}

export function validMaterialFolder(value:string):boolean {
    const folder=value.trim().replace(/\\/g,'/');
    return folder==='/' || (!folder.startsWith('/') && !Array.from(folder).some(char=>char.charCodeAt(0)<32) && !/[<>:"|?*]/.test(folder)
        && !folder.split('/').some(part=>part==='..' || part==='.'));
}
