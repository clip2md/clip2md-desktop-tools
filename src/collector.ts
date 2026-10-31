import { transcribe } from "./transcription";
import { imageExtension } from "./images";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { resolveSiteLink, applePodcastsLink } from "./adapters/site-link";
import { SiteMediaUnavailable, SiteGalleryUnavailable, canonicalDouyinVideoUrl, type SiteResult, } from "./adapters/sites";
import { type ExtractedContent } from "./adapters/extract";
import { readPublicImage, readPublicJson, sourceRequestHeaders } from "./adapters/network";
import { downloadPublicMedia, MediaCandidateUnavailable, type DownloadedMedia, } from "./adapters/media-download";
import { extractRenderedSitePage } from "./adapters/rendered-sites";
import { collectComments, renderComments } from "./comments";
import { AuthorizationRequired, type SiteSessions } from "./auth";
import { sourcePage } from "./page-source";
import { MaterialStore } from "./storage";
import { authenticatedPage } from './adapters/authenticated-page';
import { nowBeijingDateTime } from './date-format';
import { platformFor, type DesktopSettings, type Feature, } from "./config";
import { checkTool, discoverVideo, downloadMediaWithYtDlp, downloadYouTubeMedia, runTool } from "./tools";
import type { ResolverProxy } from "./adapters/resolver-proxy";
import type { TaskContext, LocalProperties } from "./companion-protocol";
export interface CollectionResult {
    properties: LocalProperties;
    assets: string[];
    body: string;
}
/** The source file is valid, but contains no audio stream to transcribe. */
export class LocalMediaNoAudio extends Error {
    constructor() { super("本地媒体没有音轨，已跳过字幕采集"); }
}
export function uniqueMediaCandidates(
    urls: string[],
    decryptKeys?: Array<string | undefined>,
): Array<[string, string | undefined]> {
    const uniqueMap = new Map<string, string | undefined>();
    urls.forEach((url, index) => {
        const key = decryptKeys?.[index];
        const previous = uniqueMap.get(url);
        // Keep the first usable key when an alternative repeats the URL.
        if (!uniqueMap.has(url) || (!previous && key)) uniqueMap.set(url, key);
    });
    return [...uniqueMap.entries()].slice(0, 8);
}

async function downloadMediaCandidates(
    urls: string[],
    signal: AbortSignal,
    referer: string,
    directory: string,
    options: {
        maxBytes: number;
        timeoutMs: number;
        decryptKeys?: Array<string | undefined>;
    },
): Promise<DownloadedMedia> {
    let last: unknown;
    const unique = uniqueMediaCandidates(urls, options.decryptKeys);
    for (const [url, decryptKey] of unique) {
        const { decryptKeys: _decryptKeys, ...downloadOptions } = options;
        try {
            return await downloadPublicMedia(
                url,
                signal,
                referer,
                directory,
                undefined,
                {
                    ...downloadOptions,
                    ...(decryptKey ? { decryptKey } : {}),
                },
            );
        } catch (error) {
            if (signal.aborted) throw error;
            last = error;
            const message = error instanceof Error ? error.message : "";
            if (!(error instanceof MediaCandidateUnavailable) && !/HTTP (?:403|404|410|429|5\d\d)\b|连接中断|连接超时/.test(message))
                throw error;
        }
    }
    throw last instanceof Error ? last : new Error("原站没有可用的媒体地址");
}
function isExpiredMediaError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : "";
    return /HTTP 403\b|媒体连接中断|连接中断/.test(message);
}
const VIDEO_ASSET = /\.(?:mp4|m4v|mkv|webm|mov|ogv|mpeg|mpg|3gp|m3u8|ts|flv)$/i;
const AUDIO_ASSET = /\.(?:mp3|m4a|wav|ogg|oga|flac|opus|aac)$/i;
const IMAGE_ASSET = /\.(?:png|jpe?g|webp|gif|svg|bmp|avif)$/i;
function isLocalVideoAsset(file: string): boolean {
    return VIDEO_ASSET.test(file) && !/[-_./]audio-/i.test(file);
}
function isDouyinGallerySource(value: string, result?: SiteResult): boolean {
    try {
        if (/^\/(?:share\/)?(?:note|article)\//.test(new URL(value).pathname)) return true;
    } catch { /* Fall back to resolved content. */ }
    return !!result && !result.media &&
        (!!result.content.image_urls?.length ||
            /!\[[^\]]*\]\(https?:\/\/[^\s)]+\)/.test(result.content.markdown));
}
async function refreshDouyinMedia(
    context: TaskContext,
    sessions: SiteSessions,
    signal: AbortSignal,
): Promise<SiteResult | undefined> {
    const sourceUrl = canonicalDouyinVideoUrl(context.sourceUrl) || context.sourceUrl;
    signal.throwIfAborted();
    const snapshot = await sourcePage(sessions, sourceUrl, signal);
    signal.throwIfAborted();
    try {
        const rendered = extractRenderedSitePage(snapshot, sourceUrl, true);
        if (rendered.media) return rendered;
    } catch {
        signal.throwIfAborted();
        // Continue with the signed detail request below.
    }
    // Some signed-in pages omit the inline media object but still service
    // the detail endpoint with the refreshed session signature.
    return await resolveSource(context, sessions, signal);
}
async function collectWithYtDlp(
    context: TaskContext,
    settings: DesktopSettings,
    sessions: SiteSessions,
    store: MaterialStore,
    signal: AbortSignal,
    progress: (message: string) => void,
    content: ExtractedContent,
): Promise<CollectionResult> {
    const directory = await store.cache(context);
    let proxy: ResolverProxy | undefined;
    try {
        await checkTool("ytdlp", settings, directory, signal);
        proxy = await (await import("./adapters/resolver-proxy")).createResolverProxy(
            signal,
            undefined,
            { maxBytes: Math.min(Math.max(settings.maxBytes, 32 * 1024 * 1024), 2 * 1024 ** 3) },
        );
        const cookies = await sessions.authorizedCookies(sessions.targetFor(context.sourceUrl));
        const sourceUrl = canonicalDouyinVideoUrl(context.sourceUrl) || context.sourceUrl;
        const complete = await downloadMediaWithYtDlp(sourceUrl, settings, directory, signal, cookies, proxy);
        const file = await store.media(context, "video", await fingerprint(complete, "mkv", signal), signal);
        return {
            properties: metadata(content),
            assets: [file],
            body: `![](</${file.split('/').map(encodeURIComponent).join('/')}>)`,
        };
    } finally {
        if (proxy) await proxy.close();
    }
}
/** X and several authenticated media sites expose signed MP4/HLS responses
 * rather than a stable downloadable file. Let the configured FFmpeg read the
 * response and assemble/remux it while keeping the same bounded task limits. */
