import {
  assertArticleSource,
  extractWebPage,
  htmlToMarkdown,
  type ExtractedContent,
} from "./extract";
import {
  extractSitePage,
  localSite,
  publicUrl,
  sourceMedia,
  sourceMetrics,
  douyinWorkId,
  canonicalDouyinVideoUrl,
  type SiteResult,
} from "./sites";
import { readWebPageResult, readPublicJson, resolvePublicUrl } from "./network";
import { rememberArticlePageFailure } from "./article-browser-source";
import { readWechatArticle, isWechatArticle } from "./wechat-link";
import { readDouyinPage } from "./douyin-link";
import { rememberResolvedDouyinVideo } from "./douyin-source";
import { bilibiliSubtitleMarkdown } from "./bilibili-subtitles";

export interface SiteReaders {
  page(
    url: string,
    signal: AbortSignal,
    mobile?: boolean,
  ): Promise<{ html: string; url: string }>;
  json(url: string, signal: AbortSignal, referer?: string): Promise<any>;
  resolve?(url: string, signal: AbortSignal): Promise<string>;
}
const readers: SiteReaders = {
  page: readWebPageResult,
  json: readPublicJson,
  resolve: resolvePublicUrl,
};
class BilibiliApiUnavailable extends Error {
  constructor(readonly code?: number) {
    super("B站接口未提供公开数据，可能需要登录、权限或稍后重试");
  }
}
const optionalBilibiliFailure = (error: unknown) =>
  error instanceof BilibiliApiUnavailable &&
  [-101, -400, -404].includes(error.code || 0);
function apiData(body: any): any {
  if (!body || body.code !== 0 || !body.data)
    throw new BilibiliApiUnavailable(
      typeof body?.code === "number" ? body.code : undefined,
    );
  return body.data;
}
/** Resolve an Apple Podcasts episode through Apple's public lookup response.
 * The web page is a client-rendered shell and often has no audio element until
 * the user presses play; the lookup keeps episode metadata and the original
 * audio URL available for local capture without scraping the player.
 */
