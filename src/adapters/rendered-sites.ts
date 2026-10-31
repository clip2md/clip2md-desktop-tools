/** Site extraction from a sandboxed page snapshot; browser scheduling lives elsewhere. */
import {
  extractSitePage,
  localSite,
  publicUrl,
  siteAccessRequired,
  assertXiaohongshuAccess,
  xhsDomGallery,
  xhsDomNoteRoot,
  renderSourceGallery,
  SiteMediaUnavailable,
  SiteGalleryUnavailable,
  SiteStateUnavailable,
  SiteStateConflict,
  type SiteResult,
  douyinWorkId,
} from "./sites";
import { htmlToMarkdown } from "./extract";
import type { ExtractedContent } from "./extract";

export interface RenderedVideo {
  src: string;
  visible: boolean;
  playing: boolean;
  area: number;
  identities: string[];
}
export interface RenderedSnapshot {
  url: string;
  html: string;
  videos: RenderedVideo[];
  audios?: RenderedVideo[];
}
export class RenderedAccessRequired extends Error {}
export class RenderedDestinationError extends Error {}
export type RenderedContentKind = "video" | "gallery";
export function isRenderedGallery(...urls: string[]): boolean {
  return urls.some(
    (value) =>
      localSite(value) === "douyin" &&
      /^\/(?:share\/)?note\//.test(new URL(value).pathname),
  );
}
export function mergeSourceMetadata(
  ...sources: Array<ExtractedContent | undefined>
): ExtractedContent | undefined {
  const known = Object.fromEntries(
    sources
      .filter(Boolean)
      .flatMap((source) =>
        Object.entries(source!).filter(
          ([, value]) =>
            value !== undefined &&
            value !== "" &&
            (!Array.isArray(value) || value.length > 0),
        ),
      ),
  );
  const warnings = [
    ...new Set(sources.flatMap((source) => source?.warnings || [])),
  ];
  return Object.keys(known).length
    ? {
        title: "",
        markdown: "",
        ...known,
        ...(warnings.length ? { warnings } : {}),
      }
    : undefined;
}
export function withSourceMetadata(
  result: SiteResult,
  metadata?: ExtractedContent,
): SiteResult {
  if (!metadata) return result;
  const known = Object.fromEntries(
    Object.entries(metadata).filter(
      ([, value]) =>
        value !== undefined &&
        value !== "" &&
        (!Array.isArray(value) || value.length > 0),
    ),
  );
  const valid = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value > 0;
  const before = valid(metadata.duration_seconds)
    ? metadata.duration_seconds
    : undefined;
  const current = valid(result.media?.expectedDurationSeconds)
    ? result.media.expectedDurationSeconds
    : undefined;
  if (
    result.media &&
    before !== undefined &&
    current !== undefined &&
    Math.abs(before - current) > Math.min(30, Math.max(2, before * 0.01))
  )
    throw new SiteStateConflict(
      "动态媒体的来源时长与已有作品信息冲突，未保存不明确的转写输入",
    );
  const duration = current ?? before;
  const warnings = [
    ...new Set([
      ...(metadata.warnings || []),
      ...(result.content.warnings || []),
    ]),
  ];
  return {
    ...result,
    ...(result.media
      ? {
          media: {
            ...result.media,
            ...(duration !== undefined
              ? { expectedDurationSeconds: duration }
              : {}),
          },
        }
      : {}),
    content: {
      ...result.content,
      ...known,
      markdown: result.content.markdown,
      ...(result.media ? { duration_seconds: duration } : {}),
      ...(warnings.length ? { warnings } : {}),
      ...(result.content.requires_image_content
        ? { requires_image_content: true }
        : {}),
      title: metadata.source_title ? metadata.title : result.content.title,
      source_title: metadata.source_title || result.content.source_title,
    },
  };
}
export function siteWorkId(value: string): string | undefined {
  const site = localSite(value);
  if (site === "douyin") return douyinWorkId(value);
  return new URL(value).pathname.match(
    /^\/(?:zh\/)?(?:explore|discovery\/item|(?:share\/)?video|(?:share\/)?note)\/([A-Za-z0-9]+)(?:\/|$)/,
  )?.[1];
}
export function assertRenderedDestination(
  requested: string,
  actual: string,
): void {
  const url = new URL(actual),
    site = localSite(requested);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !site ||
    localSite(actual) !== site
  )
    throw new RenderedDestinationError("动态页面跳转到其他来源，本次停止解析");
  const wanted = siteWorkId(requested),
    current = siteWorkId(actual);
  if (wanted && current && wanted !== current)
    throw new RenderedDestinationError(
      "动态页面跳转到另一具体作品，本次停止解析",
    );
}
export function assertRenderedSnapshot(
  snapshot: RenderedSnapshot,
  requested: string,
): Document {
  assertRenderedDestination(requested, snapshot.url);
  if (
    typeof snapshot.html !== "string" ||
    snapshot.html.length > 8 * 1024 * 1024 ||
    !Array.isArray(snapshot.videos) ||
    snapshot.videos.length > 64
  )
    throw new Error("动态页面快照超过处理范围");
  const document = new DOMParser().parseFromString(snapshot.html, "text/html");
  if (
    siteAccessRequired(snapshot.html) ||
    /^(?:安全验证|访问验证|验证码|请完成验证)(?:\s*[-–—|]\s*(?:抖音|小红书))?$/.test(
      document.title.trim(),
    )
  )
    throw new RenderedAccessRequired(
      "原站要求访问验证，本次停止动态解析；不会自动处理验证码或清除登录信息",
    );
  if (localSite(snapshot.url) === "xiaohongshu") {
    assertXiaohongshuAccess(snapshot.html, snapshot.url);
    if (!siteWorkId(snapshot.url))
      throw new SiteStateUnavailable(
        "动态小红书页面尚未进入具体笔记，不提取首页或推荐内容",
      );
  }
  return document;
}
export function extractRenderedSitePage(
  snapshot: RenderedSnapshot,
  requested: string,
  includeMetrics = false,
  sourceMetadata?: ExtractedContent,
  expectedKind?: RenderedContentKind,
): SiteResult {
  const document = assertRenderedSnapshot(snapshot, requested),
    site = localSite(snapshot.url);
  let existing: SiteResult | undefined;
  let metadata: ExtractedContent | undefined = sourceMetadata;
  const fixedKind = isRenderedGallery(requested, snapshot.url)
    ? "gallery"
    : expectedKind || (sourceMetadata ? "video" : undefined);
  let gallery = fixedKind === "gallery";
  let videoExpected =
    !gallery && (expectedKind === "video" || !!sourceMetadata);
  const preserveMetadata = (result: SiteResult): SiteResult | undefined => {
    if ((gallery && result.media) || (videoExpected && !result.media)) return;
    return withSourceMetadata(result, metadata);
  };
  let selectedHtml = snapshot.html;
  if (document.querySelector("[data-clip2md-live-state]")) {
    const live = document.documentElement.cloneNode(true) as HTMLElement;
    live
      .querySelectorAll("script:not([data-clip2md-live-state])")
      .forEach((node) => node.remove());
    try {
      existing = extractSitePage(
        live.outerHTML,
        snapshot.url,
        htmlToMarkdown,
        includeMetrics,
      );
      if (existing) {
        const result = preserveMetadata(existing);
        if (result) return result;
      }
    } catch (error) {
      if (error instanceof SiteMediaUnavailable) {
        metadata ||= error.content;
        videoExpected = !gallery;
        selectedHtml = live.outerHTML;
      } else if (error instanceof SiteGalleryUnavailable) {
        if (error.authoritativeImages) throw error;
        metadata ||= error.content;
        if (fixedKind !== "video") {
          gallery = true;
          videoExpected = false;
        }
        selectedHtml = live.outerHTML;
      } else if (!(error instanceof SiteStateUnavailable)) throw error;
    }
  }
  try {
    existing = extractSitePage(
      selectedHtml,
      snapshot.url,
      htmlToMarkdown,
      includeMetrics,
    );
  } catch (error) {
    if (
      !(
        error instanceof SiteStateUnavailable ||
        error instanceof SiteMediaUnavailable ||
        error instanceof SiteGalleryUnavailable
      )
    )
      throw error;
    if (error instanceof SiteGalleryUnavailable && error.authoritativeImages)
      throw error;
    if (error instanceof SiteMediaUnavailable) {
      metadata ||= error.content;
      videoExpected = !gallery;
    }
    if (error instanceof SiteGalleryUnavailable) {
      metadata ||= error.content;
      if (fixedKind !== "video") {
        gallery = true;
        videoExpected = false;
      }
    }
  }
  if (existing) {
    const result = preserveMetadata(existing);
    if (result) return result;
  }
  const clean = (value: string) =>
    value
      .trim()
      .replace(/\s*[-–—|]\s*(?:小红书|抖音)(?:\s.*)?$/, "")
      .trim();
  const rawTitle = clean(
    document
      .querySelector('meta[property="og:title"]')
      ?.getAttribute("content") || "",
  );
  const title = /^(?:打开|登录|发现|小红书|抖音|你感兴趣的|记录美好生活)/.test(
    rawTitle,
  )
    ? ""
    : rawTitle;
  if (site === "xiaohongshu" && !videoExpected) {
    const id = siteWorkId(snapshot.url)!;
    const dom = xhsDomGallery(document, snapshot.url, id);
    const root = dom?.root || xhsDomNoteRoot(document, snapshot.url, id);
    const description =
      metadata?.source_description ||
      root
        ?.querySelector("#detail-desc,.note-text,.desc")
        ?.textContent?.trim() ||
      "";
    if (dom || (description.length >= 20 && snapshot.videos.length === 0)) {
      const images = dom?.images || [];
      if (!description && !images.some(Boolean))
        throw new SiteGalleryUnavailable(
          "动态小红书图集尚未提供可用原图，缺图提示不算正文",
          metadata,
        );
      const ownTitle =
        clean(root?.querySelector("#detail-title,.title")?.textContent || "") ||
        title;
      const warnings = [
        ...(metadata?.warnings || []),
        ...(dom
          ? [
              "原站未提供结构化图集，已按页面图集顺序提取，未加载图片可能缺失，请从原文核对",
            ]
          : []),
      ];
      if (images.some((value) => !value))
        warnings.push("部分小红书图片未提供公开地址，请从原文核对缺图");
      return {
        content: {
          ...metadata,
          title: metadata?.title || ownTitle || "小红书笔记",
          source_title: metadata?.source_title || ownTitle,
          source: "小红书",
          markdown: renderSourceGallery(description, images),
          tags: metadata?.tags || [],
          warnings,
          requires_image_content: !description || undefined,
        },
      };
    }
  }
  if (gallery)
    throw new SiteGalleryUnavailable(
      "动态页面尚未提供当前图集原图，不会转写背景音乐",
      metadata,
    );
  if (site !== "xiaohongshu" && site !== "douyin")
    throw new Error("当前动态适配仅用于小红书与抖音");
  const id = siteWorkId(requested);
  const videos = snapshot.videos
    .flatMap((row, index) => {
      const src = publicUrl(row?.src, snapshot.url);
      if (
        !src ||
        !["http:", "https:"].includes(new URL(src).protocol) ||
        !Number.isFinite(row.area) ||
        row.area < 0
      )
        return [];
      const identities = Array.isArray(row.identities)
        ? row.identities.filter((value) => typeof value === "string")
        : [];
      return [
        {
          src,
          index,
          identity: !!id && identities.includes(id),
          playing: row.playing === true,
          visible: row.visible === true,
          area: row.area,
        },
      ];
    })
    .sort(
      (a, b) =>
        Number(b.identity) - Number(a.identity) ||
        Number(b.playing) - Number(a.playing) ||
        Number(b.visible) - Number(a.visible) ||
        b.area - a.area ||
        a.index - b.index,
    );
  if (videos.length)
    return withSourceMetadata(
      {
        content: {
          title:
            title ||
            metadata?.title ||
            `${site === "douyin" ? "抖音" : "小红书"}视频`,
          source_title: title,
          source: site === "douyin" ? "抖音" : "小红书",
          markdown: "",
          tags: [],
        },
        media: {
          url: videos[0].src,
          ...(videos.length > 1
            ? { alternatives: videos.slice(1, 8).map((video) => video.src) }
            : {}),
          referer: snapshot.url,
        },
      },
      metadata,
    );
  throw new SiteStateUnavailable(
    "动态页面尚未提供可读取正文或公开媒体，可能仍在加载或需要登录",
  );
}
