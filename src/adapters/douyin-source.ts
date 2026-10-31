/** Ephemeral identity established by the public reader; never add redirect context to persisted errors or task DTOs. */
import {
  SiteStateUnavailable,
  SiteMediaUnavailable,
  SiteStateConflict,
} from "./sites";
const resolvedVideos = new WeakMap<
  Error,
  { requested: string; canonical: string }
>();
export function canonicalDouyinVideo(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      ![
        "douyin.com",
        "www.douyin.com",
        "iesdouyin.com",
        "www.iesdouyin.com",
      ].includes(url.hostname)
    )
      return;
    const id = url.pathname.match(
      /^\/(?:share\/)?video\/([1-9]\d{0,19})\/?$/,
    )?.[1];
    if (id) return `https://www.douyin.com/video/${id}`;
  } catch {
    /* Invalid/unsupported source cannot enable native processing. */
  }
}
function permittedRequest(value: string): boolean {
  if (canonicalDouyinVideo(value)) return true;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.hostname === "v.douyin.com" &&
      /^\/[A-Za-z0-9_-]{1,128}\/?$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}
export function rememberResolvedDouyinVideo(
  error: unknown,
  requested: string,
  resolved: string,
): void {
  if (
    !(
      error instanceof SiteStateUnavailable ||
      error instanceof SiteMediaUnavailable
    ) ||
    !permittedRequest(requested)
  )
    return;
  resolvedVideos.delete(error);
  const canonical = canonicalDouyinVideo(resolved);
  const expected = canonicalDouyinVideo(requested);
  if (expected && expected !== canonical)
    throw new SiteStateConflict(
      "抖音来源重定向到另一作品或内容类型，未转交本地解析器",
    );
  if (canonical) resolvedVideos.set(error, { requested, canonical });
}
export function nativeDouyinTarget(
  requested: string,
  error: unknown,
): string | undefined {
  if (
    !(
      error instanceof SiteStateUnavailable ||
      error instanceof SiteMediaUnavailable
    ) ||
    !permittedRequest(requested)
  )
    return;
  const context = resolvedVideos.get(error);
  return (
    canonicalDouyinVideo(requested) ||
    (context?.requested === requested ? context.canonical : undefined)
  );
}