export async function applePodcastsLink(
  url: string,
  signal: AbortSignal,
  io = readers,
  includeMetrics = false,
): Promise<SiteResult> {
  const source = new URL(url), episodeId = source.searchParams.get("i");
  if (!episodeId || !/^\d{1,20}$/.test(episodeId))
    throw new Error("苹果播客需要具体单集链接（URL 中应包含 i 参数）");
  const response = await io.json(
    `https://itunes.apple.com/lookup?entity=podcastEpisode&id=${episodeId}`,
    signal,
    url,
  );
  const row = Array.isArray(response?.results)
    ? response.results.find((item: any) => String(item?.trackId) === episodeId)
    : undefined;
  if (!row) throw new Error("苹果播客未返回指定单集");
  const title = typeof row.trackName === "string" ? row.trackName.trim() : "";
  const media = publicUrl(row.episodeUrl || row.enclosureUrl || row.audioUrl, url);
  if (!title || !media) throw new Error("苹果播客单集未提供公开音频");
  const cover = publicUrl(row.artworkUrl600 || row.artworkUrl160, url);
  const content: ExtractedContent = {
    title,
    source_title: title,
    author: typeof row.artistName === "string" ? row.artistName.trim() : undefined,
    source_date: typeof row.releaseDate === "string" ? row.releaseDate.slice(0, 10) : undefined,
    source_description: typeof row.description === "string" ? row.description : undefined,
    duration_seconds: Number.isFinite(row.trackTimeMillis) && row.trackTimeMillis > 0 ? row.trackTimeMillis / 1000 : undefined,
    metrics: includeMetrics ? sourceMetrics({}) : undefined,
    markdown: cover ? `![封面](${cover})` : "",
    source: "苹果播客",
    tags: [],
  };
  return { content, detectedMedia: "audio", media: { url: media, referer: url } };
}
export async function bilibiliLink(
  url: string,
  signal: AbortSignal,
  io = readers,
  includeMetrics = false,
): Promise<SiteResult> {
  const source = new URL(url),
    match = source.pathname.match(
      /^\/video\/(BV[A-Za-z0-9]{10}|av\d+)(?:\/|$)/,
    );
  if (!match)
    throw new Error("请提供B站具体视频链接，暂不支持合集、番剧或直播");
  const id = match[1],
    query = id.startsWith("BV")
      ? `bvid=${encodeURIComponent(id)}`
      : `aid=${id.slice(2)}`;
  const json = async (target: string) => {
    signal.throwIfAborted();
    const result = await io.json(target, signal, "https://www.bilibili.com/");
    signal.throwIfAborted();
    return result;
  };
  const page = Number(source.searchParams.get("p") || 1);
  if (!Number.isSafeInteger(page) || page < 1)
    throw new Error("B站分P参数无效");
  try {
    const view = apiData(
      await json(`https://api.bilibili.com/x/web-interface/view?${query}`),
    );
    if (
      id.startsWith("BV") ? view.bvid !== id : String(view.aid) !== id.slice(2)
    )
      throw new Error("B站返回的视频身份与原链接不一致");
    if (view.rights?.pay === 1 || view.rights?.pay === true)
      throw new Error("B站视频明确为付费内容，不提取试看内容");
    const segment = Array.isArray(view.pages)
      ? view.pages.find((row: any) => row.page === page)
      : undefined;
    const cid = segment?.cid ?? (page === 1 ? view.cid : undefined);
    if (!Number.isSafeInteger(cid) || cid <= 0)
      throw new Error("未取得B站指定分P");
    const title = typeof view.title === "string" ? view.title.trim() : "";
    if (!title) throw new Error("未取得B站原始标题");
    const content: ExtractedContent = {
      title: page > 1 && segment?.part ? `${title} - ${segment.part}` : title,
      source_title: title,
      metrics: includeMetrics
        ? sourceMetrics({
            views: view.stat?.view,
            likes: view.stat?.like,
            collects: view.stat?.favorite,
            comments: view.stat?.reply,
            shares: view.stat?.share,
            coins: view.stat?.coin,
          })
        : undefined,
      markdown: "",
      source: "B站",
      author:
        typeof view.owner?.name === "string" ? view.owner.name : undefined,
      source_description: typeof view.desc === "string" ? view.desc : undefined,
      tags: [],
      duration_seconds:
        typeof segment?.duration === "number" &&
        Number.isFinite(segment.duration) &&
        segment.duration > 0
          ? segment.duration
          : undefined,
    };
    if (
      typeof view.pubdate === "number" &&
      view.pubdate > 0 &&
      view.pubdate * 1000 <= Date.now()
    )
      content.source_date = new Date(view.pubdate * 1000).toLocaleDateString(
        "en-CA",
        { timeZone: "Asia/Shanghai" },
      );
    let player: any = {};
    try {
      player = apiData(
        await json(`https://api.bilibili.com/x/player/v2?${query}&cid=${cid}`),
      );
    } catch (error) {
      signal.throwIfAborted();
      if (!optionalBilibiliFailure(error)) throw error;
      content.warnings = ["原站字幕接口暂不可用，已改用公开媒体进行本地提取"];
    }
    if (player.cid !== undefined && player.cid !== cid)
      throw new Error("B站字幕分P身份不一致");
    const subtitles = Array.isArray(player.subtitle?.subtitles)
      ? player.subtitle.subtitles.filter(
          (row: any) => row && typeof row === "object",
        )
      : [];
    const ordered = [...subtitles].sort(
      (a, b) =>
        Number(/^zh|^ai-zh/.test(b.lan)) - Number(/^zh|^ai-zh/.test(a.lan)),
    );
    for (const subtitle of ordered.slice(0, 3)) {
      signal.throwIfAborted();
      const target = publicUrl(subtitle.subtitle_url, url);
      if (!target) continue;
      try {
        const payload = await json(target);
        const markdown = bilibiliSubtitleMarkdown(
          payload,
          content.duration_seconds,
        );
        if (markdown) {
          content.markdown = markdown;
          content.transcription_source = "bilibili_subtitles";
          return { content };
        }
        const warning =
          "原站部分字幕时间轴或内容无效，已跳过并尝试其他字幕或公开媒体";
        content.warnings = [...new Set([...(content.warnings || []), warning])];
      } catch {
        signal.throwIfAborted(); /* Try the next advertised subtitle, then public media. */
      }
    }
    const selectMedia = (play: any): SiteResult["media"] => {
      if (play.cid !== undefined && play.cid !== cid)
        throw new Error("B站媒体分P身份不一致");
      if (play.is_preview || play.is_drm)
        throw new Error("B站返回试看或受保护媒体，不作为完整转写输入");
      const audio = Array.isArray(play.dash?.audio)
        ? [...play.dash.audio].sort(
            (a, b) => (a?.bandwidth || 0) - (b?.bandwidth || 0),
          )
        : [];
      const addresses = audio.flatMap((row) => [
        row?.baseUrl || row?.base_url,
        ...(Array.isArray(row?.backupUrl ?? row?.backup_url)
          ? (row.backupUrl ?? row.backup_url)
          : []),
      ]);
      const audioMedia = sourceMedia(addresses, url);
      if (audioMedia)
        return {
          ...audioMedia,
          ...(content.duration_seconds
            ? { expectedDurationSeconds: content.duration_seconds }
            : {}),
        };
      if (Array.isArray(play.durl) && play.durl.length > 1) {
        if (play.durl.length > 32)
          throw new Error("B站媒体超过32段本地处理限制");
        const hasOrder = play.durl.some((row: any) => row?.order !== undefined);
        const parts: NonNullable<NonNullable<SiteResult["media"]>["parts"]> =
          play.durl.map((row: any, index: number) => {
            if (hasOrder && row?.order !== index + 1)
              throw new Error("B站媒体分段顺序不连续，未提取部分内容");
            if (
              typeof row?.length !== "number" ||
              !Number.isFinite(row.length) ||
              row.length <= 0
            )
              throw new Error("B站媒体分段时长不完整");
            if (
              row.size !== undefined &&
              (!Number.isSafeInteger(row.size) || row.size <= 0)
            )
              throw new Error("B站媒体分段大小无效");
            const source = sourceMedia(
              [
                row.url,
                ...(Array.isArray(row.backup_url) ? row.backup_url : []),
              ],
              url,
            );
            if (!source) throw new Error("B站媒体缺少完整分段地址");
            return {
              ...source,
              duration_seconds: row.length / 1000,
              ...(row.size === undefined ? {} : { bytes: row.size }),
            };
          });
        const milliseconds = parts.reduce(
          (total, part) => total + part.duration_seconds * 1000,
          0,
        );
        if (
          play.timelength !== undefined &&
          (typeof play.timelength !== "number" ||
            !Number.isFinite(play.timelength) ||
            Math.abs(play.timelength - milliseconds) > 1000)
        )
          throw new Error("B站媒体总时长与分段不符");
        const bytes = parts.every((part) => part.bytes !== undefined)
          ? parts.reduce((total, part) => total + part.bytes!, 0)
          : undefined;
        if (bytes !== undefined && !Number.isSafeInteger(bytes))
          throw new Error("B站媒体总大小无效");
        return {
          url: parts[0].url,
          referer: url,
          parts,
          ...(bytes === undefined ? {} : { bytes }),
        };
      }
      if (play.durl?.length === 1)
        addresses.push(
          play.durl[0]?.url,
          ...(Array.isArray(play.durl[0]?.backup_url)
            ? play.durl[0].backup_url
            : []),
        );
      const media = sourceMedia(addresses, url);
      return media
        ? {
            ...media,
            ...(content.duration_seconds
              ? { expectedDurationSeconds: content.duration_seconds }
              : {}),
          }
        : undefined;
    };
    let media: SiteResult["media"];
    try {
      media = selectMedia(
        apiData(
          await json(
            `https://api.bilibili.com/x/player/playurl?${query}&cid=${cid}&fnval=16&qn=16`,
          ),
        ),
      );
    } catch (error) {
      signal.throwIfAborted();
      if (!optionalBilibiliFailure(error)) throw error;
    }
    if (!media)
      media = selectMedia(
        apiData(
          await json(
            `https://api.bilibili.com/x/player/playurl?${query}&cid=${cid}&fnval=0&qn=16`,
          ),
        ),
      );
    if (!media)
      throw new Error("B站无公开字幕或可下载音轨，暂不支持此视频的本地解析");
    return { content, media };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Error && /HTTP 412/.test(error.message))
      throw new Error(
        "B站原站访问受限（HTTP 412），请稍后重试；无需重新绑定账号",
      );
    throw error;
  }
}

