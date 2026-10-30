/** Independent public detail fallback. No native resolver, browser cookies, signatures or CAPTCHA handling. */
import { htmlToMarkdown, type ExtractedContent } from "./extract";
import {
  extractSitePage,
  localSite,
  SiteStateUnavailable,
  SiteMediaUnavailable,
  SiteGalleryUnavailable,
  SiteAccessDenied,
  SiteStateConflict,
  type SiteResult,
  douyinWorkId,
} from "./sites";
interface Page {
  html: string;
  url: string;
}
export interface DouyinReaders {
  page(url: string, signal: AbortSignal, mobile?: boolean): Promise<Page>;
  json(url: string, signal: AbortSignal, referer?: string): Promise<unknown>;
}
class DouyinStageTimeout extends Error {}
const unavailable = (error: unknown) =>
  error instanceof SiteStateUnavailable ||
  error instanceof SiteMediaUnavailable ||
  error instanceof SiteGalleryUnavailable;
/** Same-work fallbacks fill missing source attributes only; never merge bodies or media. */
function fillSource(
  current: ExtractedContent,
  previous?: ExtractedContent,
): ExtractedContent {
  if (!previous) return current;
  const result = { ...current };
  for (const field of ["author", "source_date", "source_description"] as const)
    if (!result[field] && previous[field]) result[field] = previous[field];
  if (!result.tags?.length && previous.tags?.length)
    result.tags = previous.tags;
  if (!result.metrics && previous.metrics) result.metrics = previous.metrics;
  if (!result.source_title && previous.source_title) {
    result.source_title = previous.source_title;
    result.title = previous.title;
  }
  const warnings = [
    ...new Set([...(previous.warnings || []), ...(current.warnings || [])]),
  ];
  if (warnings.length) result.warnings = warnings;
  return result;
}
function failedContent(error: unknown): ExtractedContent | undefined {
  return error instanceof SiteMediaUnavailable ||
    error instanceof SiteGalleryUnavailable
    ? error.content
    : undefined;
}
function fillFailure(error: unknown, previous?: ExtractedContent): unknown {
  if (error instanceof SiteMediaUnavailable)
    return new SiteMediaUnavailable(
      error.message,
      error.content ? fillSource(error.content, previous) : previous,
    );
  if (error instanceof SiteGalleryUnavailable)
    return new SiteGalleryUnavailable(
      error.message,
      error.content ? fillSource(error.content, previous) : previous,
      error.authoritativeImages,
    );
  return error;
}
function work(value: string) {
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("抖音作品地址无效");
  if (localSite(value) !== "douyin")
    throw new Error("抖音分享链接跳转到其他来源，未提取正文");
  const parsed = new URL(value),
    match = parsed.pathname.match(
      /^\/(?:share\/)?(video|note|article)\/([1-9]\d{0,19})(?:\/|$)/,
  );
  const id = douyinWorkId(value);
  if (!id) throw new Error("请提供抖音具体作品链接");
  return { kind: match?.[1] === "article" ? "note" : match?.[1] || "video", id };
}
async function bounded<T>(
  signal: AbortSignal,
  milliseconds: number,
  message: string,
  read: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const controller = new AbortController(),
    stop = () => controller.abort(signal.reason);
  signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DouyinStageTimeout(message)),
    milliseconds,
  );
  let rejectStopped!: (reason: unknown) => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectStopped = reject;
  });
  const interrupt = () => rejectStopped(controller.signal.reason);
  controller.signal.addEventListener("abort", interrupt, { once: true });
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return read(controller.signal);
      }),
      interrupted,
    ]);
    controller.signal.throwIfAborted();
    return result;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    controller.signal.removeEventListener("abort", interrupt);
    controller.abort();
  }
}
async function detailPage(
  url: string,
  signal: AbortSignal,
  io: DouyinReaders,
  includeMetrics: boolean,
  original: unknown,
): Promise<SiteResult> {
  const current = work(url);
  let body: SiteResult;
  try {
    const endpoints = [
      `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${current.id}`,
      `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${current.id}&aid=6383&device_platform=webapp`,
      `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${current.id}&aid=1128&device_platform=webapp`,
    ];
    body = await bounded(
      signal,
      30000,
      "抖音公开详情读取超过30秒，请稍后手动重试",
      async (signal) => {
        let lastUnavailable: unknown;
        for (const endpoint of endpoints) {
          const candidate = await io.json(
            endpoint,
            signal,
            "https://www.douyin.com/",
          );
          if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
            continue;
          const payload = candidate as Record<string, unknown>;
          if (
            (typeof payload.verify_url === "string" && payload.verify_url.trim()) ||
            (payload.status_code !== undefined && payload.status_code !== 0)
          ) {
            throw new SiteAccessDenied(
              "抖音详情接口要求验证或未授权，本次停止取数，请在原站核对后手动重试",
            );
          }
          const detail = payload.aweme_detail;
          if (
            !detail ||
            typeof detail !== "object" ||
            Array.isArray(detail)
          )
            continue;
          const value = detail as Record<string, unknown>;
          if (String(value.aweme_id ?? value.awemeId ?? "") !== current.id)
            throw new SiteStateConflict(
              "抖音详情接口返回另一作品，未提取其内容",
            );
          const encoded = JSON.stringify({ aweme_detail: detail }).replace(
            /</g,
            "\\u003c",
          );
          if (Buffer.byteLength(encoded) > 2 * 1024 * 1024) continue;
          const html = `<script type="application/json">${encoded}</script>`;
          try {
            const result = extractSitePage(
              html,
              `https://www.douyin.com/${current.kind}/${current.id}`,
              htmlToMarkdown,
              includeMetrics,
            );
            if (result) return result;
          } catch (error) {
            if (error instanceof SiteAccessDenied || error instanceof SiteStateConflict)
              throw error;
            if (error instanceof SiteStateUnavailable) {
              continue;
            }
            if (unavailable(error)) {
              lastUnavailable = error;
              continue;
            }
            throw error;
          }
        }
        throw lastUnavailable || original;
      },
    );
  } catch (error) {
    signal.throwIfAborted();
    if (
      error instanceof DouyinStageTimeout ||
      error instanceof SiteAccessDenied ||
      error instanceof SiteStateConflict
    )
      throw error;
    if (unavailable(error)) throw error;
    const message = error instanceof Error ? error.message : "";
    if (
      /HTTP (?:401|403|412|429|451)\b|公网|重定向|资源超过|媒体链接|获取链接|未返回有效结构化数据|登录或访问验证/.test(
        message,
      )
    )
      throw new SiteAccessDenied(
        "抖音详情接口访问受限或来源校验未通过，本次停止取数",
      );
    // An optional endpoint outage must not discard known metadata or disable the existing opt-in rendered path.
    throw original;
  }
  signal.throwIfAborted();
  return body;
}
export async function readDouyinPage(
  first: Page,
  signal: AbortSignal,
  io: DouyinReaders,
  includeMetrics = false,
): Promise<SiteResult> {
  signal.throwIfAborted();
  const current = work(first.url);
  let missing: unknown;
  try {
    const result = extractSitePage(
      first.html,
      first.url,
      htmlToMarkdown,
      includeMetrics,
    );
    if (result) return result;
    throw new SiteStateUnavailable("抖音未取得当前作品");
  } catch (error) {
    if (!unavailable(error)) throw error;
    missing = error;
  }
  if (
    !new URL(first.url).hostname.endsWith("iesdouyin.com") &&
    !/^\/share\//.test(new URL(first.url).pathname)
  ) {
    const mobile = await bounded(
      signal,
      45000,
      "抖音移动分享页读取超过45秒，请稍后手动重试",
      (signal) =>
        io.page(
          `https://www.iesdouyin.com/share/${current.kind}/${current.id}/?from_ssr=1`,
          signal,
          true,
        ),
    );
    if (work(mobile.url).id !== current.id)
      throw new Error("抖音移动分享页跳转到其他作品，未提取正文");
    try {
      const result = extractSitePage(
        mobile.html,
        mobile.url,
        htmlToMarkdown,
        includeMetrics,
      );
      if (result)
        return {
          ...result,
          content: fillSource(result.content, failedContent(missing)),
        };
    } catch (error) {
      if (!unavailable(error)) throw error;
      if (
        !(error instanceof SiteStateUnavailable) ||
        missing instanceof SiteStateUnavailable
      )
        missing = fillFailure(error, failedContent(missing));
    }
  }
  try {
    const result = await detailPage(
      first.url,
      signal,
      io,
      includeMetrics,
      missing,
    );
    return {
      ...result,
      content: fillSource(result.content, failedContent(missing)),
    };
  } catch (error) {
    throw fillFailure(error, failedContent(missing));
  }
}