export function isHlsMediaUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === "https:" && (/\.m3u8(?:$|[?#])/i.test(url.pathname) || url.hash === "#clip2md-hls");
    } catch {
        return false;
    }
}
async function downloadFfmpegMedia(
    value: string,
    referer: string,
    settings: DesktopSettings,
    directory: string,
    signal: AbortSignal,
): Promise<DownloadedMedia> {
    const input = new URL(value);
    input.hash = "";
    const inputUrl = input.href;
    const headers = await sourceRequestHeaders(inputUrl, referer);
    const ffmpegHeaders = Object.entries(headers)
        .filter(([key, header]) => key.toLowerCase() !== "accept-encoding" && !/[\r\n]/.test(header))
        .map(([key, header]) => `${key}: ${header}\r\n`)
        .join("");
    const target = path.join(directory, "site-hls-input.mkv");
    await checkTool("ffmpeg", settings, directory, signal);
    await runTool(settings.ffmpeg, [
        "-nostdin", "-hide_banner", "-loglevel", "error",
        "-protocol_whitelist", "file,http,https,tcp,tls,crypto",
        ...(ffmpegHeaders ? ["-headers", ffmpegHeaders] : []),
        "-i", inputUrl,
        "-map", "0:v:0?", "-map", "0:a:0?", "-c", "copy", "-y", target,
    ], directory, signal, settings.timeoutMinutes * 60000);
    const stat = await fs.stat(target).catch(() => undefined);
    if (!stat?.isFile() || stat.size <= 0)
        throw new Error("原站媒体未生成可播放文件");
    if (stat.size > settings.maxBytes)
        throw new Error("合并后的 HLS 视频超过本地下载上限");
    return fingerprint(target, "mkv", signal);
}
function metadata(content: ExtractedContent): LocalProperties {
    const result: LocalProperties = { captured_at: nowBeijingDateTime() };
    for (const key of [
        "author",
        "source_date",
        "source_title",
        "duration_seconds",
    ] as const) {
        const value = content[key];
        if (value !== undefined && value !== null)
            (result as Record<string, unknown>)[key] = value;
    }
    if (content.metrics)
        for (const key of [
            "views",
            "likes",
            "collects",
            "comments",
            "shares",
            "coins",
        ] as const) {
            const value = content.metrics[key];
            if (value !== undefined)
                result[key] = value;
        }
    return result;
}
export async function resolveSource(context: TaskContext, sessions: SiteSessions, signal: AbortSignal): Promise<SiteResult> {
    const platform = platformFor(context.sourceUrl);
    const sourceUrl = platform === "douyin" ? (canonicalDouyinVideoUrl(context.sourceUrl) || context.sourceUrl) : context.sourceUrl;
    if(!['bilibili','douyin','xiaohongshu','xiaoyuzhou'].includes(platform)) {
        if (platform === 'applepodcasts')
            return await applePodcastsLink(sourceUrl, signal, undefined, true);
        const snapshot=await sourcePage(sessions,sourceUrl,signal);
        try{return authenticatedPage(snapshot,sourceUrl);}
        catch(error){if(error instanceof Error&&/登录|验证/.test(error.message))throw new AuthorizationRequired(error.message);throw error;}
    }
    try {
        return await resolveSiteLink(sourceUrl, signal, true);
    }
    catch (error) {
        signal.throwIfAborted();
        if ((error instanceof SiteMediaUnavailable ||
            error instanceof SiteGalleryUnavailable) &&
            error.content)
            return { content: error.content };
        const platform = platformFor(context.sourceUrl);
        if (["douyin", "xiaohongshu"].includes(platform)) {
            const snapshot = await sourcePage(sessions, sourceUrl, signal);
            try {
                return extractRenderedSitePage(snapshot, sourceUrl, true);
            }
            catch (rendered) {
                if ((rendered instanceof SiteMediaUnavailable ||
                    rendered instanceof SiteGalleryUnavailable) &&
                    rendered.content)
                    return { content: rendered.content };
                throw rendered;
            }
        }
        if (error instanceof Error &&
            /登录|验证|HTTP (?:401|403|412|429)/.test(error.message)) {
            if (!["bilibili", "douyin", "xiaohongshu"].includes(platform))
                throw new Error("此来源首期仅支持公开内容，登录或访问验证暂不支持，请提供可公开访问的原文");
            throw new AuthorizationRequired("来源需要登录或访问验证，请授权后重试");
        }
        throw error;
    }
}
async function fingerprint(file: string, extension: string, signal: AbortSignal): Promise<DownloadedMedia> {
    let bytes = 0;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) {
        signal.throwIfAborted();
        bytes += chunk.length;
        hash.update(chunk);
    }
    return { path: file, extension, bytes, sha256: hash.digest("hex") };
}
async function saveVideoCover(context: TaskContext, existingVideo: string, settings: DesktopSettings, store: MaterialStore, signal: AbortSignal): Promise<CollectionResult> {
    const directory = await store.cache(context);
    await checkTool("ffmpeg", settings, directory, signal);
    const target = path.join(directory, "video-cover.jpg");
    await runTool(settings.ffmpeg, [
        "-nostdin", "-v", "error", "-i", await store.localFile(existingVideo),
        "-frames:v", "1", "-q:v", "2", "-y", target,
    ], directory, signal);
    const bytes = await fs.readFile(target), extension = imageExtension(bytes);
    if (!extension || !bytes.length)
        throw new Error("本地视频未生成有效封面");
    const saved = await store.media(context, "image", await fingerprint(target, extension, signal), signal);
    return { properties: {}, assets: [saved], body: `[本地封面](</${saved.split("/").map(encodeURIComponent).join("/")}>)` };
}
/** Save readable content and its selected images without sending page credentials to the cloud. */
export async function saveArticle(context:TaskContext,result:SiteResult,settings:DesktopSettings,store:MaterialStore,signal:AbortSignal):Promise<{body:string;assets:string[];markdown:string}> {
    let markdown=result.content.markdown || result.content.source_description || '';
    const assets:string[]=[];
    let directory='';
    const urls=[...new Set([...markdown.matchAll(/!\[[^\]]*\]\(<?(https?:\/\/[^\s)>]+)>?\)/g)].map(match=>match[1]))].slice(0,100);
    let remaining=settings.maxBytes;
    let failed=0;
    try {
        if(settings.platforms[platformFor(context.sourceUrl)].images)for(const [index,url] of urls.entries()) {
            signal.throwIfAborted();
            try {
                const image=await readPublicImage(url,signal,context.sourceUrl),bytes=Buffer.from(image.arrayBuffer),extension=imageExtension(bytes);
                if(!extension||bytes.length>remaining)throw new Error('正文图片格式无效或超过本地下载上限');
                if(/html|json/i.test(image.headers["content-type"]))throw new Error('正文图片地址返回了网页');
                remaining-=bytes.length;
                directory ||= await store.cache(context);
                const temporary=path.join(directory,`article-${index}.${extension}`);
                await fs.writeFile(temporary,bytes,{flag:'wx',mode:0o600});
                const file=await store.media(context,'image',await fingerprint(temporary,extension,signal),signal);
                assets.push(file);
                markdown=markdown.split(url).join(`/${file.split('/').map(encodeURIComponent).join('/')}`);
            } catch {
                signal.throwIfAborted();
                failed++;
            }
        }
        if(!markdown.trim())markdown='> 页面含音视频，未取得独立图文正文。请使用视频／音频采集保存媒体原件。';
        if(failed)markdown+=`\n\n> ${failed} 张正文图片未能保存，已保留原站链接，可稍后重试。`;
        const file=await store.text(context,'article',`# ${result.content.source_title||result.content.title}\n\n${markdown}`);
        assets.unshift(file);
        return {assets,markdown,body:`[正文图文](</${file.split('/').map(encodeURIComponent).join('/')}>)\n\n${markdown}`};
    } finally {if(directory)await fs.rm(directory,{recursive:true,force:true});}
}
export async function collect(context: TaskContext, feature: Feature, settings: DesktopSettings, sessions: SiteSessions, store: MaterialStore, signal: AbortSignal, progress: (message: string) => void, existingAssets: string[] = []): Promise<CollectionResult> {
    const platform = platformFor(context.sourceUrl);
    const isBilibiliOpus = platform === "bilibili" && /^\/opus\/[A-Za-z0-9]+(?:\/|$)/.test(new URL(context.sourceUrl).pathname);
    const assets: string[] = [];
    let properties: LocalProperties = {};
    let body = "";
    let directory = "";
    let mediaProxy: ResolverProxy | undefined;
    let checkpoint = "", checkpointComplete = false;
    try {
        if (isBilibiliOpus && feature === "video")
            return { properties: {}, assets: [], body: "> B站 Opus 是图文动态，未提供可下载视频，已跳过视频采集。" };
        if (isBilibiliOpus && feature === "comments")
            return { properties: {}, assets: [], body: "> B站 Opus 图文动态暂不提供本地评论接口，已跳过评论采集。" };
        if (feature === "comments" && platform === "zhihu" && /\/question\/[1-9]\d*(?:\/|$)/.test(new URL(context.sourceUrl).pathname) && !/\/answer\//.test(new URL(context.sourceUrl).pathname))
            return { properties: {}, assets: [], body: "> 知乎问题页没有稳定的独立评论接口，已跳过评论采集；回答页仍可采集评论。" };
        if (feature === "video" && platform === "douyin" && isDouyinGallerySource(context.sourceUrl))
            return { properties: {}, assets: [], body: "> 抖音图文作品不含视频，已跳过视频采集。" };
        if (feature === "video" && platform === "douyin" &&
            !existingAssets.some(isLocalVideoAsset))
            if (isDouyinGallerySource(context.sourceUrl) ||
                existingAssets.some(file => IMAGE_ASSET.test(file)))
            return { properties: {}, assets: [], body: "> 抖音图文作品不含视频，已跳过视频采集。" };
        progress("正在获取来源");
        if (feature === "subtitles") {
            const existingVideo = existingAssets.find((file) => /\.(?:mp4|m4v|mkv|webm|mov|ogv|mpeg|mpg|mp3|m4a|wav|ogg|oga|flac|opus|aac|3gp|m3u8|ts|flv)$/i.test(file));
            if (existingVideo) {
                directory = await store.cache(context);
                const localMedia = await store.localFile(existingVideo);
                const embedded = path.join(directory, "embedded.srt");
                let transcript = "";
                try {
                    await checkTool("ffmpeg", settings, directory, signal);
                    await runTool(settings.ffmpeg, ["-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", localMedia, "-map", "0:s:0", "-c:s", "srt", "-n", embedded], directory, signal);
                    transcript = await fs.readFile(embedded, "utf8");
                } catch {
                    signal.throwIfAborted();
                    try {
                        transcript = await transcribe(localMedia, directory, settings, signal, undefined, 0);
                    } catch (transcriptionError) {
                        if (transcriptionError instanceof Error && /(?:does not contain any stream|没有音频|no audio stream|audio stream)/i.test(transcriptionError.message))
                            throw new LocalMediaNoAudio();
                        throw transcriptionError;
                    }
                }
                if (transcript.trim()) {
                    const file = await store.text(context, "transcript", transcript);
                    assets.push(file);
                    return { properties, assets, body: `[本地转写](</${file.split('/').map(encodeURIComponent).join('/')}>)\n\n${transcript}` };
                }
            }
        }
        let detected: SiteResult | undefined;
        if (feature === 'article' || (feature === 'video' && (platform === 'douyin' || platform === 'xiaohongshu' || !['bilibili','douyin','xiaohongshu','youtube'].includes(platform))))
            detected = await resolveSource(context, sessions, signal);
        else if (feature === 'images') {
            try {
                detected = await resolveSource(context, sessions, signal);
            }
            catch (error) {
                const existingVideo = existingAssets.find(isLocalVideoAsset);
                if (existingVideo)
                    return await saveVideoCover(context, existingVideo, settings, store, signal);
                throw error;
            }
        }
        if (feature === "video" && platform === "douyin" && isDouyinGallerySource(context.sourceUrl, detected))
            return { properties: detected ? metadata(detected.content) : {}, assets: [], body: "> 抖音图文作品不含视频，已跳过视频采集。" };
        if(feature==='article' || (feature==='video' && detected && !detected.media && !['bilibili','douyin','xiaohongshu','youtube'].includes(platform))) {
            const result=detected!;
            const article=await saveArticle(context,result,settings,store,signal);
            assets.push(...article.assets);properties=metadata(result.content);
            body=article.body;
            if(feature==='video')body='> 页面未探测到可下载音视频，已保存正文图文。\n\n'+body;
        }
        else if (feature === "video" && platform === "xiaohongshu" && detected && !detected.media && !detected.detectedMedia) {
            // An XHS gallery is a complete source with an image payload and no
            // video stream. A missing stream is only an authorization failure
            // when the source itself identifies the note as a video.
            body = "> 小红书图集不含视频，已跳过视频采集。";
        }
        else if(feature==='video' && detected?.media && platform !== "twitter") {
            directory=await store.cache(context);
            const direct = async (result: SiteResult) => {
                if (!result.media) throw new Error("原站媒体地址已刷新但未返回媒体");
                const candidates = [result.media.url, ...(result.media.alternatives || [])];
                const hls = candidates.find(isHlsMediaUrl);
                return hls
                    ? await downloadFfmpegMedia(hls, context.sourceUrl, settings, directory, signal)
                    : await downloadMediaCandidates(candidates, signal, context.sourceUrl, directory, {
                        maxBytes: settings.maxBytes,
                        timeoutMs: settings.timeoutMinutes * 60000,
                        ...(result.media.decryptKey || result.media.alternativeDecryptKeys?.length
                            ? {
                                decryptKeys: [
                                    result.media.decryptKey,
                                    ...(result.media.alternativeDecryptKeys || []),
                                ],
                            }
                            : {}),
                    });
            };
            let media: DownloadedMedia;
            try {
                media = await direct(detected);
            } catch (error) {
                if (signal.aborted || platform !== "douyin" || !isExpiredMediaError(error))
                    throw error;
                progress("抖音媒体签名已失效，正在重新载入原站");
                const refreshed = await refreshDouyinMedia(context, sessions, signal);
                if (!refreshed?.media) throw error;
                detected = refreshed;
                try {
                    media = await direct(refreshed);
                } catch (refreshedError) {
                    if (!isExpiredMediaError(refreshedError))
                        throw refreshedError;
                    progress("刷新后的抖音媒体仍被拒绝，改用本地 yt-dlp");
                    return await collectWithYtDlp(context, settings, sessions, store, signal, progress, refreshed.content);
                }
            }
            const file=await store.media(context,detected.detectedMedia==='video'||platform==='douyin'?'video':'audio',media,signal);
            assets.push(file);properties=metadata(detected.content);
            body=`![](</${file.split('/').map(encodeURIComponent).join('/')}>)`;
        }
        else if (feature === "video" && platform === "wechat-channel" && detected) {
            // Video Channels may return only a cover or a textual shell when
            // Yuanbao's short-lived media grant is missing. Never turn that
            // into a successful "video" task whose only asset is an image.
            throw new Error("视频号未取得可下载的视频流，请重新登录腾讯元宝后重试");
        }
        else if (feature === "comments") {
            let result;
            try {
                result = await collectComments(context.sourceUrl, platform, settings.commentLimit, sessions, signal);
            }
            catch (error) {
                if (platform === "zhihu" &&
                    error instanceof Error &&
                    /原站页面未返回可核验的评论/.test(error.message))
                    return {
                        properties: {},
                        assets: [],
                        body: "> 知乎原站未返回可核验的评论数据，已正常跳过评论采集；这不表示登录失效。",
                    };
                throw error;
            }
            const title=(context.noteTitle||context.sourceTitle||`剪藏 ${context.taskId}`).replace(/[\r\n]/g,' ');
            body = `# 本地评论 · ${title}\n\n`+renderComments(result);
            properties = { captured_at: result.capturedAt };
            const file = await store.text(context, "comments", body);
            assets.push(file);
            body = `[本地评论](</${file.split('/').map(encodeURIComponent).join('/')}>)`;
        }
        else if (feature === "video" && platform !== "xiaoyuzhou") {
            directory = await store.cache(context);
            const sourceUrl = platform === "douyin" ? (canonicalDouyinVideoUrl(context.sourceUrl) || context.sourceUrl) : context.sourceUrl;
            if (platform === "douyin") {
                try {
                    const snapshot = await sourcePage(sessions, sourceUrl, signal);
                    const rendered = extractRenderedSitePage(snapshot, sourceUrl, true);
                    if (rendered.media) {
                        progress("正在下载页面捕获的视频");
                        const media = await downloadMediaCandidates([rendered.media.url,...(rendered.media.alternatives || [])], signal, context.sourceUrl, directory, { maxBytes: settings.maxBytes, timeoutMs: settings.timeoutMinutes * 60000 });
                        const file = await store.media(context, "video", media, signal);
                        assets.push(file);
                        properties = metadata(rendered.content);
                        body = `![](</${file.split('/').map(encodeURIComponent).join('/')}>)`;
                        return { properties, assets, body };
                    }
                } catch (error) {
                    if (signal.aborted) throw error;
                    // Fall through to yt-dlp when the page did not expose a usable direct media URL.
                }
            }
            await checkTool("ffmpeg", settings, directory, signal);
            progress("正在解析完整视频");
            mediaProxy = platform === "youtube"
                ? await (await import("./adapters/resolver-proxy")).createResolverProxy(
                    signal,
                    undefined,
                    { maxBytes: Math.min(Math.max(settings.maxBytes, 32 * 1024 * 1024), 2 * 1024 ** 3) },
                )
                : undefined;
            const authorized = await sessions.authorizedCookies(sessions.targetFor(context.sourceUrl));
            let plan = mediaProxy
                ? await discoverVideo(sourceUrl, settings, directory, signal, authorized, mediaProxy)
                : await discoverVideo(sourceUrl, settings, directory, signal, authorized);
            let budget = settings.maxBytes;
            const deadline = Date.now() + settings.timeoutMinutes * 60000;
            let refreshed = false;
            let douyinRefreshed = false;
            const acquire = async (track: typeof plan.video, index: number) => {
                if (track.expectedBytes && track.expectedBytes > budget)
                    throw new Error("视频超过本地下载上限");
                const options = { maxBytes: budget, timeoutMs: Math.max(1, deadline - Date.now()), ...(mediaProxy ? { proxy: mediaProxy.url } : {}) };
                try {
                    return await downloadPublicMedia(track.url, signal, context.sourceUrl, path.join(directory, String(index)), (bytes) => progress(`下载媒体 ${(bytes / 1024 / 1024).toFixed(1)} MiB`), options);
                } catch (error) {
                    if (platform === "douyin" && index === 0 && !douyinRefreshed && isExpiredMediaError(error)) {
                        douyinRefreshed = true;
                        progress("抖音媒体签名已失效，正在重新载入原站");
                        const refreshedSource = await refreshDouyinMedia(context, sessions, signal);
                        const candidates = refreshedSource?.media
                            ? [refreshedSource.media.url, ...(refreshedSource.media.alternatives || [])]
                            : [];
                        if (candidates.length) {
                            try {
                                const latest = await downloadMediaCandidates(candidates, signal, context.sourceUrl, path.join(directory, String(index)), options);
                                if (refreshedSource?.content) detected = refreshedSource;
                                return latest;
                            } catch (refreshedError) {
                                if (!isExpiredMediaError(refreshedError)) throw refreshedError;
                            }
                        }
                        progress("刷新后的抖音媒体仍被拒绝，改用本地 yt-dlp");
                        const complete = mediaProxy
                            ? await downloadMediaWithYtDlp(sourceUrl, settings, directory, signal, authorized, mediaProxy)
                            : await (async () => {
                                const { createResolverProxy } = await import("./adapters/resolver-proxy");
                                const fallbackProxy = await createResolverProxy(
                                    signal,
                                    undefined,
                                    { maxBytes: Math.min(Math.max(settings.maxBytes, 32 * 1024 * 1024), 2 * 1024 ** 3) },
                                );
                                try {
                                    return await downloadMediaWithYtDlp(sourceUrl, settings, directory, signal, authorized, fallbackProxy);
                                } finally {
                                    await fallbackProxy.close();
                                }
                            })();
                        return await fingerprint(complete, "mkv", signal);
                    }
                    if (platform !== "youtube" || refreshed || !isExpiredMediaError(error))
                        throw error;
                    refreshed = true;
                    progress("媒体签名已刷新，重新获取 YouTube 地址");
                    const refreshedCookies = await sessions.authorizedCookies(sessions.targetFor(context.sourceUrl));
                    try {
                        plan = mediaProxy
                            ? await discoverVideo(sourceUrl, settings, directory, signal, refreshedCookies, mediaProxy)
                            : await discoverVideo(sourceUrl, settings, directory, signal, refreshedCookies);
                        const next = index === 0 ? plan.video : plan.audio;
                        if (!next) throw error;
                        return await downloadPublicMedia(next.url, signal, context.sourceUrl, path.join(directory, String(index)), (bytes) => progress(`下载媒体 ${(bytes / 1024 / 1024).toFixed(1)} MiB`), options);
                    } catch (retryError) {
                        if (index !== 0 || !mediaProxy) throw retryError;
                        progress("原站拒绝直接媒体请求，改用 YouTube 本地工具下载");
                        const complete = await downloadYouTubeMedia(sourceUrl, settings, directory, signal, refreshedCookies, mediaProxy);
                        plan = { ...plan, audio: undefined };
                        return await fingerprint(complete, "mkv", signal);
                    }
                }
            };
            const video = await acquire(plan.video, 0);
            budget -= video.bytes;
            const audio = plan.audio ? await acquire(plan.audio, 1) : undefined;
            if (audio) budget -= audio.bytes;
            let output = video;
            if (audio) {
                progress("正在合并本地音视频");
                const target = path.join(directory, "complete.mkv");
                await runTool(settings.ffmpeg, [
                    "-nostdin",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-protocol_whitelist",
                    "file,pipe",
                    "-i",
                    video.path,
                    "-protocol_whitelist",
                    "file,pipe",
                    "-i",
                    audio.path,
                    "-map",
                    "0:v:0",
                    "-map",
                    "1:a:0",
                    "-c",
                    "copy",
                    "-n",
                    target,
                ], directory, signal, Math.max(1, deadline - Date.now()));
                output = await fingerprint(target, "mkv", signal);
            }
            if (output.bytes > settings.maxBytes)
                throw new Error("合并后视频超过大小上限");
            // Check a real video stream; an audio-only download cannot be labelled a video.
            const probe = await runTool(settings.ffmpeg, [
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-protocol_whitelist",
                "file,pipe",
                "-i",
                output.path,
                "-map",
                "0:v:0",
                "-map",
                "0:a:0?",
                "-c",
                "copy",
                "-progress",
                "pipe:1",
                "-f",
                "null",
                "-",
            ], directory, signal, Math.max(1, deadline - Date.now()));
            const times = [...probe.matchAll(/^out_time_us=(\d+)$/gm)].map((m) => Number(m[1]) / 1000000);
            const duration = times[times.length - 1];
            if (!probe.includes("progress=end") ||
                !Number.isFinite(duration) ||
                duration <= 0 ||
                (plan.duration &&
                    Math.abs(duration - plan.duration) >
                        Math.min(30, Math.max(2, plan.duration * 0.01))))
                throw new Error("视频未完整覆盖来源时长，未保存为完整原件");
            const file = await store.media(context, "video", output, signal);
            assets.push(file);
            properties = {
                captured_at: nowBeijingDateTime(),
                ...(plan.duration ? { duration_seconds: plan.duration } : {}),
            };
            body = `[视频原件](</${file.split('/').map(encodeURIComponent).join('/')}>)`;
        }
        else {
            const result = await resolveSource(context, sessions, signal);
            properties = metadata(result.content);
            if (feature === "metadata")
                body = Object.entries(properties)
                    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
                    .join("\n\n");
            if (feature === "subtitles") {
                if (result.content.transcription_source === "bilibili_subtitles" &&
                    result.content.markdown.trim()) {
                    const file = await store.text(context, "subtitles", result.content.markdown);
                    assets.push(file);
                    body = `[来源字幕](</${file.split('/').map(encodeURIComponent).join('/')}>)\n\n${result.content.markdown}`;
                }
                else {
                    if (result.media) {
                        checkpoint = await store.checkpoint(context);
                        const sources = result.media.parts?.length ? result.media.parts : [{ ...result.media, duration_seconds: result.media.expectedDurationSeconds || result.content.duration_seconds }];
                        let remaining = settings.maxBytes, offset = 0;
                        const transcripts: string[] = [];
                        for (const [index, source] of sources.entries()) {
                            const part = path.join(checkpoint, String(index));
                            await fs.mkdir(part, { recursive: true, mode: 0o700 });
                            const media = await downloadPublicMedia(source.url, signal, context.sourceUrl, part, undefined, { maxBytes: remaining, timeoutMs: settings.timeoutMinutes * 60000 });
                            remaining -= media.bytes;
                            const embedded = path.join(part, "embedded.srt");
                            let text = "";
                            try {
                                await fs.rm(embedded, { force: true });
                                await runTool(settings.ffmpeg, ["-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", media.path, "-map", "0:s:0", "-c:s", "srt", "-n", embedded], part, signal);
                                text = await fs.readFile(embedded, "utf8");
                                if (!text.trim() || Buffer.byteLength(text) > 4 * 1024 * 1024)
                                    throw new Error("字幕为空或超过限制");
                            }
                            catch {
                                signal.throwIfAborted();
                                text = await transcribe(media.path, part, settings, signal, source.duration_seconds, offset);
                            }
                            transcripts.push(text);
                            offset += (source.duration_seconds || 0) * 1000;
                        }
                        const text = transcripts.join("\n\n"), file = await store.text(context, "transcript", text);
                        assets.push(file);
                        body = `[本地转写](</${file.split('/').map(encodeURIComponent).join('/')}>)\n\n${text}`;
                        checkpointComplete = true;
                        return { properties, assets, body };
                    }
                    const video = existingAssets.find((file) => /\.(?:mp4|m4v|mkv|webm|mov|ogv|mpeg|mpg|mp3|m4a|wav|ogg|oga|flac|opus|aac|3gp|m3u8|ts|flv)$/i.test(file));
                    if (!video) {
                        body = "> 原站未检测到可用音视频，已跳过字幕采集。";
                        return { properties, assets, body };
                    }
                    directory = await store.cache(context);
                    await checkTool("ffmpeg", settings, directory, signal);
                    const target = path.join(directory, "embedded.srt");
                    await runTool(settings.ffmpeg, [
                        "-nostdin",
                        "-hide_banner",
                        "-loglevel",
                        "error",
                        "-protocol_whitelist",
                        "file,pipe",
                        "-i",
                        await store.localFile(video),
                        "-map",
                        "0:s:0",
                        "-c:s",
                        "srt",
                        "-n",
                        target,
                    ], directory, signal);
                    const stat = await fs.stat(target);
                    if (!stat.size || stat.size > 4 * 1024 * 1024)
                        throw new Error("内嵌字幕为空或超过限制");
                    const text = await fs.readFile(target, "utf8"), file = await store.text(context, "embedded-subtitles", text, "srt");
                    assets.push(file);
                    body = `[内嵌字幕](</${file.split('/').map(encodeURIComponent).join('/')}>)`;
                }
            }
            if (feature === "images") {
                const urls = [
                    ...new Set([
                        ...result.content.markdown.matchAll(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g),
                    ].map((m) => m[1]).concat(result.content.image_urls || [])),
                ].slice(0, 100);
                if (platform === "bilibili") {
                    const id = new URL(context.sourceUrl).pathname.match(/\/video\/(BV[A-Za-z0-9]{10}|av\d+)/)?.[1];
                    if (id) {
                        const view = await readPublicJson("https://api.bilibili.com/x/web-interface/view?" +
                            (id.startsWith("BV") ? "bvid=" + id : "aid=" + id.slice(2)), signal);
                        if (view.code === 0 && typeof view.data?.pic === "string")
                            urls.unshift(view.data.pic);
                    }
                }
                if (!urls.length) {
                    // Some Douyin pages expose the media stream but omit both a
                    // poster URL and image markdown. Reuse the completed local
                    // video and derive a stable first-frame cover so the image
                    // feature can still finish without another page request.
                    const existingVideo = existingAssets.find(isLocalVideoAsset);
                    if (existingVideo && !existingAssets.some((file) => AUDIO_ASSET.test(file)))
                        return await saveVideoCover(context, existingVideo, settings, store, signal);
                    body = "> 原站未提供可下载图片，已跳过图片采集。";
                    return { properties, assets, body };
                }
                let failed = 0;
                let remaining = settings.maxBytes;
                for (const [i, url] of urls.entries()) {
                    signal.throwIfAborted();
                    progress(`下载图片 ${i + 1}/${urls.length}`);
                    try {
                        const response = await readPublicImage(url, signal, context.sourceUrl);
                        const bytes = Buffer.from(response.arrayBuffer);
                        const extension = imageExtension(bytes);
                        if (bytes.length > remaining)
                            throw new Error("图片超过本任务下载上限");
                        remaining -= bytes.length;
                        if (!extension ||
                            /html|json/i.test(response.headers["content-type"]))
                            throw new Error("原站未返回图片");
                        if (!directory)
                            directory = await store.cache(context);
                        const target = path.join(directory, `image-${i}.${extension}`);
                        await fs.writeFile(target, bytes, { flag: "wx", mode: 0o600 });
                        const saved = await store.media(context, "image", await fingerprint(target, extension, signal), signal);
                        assets.push(saved);
                    }
                    catch {
                        signal.throwIfAborted();
                        failed++;
                    }
                }
                if (!assets.length)
                    throw new Error("原图全部下载失败");
                body =
                    assets.map((file) => `![原图](</${file.split('/').map(encodeURIComponent).join('/')}>)`).join("\n\n") +
                        (failed ? `\n\n> ${failed} 张图片未能保存，可重试。` : "");
            }
            if (feature === "video" && platform === "xiaoyuzhou") {
                if (!result.media)
                    throw new Error("来源没有公开音频");
                directory = await store.cache(context);
                const media = await downloadPublicMedia(result.media.url, signal, context.sourceUrl, directory, (bytes) => progress(`下载音频 ${(bytes / 1024 / 1024).toFixed(1)} MiB`), {
                    maxBytes: settings.maxBytes,
                    timeoutMs: settings.timeoutMinutes * 60000,
                });
                const file = await store.media(context, "audio", media, signal);
                assets.push(file);
                body = `[音频原件](</${file.split('/').map(encodeURIComponent).join('/')}>)`;
            }
            if (result.content.warnings?.length)
                body +=
                    "\n\n" + result.content.warnings.map((w) => "> " + w).join("\n");
        }
        signal.throwIfAborted();
        return { properties, assets, body };
    }
    finally {
        if (directory)
            await fs.rm(directory, { recursive: true, force: true });
        await mediaProxy?.close();
        if (checkpoint) {
            await fs.rm(path.join(checkpoint, "active.json"), { force: true });
            if (checkpointComplete)
                await fs.rm(checkpoint, { recursive: true, force: true });
        }
    }
}