/** Resolve a Bilibili Opus post as article/gallery content.
 * Opus pages are rendered articles and do not have a BV id, so routing them
 * through the video API produces the misleading “具体视频链接” failure.
 */
export async function bilibiliOpusLink(
  url: string,
  signal: AbortSignal,
  io = readers,
  includeMetrics = false,
): Promise<SiteResult> {
  const page = await io.page(url, signal);
  signal.throwIfAborted();
  if (localSite(page.url) !== "bilibili" || !/^\/opus\/[A-Za-z0-9]+(?:\/|$)/.test(new URL(page.url).pathname))
    throw new Error("B站 Opus 页面跳转到其他来源，未提取正文");
  const document = new DOMParser().parseFromString(page.html, "text/html");
  const title = document.querySelector(".opus-module-title__text")?.textContent?.trim() ||
    document.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim() ||
    document.title.trim();
  const body = document.querySelector(".opus-module-content") || document.querySelector("main,article");
  if (!title || !body) throw new Error("B站 Opus 未取得正文内容");
  const markdown = htmlToMarkdown(body.innerHTML, page.url).trim();
  if (!markdown) throw new Error("B站 Opus 未取得可读取正文");
  const images = [...new Set(
    [...markdown.matchAll(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g)].map((match) => match[1]),
  )];
  const author = document.querySelector(".opus-module-author__name")?.textContent?.trim() || undefined;
  const published = document.querySelector(".opus-module-author__pub__text")?.textContent?.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  const sourceDate = published
    ? `${published[1]}-${published[2].padStart(2, "0")}-${published[3].padStart(2, "0")}`
    : undefined;
  return {
    content: {
      title,
      source_title: title,
      source: "B站",
      markdown,
      author,
      source_date: sourceDate,
      ...(images.length ? { image_urls: images } : {}),
      ...(includeMetrics ? { metrics: sourceMetrics({}) } : {}),
    },
  };
}

