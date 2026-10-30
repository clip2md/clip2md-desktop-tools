/** An in-memory binding to an already fetched public article, never a task/receipt field. */
import {
  ArticleBodyUnavailable,
  ArticleAccessRequired,
  assertArticleSource,
  extractWebPage,
  type ExtractedContent,
} from "./extract";
import { localSite } from "./sites";
import type { RenderedSnapshot } from "./rendered-sites";
const failures = new WeakMap<Error, { requested: string; resolved: string }>();
export function isGenericArticleUrl(value: string): boolean {
  try {
    const url = new URL(value);
    assertArticleSource(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !localSite(value) &&
      url.hostname !== "mp.weixin.qq.com"
    );
  } catch {
    return false;
  }
}
export function rememberArticlePageFailure(
  error: unknown,
  requested: string,
  resolved: string,
): void {
  if (
    error instanceof ArticleBodyUnavailable &&
    isGenericArticleUrl(requested) &&
    isGenericArticleUrl(resolved)
  )
    failures.set(error, { requested, resolved });
}
export function articleBrowserSource(
  error: unknown,
  requested: string,
): string | undefined {
  if (!(error instanceof ArticleBodyUnavailable)) return;
  const value = failures.get(error);
  return value?.requested === requested ? value.resolved : undefined;
}
export function assertArticleBrowserDestination(
  requested: string,
  actual: string,
): void {
  if (
    !isGenericArticleUrl(requested) ||
    !isGenericArticleUrl(actual) ||
    new URL(requested).origin !== new URL(actual).origin
  )
    throw new ArticleAccessRequired("动态网页跳转到其他来源，本次停止解析");
  if (/^\/(?:login|signin|sign-in)(?:\/|$)/i.test(new URL(actual).pathname))
    throw new ArticleAccessRequired("原站要求登录，本次停止动态解析");
}
export function extractRenderedArticle(
  snapshot: RenderedSnapshot,
  requested: string,
  includeMetrics = false,
): ExtractedContent {
  assertArticleBrowserDestination(requested, snapshot.url);
  if (
    typeof snapshot.html !== "string" ||
    snapshot.html.length > 8 * 1024 * 1024 ||
    !Array.isArray(snapshot.videos) ||
    snapshot.videos.length > 64
  )
    throw new Error("动态网页快照超过处理范围");
  return extractWebPage(snapshot.html, snapshot.url, { includeMetrics });
}
