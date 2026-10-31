/** Two public request profiles, one logical article attempt. No login or browser session. */
import {
  ArticleBodyUnavailable,
  extractWebPage,
  type ExtractedContent,
} from "./extract";
import { WechatAccessError, wechatAccessError } from "./wechat-access";
export interface ArticlePage {
  html: string;
  url: string;
}
export type ArticleReader = (
  url: string,
  signal: AbortSignal,
  mobile?: boolean,
) => Promise<ArticlePage>;
export function isWechatArticle(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.hostname === "mp.weixin.qq.com" &&
      /^\/s(?:\/|$)/.test(url.pathname)
    );
  } catch {
    return false;
  }
}
function identity(value: string): { kind: string; value: string } | undefined {
  const url = new URL(value),
    path = url.pathname.match(/^\/s\/([A-Za-z0-9_-]+)\/?$/);
  if (path) return { kind: "path", value: path[1] };
  const query = ["__biz", "mid", "idx"].map((key) => url.searchParams.get(key));
  if (query.every((value) => !!value))
    return { kind: "query", value: JSON.stringify(query) };
}
function destination(requested: string, actual: string): void {
  const target = new URL(actual);
  if (
    ["https:", "http:"].includes(target.protocol) &&
    !target.username &&
    !target.password &&
    target.hostname === "mp.weixin.qq.com" &&
    /^\/mp\/wappoc_appmsgcaptcha(?:\/|$)/.test(target.pathname)
  )
    throw new WechatAccessError("verification");
  if (!isWechatArticle(actual))
    throw new Error("公众号跳转后不是公开文章地址，未读取其他来源");
  const original = identity(requested),
    resolved = identity(actual);
  if (
    original &&
    resolved &&
    original.kind === resolved.kind &&
    original.value !== resolved.value
  )
    throw new Error("公众号跳转到另一具体文章，未提取其正文");
}
function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", stop, { once: true });
  });
}
export async function readWechatArticle(
  url: string,
  signal: AbortSignal,
  reader: ArticleReader,
  includeMetrics = false,
  firstPage?: ArticlePage,
): Promise<ExtractedContent> {
  signal.throwIfAborted();
  if (!isWechatArticle(url))
    throw new Error("仅支持公众号图文文章链接，请提供原文地址");
  const controller = new AbortController(),
    stop = () => controller.abort(signal.reason);
  signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(new Error("公众号公开页面读取超过90秒，请稍后手动重试")),
    90000,
  );
  let rejectStopped!: (reason: unknown) => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectStopped = reject;
  });
  const interrupt = () => rejectStopped(controller.signal.reason);
  controller.signal.addEventListener("abort", interrupt, { once: true });
  void interrupted.catch(() => undefined);
  const read = async (mobile: boolean) => {
    controller.signal.throwIfAborted();
    const page = await Promise.race([
      Promise.resolve().then(() => reader(url, controller.signal, mobile)),
      interrupted,
    ]);
    controller.signal.throwIfAborted();
    destination(url, page.url);
    return page;
  };
  try {
    const started = Date.now(),
      desktop = firstPage || (await read(false));
    destination(url, desktop.url);
    try {
      return extractWebPage(desktop.html, desktop.url, { includeMetrics });
    } catch (error) {
      let access = error;
      if (error instanceof ArticleBodyUnavailable)
        access = wechatAccessError(
          new DOMParser().parseFromString(desktop.html, "text/html"),
        );
      if (
        !(access instanceof WechatAccessError) ||
        !["guide", "empty"].includes(access.kind)
      )
        throw access;
    }
    // Avoid immediately doubling source traffic when a page is just a guide/shell.
    await Promise.race([
      delay(Math.max(0, 2000 - (Date.now() - started)), controller.signal),
      interrupted,
    ]);
    const mobile = await read(true);
    return extractWebPage(mobile.html, mobile.url, { includeMetrics });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    controller.signal.removeEventListener("abort", interrupt);
    controller.abort();
  }
}