/** The final redirect URL determines the adapter, including ordinary share links. */
export async function resolveSiteLink(
  url: string,
  signal: AbortSignal,
  includeMetrics = false,
  io = readers,
  feishu?: (
    url: string,
    signal: AbortSignal,
  ) => Promise<ExtractedContent | undefined>,
): Promise<SiteResult> {
  signal.throwIfAborted();
  assertArticleSource(url);
  // A v.douyin.com share URL has no work id of its own. Resolve its redirect
  // first so the rest of the pipeline can use the ordinary `/video/{id}` URL;
  // retain the request-bound mapping if the canonical reader later fails.
  if (localSite(url) === "douyin" && !douyinWorkId(url) && io.resolve) {
    let canonical: string | undefined;
    try {
      canonical = canonicalDouyinVideoUrl(await io.resolve(url, signal));
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof Error && error.message.includes("另一作品"))
        throw error;
      // Keep the existing page reader as a fallback when a short-link
      // redirect is temporarily unavailable.
    }
    if (canonical) {
      try {
        return await resolveSiteLink(canonical, signal, includeMetrics, io, feishu);
      } catch (error) {
        rememberResolvedDouyinVideo(error, url, canonical);
        throw error;
      }
    }
  }
  if (isWechatArticle(url))
    return {
      content: await readWechatArticle(url, signal, io.page, includeMetrics),
    };
  if (localSite(url) === "feishu" && feishu) {
    const content = await feishu(url, signal);
    signal.throwIfAborted();
    if (content) return { content };
  }
  if (localSite(url) === "bilibili" && new URL(url).hostname !== "b23.tv")
    return /^\/opus\/[A-Za-z0-9]+(?:\/|$)/.test(new URL(url).pathname)
      ? bilibiliOpusLink(url, signal, io, includeMetrics)
      : bilibiliLink(url, signal, io, includeMetrics);
  const page = await io.page(url, signal);
  signal.throwIfAborted();
  assertArticleSource(page.url);
  const requestedSite = localSite(url),
    resolvedSite = localSite(page.url);
  if (requestedSite && requestedSite !== resolvedSite)
    throw new Error("站点分享链接跳转到其他来源，未提取正文");
  const workId = (value: string) =>
    localSite(value) === "douyin"
      ? douyinWorkId(value)
      : new URL(value).pathname.match(
      /\/(?:explore|discovery\/item|video|note|episode|docx|docs)\/([A-Za-z0-9]+)(?:\/|$)/,
    )?.[1];
  if (
    requestedSite &&
    workId(url) &&
    workId(page.url) &&
    workId(url) !== workId(page.url)
  )
    throw new Error("原站跳转到另一具体作品，未提取其内容");
  if (page.url !== url && resolvedSite === "feishu" && feishu) {
    const content = await feishu(page.url, signal);
    signal.throwIfAborted();
    if (content) return { content };
  }
  if (localSite(page.url) === "bilibili")
    return /^\/opus\/[A-Za-z0-9]+(?:\/|$)/.test(new URL(page.url).pathname)
      ? bilibiliOpusLink(page.url, signal, io, includeMetrics)
      : bilibiliLink(page.url, signal, io, includeMetrics);
  if (isWechatArticle(page.url))
    return {
      content: await readWechatArticle(
        page.url,
        signal,
        io.page,
        includeMetrics,
        page,
      ),
    };
  if (resolvedSite === "douyin")
    return readDouyinPage(page, signal, io, includeMetrics).catch((error) => {
      signal.throwIfAborted();
      rememberResolvedDouyinVideo(error, url, page.url);
      throw error;
    });
  const result = extractSitePage(
    page.html,
    page.url,
    htmlToMarkdown,
    includeMetrics,
  );
  if (result) return result;
  try {
    return { content: extractWebPage(page.html, page.url, { includeMetrics }) };
  } catch (error) {
    rememberArticlePageFailure(error, url, page.url);
    throw error;
  }
}
