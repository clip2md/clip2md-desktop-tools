/** Independently implemented public-page adapters. No cookies, paid provider or page evaluation. */
import { publicPageStates, records } from "./site-state";
import type { ExtractedContent } from "./extract";
import type { MetricSnapshot, MetricKey } from "../note-properties";
import { nowBeijingDateTime } from "../date-format";

export type LocalSite =
  | "xiaohongshu"
  | "douyin"
  | "xiaoyuzhou"
  | "bilibili"
  | "feishu";
export interface SiteMediaSource {
  url: string;
  referer: string;
  bytes?: number;
  alternatives?: string[];
  alternativeDecryptKeys?: Array<string | undefined>;
  expectedDurationSeconds?: number;
  decryptKey?: string;
}
export interface SiteResult {
  detectedMedia?: "audio" | "video";
  content: ExtractedContent;
  media?: SiteMediaSource & {
    parts?: Array<SiteMediaSource & { duration_seconds: number }>;
  };
}
export class SiteStateUnavailable extends Error {}
export class SiteAccessDenied extends Error {}
export class SiteContentUnavailable extends Error {}
export class SiteStateConflict extends Error {}
export class SiteGalleryUnavailable extends Error {
  constructor(
    message: string,
    readonly content?: ExtractedContent,
    readonly authoritativeImages = false,
  ) {
    super(message);
  }
}
export class SiteMediaUnavailable extends Error {
  constructor(
    message: string,
    readonly content?: ExtractedContent,
  ) {
    super(message);
  }
}
export function siteAccessRequired(html: string): boolean {
  const document = new DOMParser().parseFromString(html, "text/html");
  document
    .querySelectorAll("script,style,noscript")
    .forEach((node) => node.remove());
  const controls = Array.from(
    document.querySelectorAll('input[name="captcha"],iframe[src*="captcha"]'),
  ).some(
    (node) =>
      !node.closest(
        '[hidden],[style*="display: none"],[style*="display:none"]',
      ),
  );
  return (
    controls ||
    /^(?:请(?:完成|进行)(?:安全)?验证|安全验证|访问环境异常|滑块验证)[\s\S]{0,120}$/.test(
      document.body.textContent?.replace(/\s+/g, " ").trim() || "",
    )
  );
}
export function localSite(value: string): LocalSite | undefined {
  const host = new URL(value).hostname.toLowerCase();
  const belongs = (domain: string) =>
    host === domain || host.endsWith("." + domain);
  if (
    belongs("xiaohongshu.com") ||
    belongs("rednote.com") ||
    belongs("xhslink.com") ||
    belongs("xhslink.cn")
  )
    return "xiaohongshu";
  if (belongs("douyin.com") || belongs("iesdouyin.com")) return "douyin";
  if (belongs("xiaoyuzhoufm.com")) return "xiaoyuzhou";
  if (belongs("bilibili.com") || host === "b23.tv") return "bilibili";
  if (belongs("feishu.cn") || belongs("larksuite.com")) return "feishu";
}
/** Extract a Douyin work identity from canonical, share, or modal URLs. */
export function douyinWorkId(value: string): string | undefined {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      !(
        host === "douyin.com" ||
        host.endsWith(".douyin.com") ||
        host === "iesdouyin.com" ||
        host.endsWith(".iesdouyin.com")
      )
    )
      return;
    const pathId = url.pathname.match(
      /^\/(?:share\/)?(?:video|note|article)\/([1-9]\d{0,19})(?:\/|$)/,
    )?.[1];
    const queryId = url.searchParams.get("modal_id") || url.searchParams.get("aweme_id");
    return pathId || (/^[1-9]\d{0,19}$/.test(queryId || "") ? queryId! : undefined);
  } catch {
    return;
  }
}
/** Use the canonical video route for tools and page APIs that do not accept modal links. */
export function canonicalDouyinVideoUrl(value: string): string | undefined {
  const id = douyinWorkId(value);
  if (!id) return;
  try {
    const path = new URL(value).pathname;
    return /^\/(?:share\/)?(?:note|article)\//.test(path)
      ? `https://www.douyin.com/note/${id}`
      : `https://www.douyin.com/video/${id}`;
  } catch { return; }
}
export function publicUrl(value: unknown, base: string): string | undefined {
  if (typeof value !== "string" || !value.trim()) return;
  try {
    const url = new URL(value, base);
    if (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    )
      return url.href;
  } catch {
    /* Invalid public source. */
  }
}
const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";
const escape = (value: string) => value.replace(/[\\`*_[\]<>]/g, "\\$&");
/** Classify explicit source restrictions without exposing source messages or assuming a landing page means deletion. */
export function assertXiaohongshuAccess(html: string, url: string): void {
  if (siteAccessRequired(html))
    throw new SiteAccessDenied(
      "小红书原站要求访问验证，本次停止取数，请在浏览器核对后手动重试",
    );
  const document = new DOMParser().parseFromString(html, "text/html");
  document
    .querySelectorAll('script,style,noscript,[hidden],[aria-hidden="true"]')
    .forEach((node) => node.remove());
  const visible = document.body.textContent?.replace(/\s+/g, " ").trim() || "";
  if (
    /^\/(?:login|signin|auth)(?:\/|$)/i.test(new URL(url).pathname) ||
    /^(?:请先登录|请登录后查看|登录后查看|登录后继续访问)(?:[，。！!：:\s][\s\S]{0,100})?$/.test(
      visible,
    )
  )
    throw new SiteAccessDenied(
      "小红书原站要求登录，本次停止取数；请在浏览器核对原链接，不需要重新绑定Clip2MD",
    );
  if (
    /^(?:笔记不存在|该笔记不存在|该笔记已被删除|笔记已删除|内容不存在|该内容已被删除|该内容暂时无法访问)(?:[，。！!：:\s][\s\S]{0,100})?$/.test(
      visible,
    )
  )
    throw new SiteContentUnavailable(
      "小红书原站明确提示笔记不可用，本次未保存正文；请在浏览器核对原链接",
    );
}
function date(value: unknown, milliseconds: boolean): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return;
  const parsed = new Date(milliseconds ? value : value * 1000);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.getUTCFullYear() < 2000 ||
    parsed.getTime() > Date.now() + 86400000
  )
    return;
  return parsed.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}
function noteImage(image: any, base: string): string | undefined {
  if (!image || typeof image !== "object") return;
  const rows = image.infoList ?? image.info_list,
    info = Array.isArray(rows) ? rows : [];
  // Choose one representation per source image; never append thumbnails as extra pages.
  for (const value of [
    image.original,
    image.urlSizeLarge,
    image.url_size_large,
    image.urlDefault,
    image.url_default,
    image.url,
    info.find(
      (item: any) => (item?.imageScene ?? item?.image_scene) === "WB_DFT",
    )?.url,
    ...info.map((item: any) => item?.url),
    image.urlPre,
    image.url_pre,
  ]) {
    const url = publicUrl(value, base);
    if (url) return url;
  }
}
function xhsPageIdentityMatches(
  document: Document,
  base: string,
  id: string,
): boolean {
  const identities = Array.from(
    document.querySelectorAll('link[rel="canonical"],meta[property="og:url"]'),
  )
    .map((node) => node.getAttribute("href") || node.getAttribute("content"))
    .filter((value): value is string => !!value);
  // An exact current-note state does not justify borrowing another page's cover.
  return !identities.some((value) => {
    const target = publicUrl(value, base);
    if (!target) return true;
    const parsed = new URL(target);
    return (
      localSite(target) !== "xiaohongshu" ||
      parsed.pathname.match(
        /^\/(?:zh\/)?(?:explore|discovery\/item)\/([a-f0-9]{24})(?:\/|$)/i,
      )?.[1] !== id
    );
  });
}
export function xhsDomNoteRoot(
  document: Document,
  base: string,
  id: string,
): Element | undefined {
  if (!xhsPageIdentityMatches(document, base, id)) return;
  const candidates = Array.from(
    document.querySelectorAll(
      "#noteContainer,.note-container,.note-detail,.note-content",
    ),
  ).filter((root) => !root.closest('[hidden],[aria-hidden="true"]'));
  const roots = candidates.filter(
    (root) =>
      !candidates.some((other) => other !== root && other.contains(root)),
  );
  const bound = roots.filter(
    (root) => root.getAttribute("data-note-id") === id,
  );
  const root =
    bound.length === 1 ? bound[0] : roots.length === 1 ? roots[0] : undefined;
  if (
    !root ||
    (root.hasAttribute("data-note-id") &&
      root.getAttribute("data-note-id") !== id)
  )
    return;
  return root;
}
/** Select one image representation per source slide, never avatars or recommendations. */
export function xhsDomGallery(
  document: Document,
  base: string,
  id: string,
): { root: Element; images: Array<string | undefined> } | undefined {
  const root = xhsDomNoteRoot(document, base, id);
  if (!root) return;
  const containers = Array.from(
    root.querySelectorAll(".note-slider,.swiper-wrapper"),
  ).filter(
    (node) =>
      !node.closest(
        ".comments-container,.recommend-container,.recommendations,aside,nav",
      ),
  );
  const galleries = containers.filter(
    (node) =>
      !containers.some((other) => other !== node && other.contains(node)),
  );
  if (galleries.length !== 1) return;
  const belongs = (node: Element) => {
    const owner = node.closest("[data-note-id]");
    return (
      (!owner || owner.getAttribute("data-note-id") === id) &&
      !node.closest(
        ".swiper-slide-duplicate,.comments-container,.recommend-container,.recommendations,aside,nav",
      )
    );
  };
  const slides = Array.from(
    galleries[0].querySelectorAll(".swiper-slide"),
  ).filter(belongs);
  const items = slides.length
    ? slides
    : Array.from(galleries[0].querySelectorAll("img")).filter(belongs);
  if (!items.length) return;
  if (items.length > 64)
    throw new SiteGalleryUnavailable(
      "小红书页面图集超过64张处理范围，未截断保存",
    );
  const slots = items.map((item) => {
    const node =
      item.tagName === "IMG"
        ? item
        : Array.from(item.querySelectorAll("img")).find(belongs);
    if (!node) return;
    // Lazy source wins over placeholder src; alternatives remain one logical image.
    for (const attribute of ["data-original", "data-src", "src"]) {
      const value = node.getAttribute(attribute) || "";
      if (!/^(?:https?:)?\/\//i.test(value.trim())) continue;
      const target = publicUrl(value, base);
      if (target) return target;
    }
  });
  if (slides.some((slide) => slide.hasAttribute("data-swiper-slide-index"))) {
    const ordered: Array<string | undefined> = [],
      seen = new Set<number>();
    slides.forEach((slide, index) => {
      const value = slide.getAttribute("data-swiper-slide-index") || "";
      if (!/^(?:0|[1-9]\d?)$/.test(value) || Number(value) >= 64)
        throw new SiteGalleryUnavailable(
          "小红书页面图集序号不完整或超出范围，未猜测图片顺序",
        );
      const position = Number(value);
      if (seen.has(position))
        throw new SiteGalleryUnavailable(
          "小红书页面图集序号冲突，未猜测图片顺序",
        );
      seen.add(position);
      ordered[position] = slots[index];
    });
    return { root, images: Array.from(ordered) };
  }
  return { root, images: slots };
}
/** An explicitly advertised page cover is partial evidence, never a complete gallery. */
function xhsPageCover(
  document: Document,
  base: string,
  id: string,
): string | undefined {
  if (!xhsPageIdentityMatches(document, base, id)) return;
  for (const selector of [
    'meta[property="og:image"]',
    'meta[name="twitter:image"]',
    'meta[property="twitter:image"]',
  ]) {
    const urls = [
      ...new Set(
        Array.from(document.querySelectorAll(selector))
          .map((node) => {
            const value = node.getAttribute("content") || "";
            return /^(?:https?:)?\/\//i.test(value.trim())
              ? publicUrl(value, base)
              : undefined;
          })
          .filter((value): value is string => !!value),
      ),
    ];
    if (urls.length === 1) return urls[0];
    if (urls.length > 1) return; // Conflicting covers are not an ordered gallery.
  }
}
/** Keep source positions when an image is unavailable; numbering must not silently close a missing page. */
export function renderSourceGallery(
  description: string,
  slots: Array<string | undefined>,
): string {
  const seen = new Set<string>(),
    parts: string[] = [escape(description)];
  slots.forEach((url, index) => {
    if (!url) {
      parts.push(`> 第 ${index + 1} 张图片未取得公开地址，请从原文核对。`);
      return;
    }
    if (seen.has(url)) return;
    seen.add(url);
    parts.push(`![原图 ${index + 1}](<${url.replace(/>/g, "%3E")}>)`);
  });
  return parts.filter(Boolean).join("\n\n");
}
function addressList(value: any): unknown[] {
  const urls = value?.url_list ?? value?.urlList;
  return typeof value === "string"
    ? [value]
    : [...(Array.isArray(urls) ? urls : []), value?.url, value?.src];
}
function firstAddress(values: unknown[], base: string): string | undefined {
  // Source media lists contain absolute CDN addresses, never page-relative routes.
  return values
    .filter(
      (value): value is string =>
        typeof value === "string" && /^(?:https?:)?\/\//i.test(value.trim()),
    )
    .map((value) => publicUrl(value, base))
    .find((value) => !!value);
}
function xhsVideoSource(
  note: Record<string, any>,
  base: string,
): SiteMediaSource | undefined {
  const video = note.video ?? note.videoInfo ?? note.video_info,
    stream = video?.media?.stream;
  const durations = new Map<string, number>(),
    conflicts = new Set<string>();
  const priority = ["h264", "h265", "av1", "h266"];
  const entries =
    stream && typeof stream === "object" && !Array.isArray(stream)
      ? Object.entries(stream)
      : [];
  const rowScore = (row: any) => {
    const format = String(row?.format || "").toLowerCase();
    const hasAudio = Number(row?.audioDuration || row?.audio_duration || 0) > 0 ||
      Number(row?.audioBitrate || row?.audio_bitrate || 0) > 0 ||
      !!row?.audioCodec || !!row?.audio_codec;
    const isPlayableMp4 = format === "mp4" || /\.mp4(?:[?#]|$)/i.test(String(row?.masterUrl || row?.master_url || ""));
    // XHS advertises silent fMP4 (m4s) representations before the muxed MP4.
    // Prefer a representation with audio and a browser/FFmpeg-friendly MP4.
    return (hasAudio ? 1000 : 0) + (isPlayableMp4 ? 200 : 0) +
      (row?.defaultStream === 1 || row?.default_stream === 1 ? 20 : 0) +
      Math.min(10, Number(row?.weight || 0) / 10);
  };
  entries.sort(([a, rowsA], [b, rowsB]) => {
    const best = (rows: any) => (Array.isArray(rows) ? Math.max(0, ...rows.slice(0, 64).map(rowScore)) : 0);
    return best(rowsB) - best(rowsA) ||
      (priority.includes(a) ? priority.indexOf(a) : priority.length) -
      (priority.includes(b) ? priority.indexOf(b) : priority.length);
  });
  const groups = entries
    .slice(0, 16)
    .map(([, rows]) => {
      const orderedRows = Array.isArray(rows)
        ? rows.slice(0, 64).sort((a, b) => rowScore(b) - rowScore(a))
        : [];
      const addresses = orderedRows.flatMap((row) => {
          const addresses = [
            row?.masterUrl,
            row?.master_url,
            row?.playUrl,
            row?.play_url,
            row?.url,
            ...(Array.isArray(row?.backupUrls) ? row.backupUrls : []),
            ...(Array.isArray(row?.backup_urls) ? row.backup_urls : []),
            ...(Array.isArray(row?.urlList) ? row.urlList : []),
            ...(Array.isArray(row?.url_list) ? row.url_list : []),
          ];
          // Source stream duration is milliseconds and belongs to this
          // representation's advertised URLs, not a cover or recommended item.
          const rawDuration = row?.duration ?? row?.videoDuration ?? row?.video_duration;
          if (typeof rawDuration === "number" && Number.isFinite(rawDuration) && rawDuration > 0) {
            const seconds = rawDuration / 1000,
              media = sourceMedia(addresses, base);
            if (media && seconds > 0)
              for (const target of [media.url, ...(media.alternatives || [])]) {
                const previous = durations.get(target);
                if (previous !== undefined && Math.abs(previous - seconds) > Math.min(30, Math.max(2, previous * 0.01)))
                  conflicts.add(target);
                else if (previous === undefined) durations.set(target, seconds);
              }
          }
          return addresses;
        });
      const media = sourceMedia(addresses, base);
      return media ? [media.url, ...(media.alternatives || [])] : [];
    })
    .filter((group) => group.length);
  const originalKeys = [
    video?.consumer?.originVideoKey,
    video?.consumer?.origin_video_key,
  ];
  const originalPaths = originalKeys
    .filter(
      (key): key is string =>
        typeof key === "string" &&
        key.length <= 2048 &&
        key
          .split("/")
          .every(
            (part) =>
              part !== "." &&
              part !== ".." &&
              /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part),
          ),
    )
    .map((key) => `https://sns-video-bd.xhscdn.com/${key}`);
  const direct = sourceMedia(
    [
      note.videoUrl,
      note.video_url,
      ...(Array.isArray(video?.urlList) ? video.urlList : []),
      ...(Array.isArray(video?.url_list) ? video.url_list : []),
      ...(Array.isArray(video?.playAddr) ? video.playAddr : []),
      ...(Array.isArray(video?.play_addr) ? video.play_addr : []),
      video?.url,
      video?.playUrl,
      video?.play_url,
      ...originalKeys,
      ...originalPaths,
    ],
    base,
  );
  if (direct) groups.push([direct.url, ...(direct.alternatives || [])]);
  if (!groups.length) return;
  // Keep a normal backup, then offer another representation before a long first-codec list consumes the attempt budget.
  const media = sourceMedia(
    [
      ...groups[0].slice(0, 2),
      ...groups.slice(1).map((group) => group[0]),
      ...groups.flat(),
    ],
    base,
  );
  if (!media) return;
  if (conflicts.has(media.url))
    throw new SiteStateConflict(
      "小红书当前媒体的来源时长存在冲突，未猜测完整视频长度",
    );
  const directDuration = [video?.duration, video?.capa?.duration, video?.media?.video?.duration]
    .find((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
  const durationSeconds = directDuration === undefined
    ? undefined
    : directDuration > 1000 ? directDuration / 1000 : directDuration;
  const duration = durations.get(media.url) ?? durationSeconds;
  return {
    ...media,
    ...(duration !== undefined ? { expectedDurationSeconds: duration } : {}),
  };
}
/** Preserve only source-advertised representations belonging to this exact work. */
export function sourceMedia(
  values: unknown[],
  base: string,
): SiteMediaSource | undefined {
  const urls = [
    ...new Set(
      values
        .filter(
          (value): value is string =>
            typeof value === "string" &&
            /^(?:https?:)?\/\//i.test(value.trim()),
        )
        .map((value) => publicUrl(value, base))
        .filter((value): value is string => !!value),
    ),
  ].slice(0, 8);
  if (!urls.length) return;
  return {
    url: urls[0],
    referer: base,
    ...(urls.length > 1 ? { alternatives: urls.slice(1) } : {}),
  };
}
function one(
  rows: Array<Record<string, any>>,
  name: string,
): Record<string, any> {
  const distinct = [
    ...new Map(rows.map((row) => [JSON.stringify(row), row])).values(),
  ];
  if (!distinct.length)
    throw new SiteStateUnavailable(
      `${name}未取得当前作品的明确内容，可能需要登录或页面结构已变化`,
    );
  if (distinct.length !== 1)
    throw new SiteStateConflict(
      `${name}当前作品存在冲突的页面数据，未提取正文`,
    );
  return distinct[0];
}
function metadata(
  title: string,
  description: string,
  source: string,
): ExtractedContent {
  return {
    title: title || description.split("\n")[0].slice(0, 80) || source,
    source_title: title,
    markdown: "",
    source,
    source_description: description || undefined,
    tags: [],
  };
}
export function sourceMetrics(
  values: Partial<Record<MetricKey, unknown>>,
): MetricSnapshot | undefined {
  const result: Partial<Record<MetricKey, number>> = {};
  for (const [key, raw] of Object.entries(values)) {
    const value =
      typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
      result[key as MetricKey] = value;
  }
  return Object.keys(result).length
    ? { ...result, metrics_captured_at: nowBeijingDateTime() }
    : undefined;
}

export function extractSitePage(
  html: string,
  url: string,
  convert: (html: string, url: string) => string,
  includeMetrics = false,
): SiteResult | undefined {
  const site = localSite(url);
  if (!site || site === "bilibili") return;
  const document = new DOMParser().parseFromString(html, "text/html");
  const states = publicPageStates(document),
    pathname = new URL(url).pathname;
  if (site === "xiaohongshu") {
    assertXiaohongshuAccess(html, url);
    const id = pathname.match(
      /^\/(?:zh\/)?(?:explore|discovery\/item)\/([a-f0-9]{24})(?:\/|$)/i,
    )?.[1];
    if (!id)
      throw new SiteStateUnavailable(
        "小红书原站未返回具体笔记页，可能需要登录或内容不可用；请在浏览器核对原链接",
      );
    const raw = one(
      records(
        states,
        (row) =>
          (row.noteId === id || row.note_id === id || row.id === id) &&
          ("desc" in row ||
            "imageList" in row ||
            "image_list" in row ||
            "video" in row ||
            "videoInfo" in row ||
            "video_info" in row ||
            "videoUrl" in row ||
            "video_url" in row),
      ),
      "小红书",
    );
    const note: Record<string, any> = {
      ...raw,
      title: raw.title ?? raw.displayTitle ?? raw.display_title,
      type: raw.type ?? raw.noteType ?? raw.note_type ?? (raw.video ? "video" : undefined),
      imageList: raw.imageList ?? raw.image_list,
      tagList: raw.tagList ?? raw.tag_list,
      interactInfo: raw.interactInfo ?? raw.interact_info,
      user: raw.user ?? raw.user_info ?? raw.userInfo,
      time: raw.time ?? raw.createTime ?? raw.create_time ?? raw.lastUpdateTime ?? raw.last_update_time,
    };
    const content = {
      ...metadata(text(note.title), text(note.desc), "小红书"),
      author: text(note.user?.nickname) || undefined,
      metrics: includeMetrics
        ? sourceMetrics({
            likes:
              note.interactInfo?.likedCount ?? note.interactInfo?.liked_count ?? note.interactInfo?.likeCount ?? note.interactInfo?.like_count,
            collects:
              note.interactInfo?.collectedCount ??
              note.interactInfo?.collected_count ?? note.interactInfo?.collectCount ?? note.interactInfo?.collect_count,
            comments:
              note.interactInfo?.commentCount ??
              note.interactInfo?.comment_count ?? note.interactInfo?.commentCountNum,
            shares:
              note.interactInfo?.shareCount ?? note.interactInfo?.share_count ?? note.interactInfo?.shareCountNum,
          })
        : undefined,
      source_date: date(note.time, true),
      tags: [
        ...new Set<string>(
          (Array.isArray(note.tagList) ? note.tagList : [])
            .map((tag: any) => text(tag?.name))
            .filter(Boolean),
        ),
      ],
    };
    if (note.type === "video") {
      const media = xhsVideoSource(note, url);
      if (!media)
        throw new SiteMediaUnavailable(
          "小红书视频未提供公开可转写媒体，请登录原站核对；不会用简介代替转写",
          content,
        );
      const imageUrls = Array.isArray(note.imageList)
        ? note.imageList.map((image: any) => noteImage(image, url)).filter((value: string | undefined): value is string => !!value)
        : [];
      return {
        detectedMedia: "video",
        content: {
          ...content,
          ...(imageUrls.length ? { image_urls: imageUrls } : {}),
          ...(media.expectedDurationSeconds !== undefined
            ? { duration_seconds: media.expectedDurationSeconds }
            : {}),
        },
        media,
      };
    }
    const hasStructuredImages =
      Array.isArray(note.imageList) && note.imageList.length > 0;
    const dom = hasStructuredImages
      ? undefined
      : xhsDomGallery(document, url, id);
    const cover =
      hasStructuredImages || dom ? undefined : xhsPageCover(document, url, id);
    const imageUrls: Array<string | undefined> = hasStructuredImages
      ? note.imageList.map((image: any) => noteImage(image, url))
      : dom
        ? dom.images
        : cover
          ? [cover]
          : [];
    if (!text(note.desc) && !imageUrls.some(Boolean))
      throw new SiteGalleryUnavailable(
        "小红书图文没有可读取正文或公开图片，未保存缺图占位笔记",
        content,
        hasStructuredImages,
      );
    if (!text(note.desc))
      (content as ExtractedContent).requires_image_content = true;
    content.markdown = renderSourceGallery(text(note.desc), imageUrls);
    if (imageUrls.some((value: string | undefined) => !value))
      (content as ExtractedContent).warnings = [
        "部分小红书图片未提供公开地址，请从原文核对缺图",
      ];
    if (cover)
      (content as ExtractedContent).warnings = [
        "原站未提供结构化图集，仅保留页面明确声明的封面，图片可能不完整，请从原文核对",
      ];
    if (dom)
      (content as ExtractedContent).warnings = [
        ...((content as ExtractedContent).warnings || []),
        "原站未提供结构化图集，已按页面图集顺序提取，未加载图片可能缺失，请从原文核对",
      ];
    if (!content.markdown) throw new Error("小红书笔记没有可读取正文或图片");
    return { content };
  }
  if (site === "douyin") {
    if (siteAccessRequired(html))
      throw new SiteAccessDenied(
        "抖音原站要求访问验证，本次停止取数，请在浏览器核对后手动重试",
      );
    const id = douyinWorkId(url);
    if (!id) throw new Error("请提供抖音具体作品链接，短链接须能正常跳转");
    const restricted = records(states, (row) => {
      const details = [row, row.aweme_detail, row.awemeDetail, row.videoDetail];
      return (
        details.some(
          (value) =>
            value &&
            [value.aweme_id, value.awemeId].some(
              (identity) => identity !== undefined && String(identity) === id,
            ),
        ) &&
        ([row.status_code, row.statusCode].some(
          (code) => code !== undefined && code !== 0,
        ) ||
          [row.verify_url, row.verifyUrl].some(
            (value) => typeof value === "string" && !!value.trim(),
          ))
      );
    });
    if (restricted.length)
      throw new SiteAccessDenied(
        "抖音当前作品数据明确要求验证或未授权，本次停止取数",
      );
    const detail = one(
      records(
        states,
        (row) =>
          [row.aweme_id, row.awemeId].some(
            (value) => value !== undefined && String(value) === id,
          ) &&
          ("desc" in row || "video" in row || "images" in row),
      ),
      "抖音",
    );
    if (
      detail.aweme_id !== undefined &&
      detail.awemeId !== undefined &&
      String(detail.aweme_id) !== String(detail.awemeId)
    )
      throw new SiteStateConflict("抖音作品身份字段冲突，未提取正文");
    if (
      [
        detail.charge_info?.is_charge_content,
        detail.charge_info?.isChargeContent,
        detail.chargeInfo?.is_charge_content,
        detail.chargeInfo?.isChargeContent,
      ].some((value) => value === true || value === 1)
    )
      throw new SiteAccessDenied("抖音作品明确为付费内容，本地不提取试看媒体");
    const stats = { ...detail.stats, ...detail.statistics };
    const content = {
      ...metadata(text(detail.title), text(detail.desc), "抖音"),
      author:
        text(detail.author?.nickname) ||
        text(detail.authorInfo?.nickname) ||
        undefined,
      source_date: date(detail.create_time ?? detail.createTime, false),
      metrics: includeMetrics
        ? sourceMetrics({
            views: stats.play_count ?? stats.playCount,
            likes: stats.digg_count ?? stats.diggCount,
            collects: stats.collect_count ?? stats.collectCount,
            comments: stats.comment_count ?? stats.commentCount,
            shares: stats.share_count ?? stats.shareCount,
          })
        : undefined,
    };
    if (
      /\/(?:share\/)?note\//.test(pathname) &&
      !(Array.isArray(detail.images) && detail.images.length)
    ) {
      throw new SiteGalleryUnavailable(
        "抖音图文尚未取得原图列表，不会转写背景音乐代替图集",
        content,
      );
    }
    if (Array.isArray(detail.images) && detail.images.length) {
      const selected: Array<string | undefined> = detail.images.map(
        (image: any) => firstAddress(addressList(image), url),
      );
      if (!selected.some(Boolean))
        throw new SiteGalleryUnavailable(
          "抖音图文未取得可读取原图，不会用简介或背景音乐代替图集",
          content,
        );
      if (!text(detail.desc))
        (content as ExtractedContent).requires_image_content = true;
      content.markdown = renderSourceGallery(text(detail.desc), selected);
      if (selected.some((value: string | undefined) => !value))
        (content as ExtractedContent).warnings = [
          "部分抖音原图未提供公开地址，请从原文核对缺图",
        ];
      return { content };
    }
    const video = detail.video ?? {},
      rates = video.bit_rate ?? video.bitRate;
    const cover = firstAddress(
      [
        ...addressList(video.cover),
        ...addressList(video.coverUrl),
        ...addressList(video.cover_url),
        ...addressList(video.dynamic_cover),
        ...addressList(video.dynamicCover),
        ...addressList(video.origin_cover),
        ...addressList(video.originCover),
      ],
      url,
    );
    if (cover)
      content.markdown = `![封面](${cover})`;
    const variants = Array.isArray(rates) ? rates : [];
    const media = sourceMedia(
      [
        ...addressList(video.play_addr),
        ...addressList(video.playAddr),
        ...variants.flatMap((item: any) => [
          ...addressList(item?.play_addr),
          ...addressList(item?.playAddr),
        ]),
        ...addressList(video.download_addr),
        ...addressList(video.downloadAddr),
      ],
      url,
    );
    if (!media)
      throw new SiteMediaUnavailable(
        "抖音未提供公开媒体，需要登录或动态解析；不会用作品简介代替转写",
        content,
      );
    // The public aweme_detail schema exposes video durations in milliseconds.
    // A camel-case web state is not proof of the same unit; never borrow music duration.
    const milliseconds = (value: unknown) =>
      typeof value === "number" &&
      Number.isFinite(value) &&
      value > 0 &&
      value / 1000 > 0
        ? value / 1000
        : undefined;
    const appSchema =
      detail.aweme_id !== undefined &&
      ("play_addr" in video || "download_addr" in video || "bit_rate" in video);
    let duration = appSchema ? milliseconds(video.duration) : undefined;
    const download = appSchema
      ? sourceMedia(addressList(video.download_addr), url)
      : undefined;
    const downloadDuration =
      download &&
      [download.url, ...(download.alternatives || [])].includes(media.url)
        ? milliseconds(video.download_addr?.duration)
        : undefined;
    if (
      duration !== undefined &&
      downloadDuration !== undefined &&
      Math.abs(duration - downloadDuration) >
        Math.min(30, Math.max(2, duration * 0.01))
    )
      throw new SiteStateConflict(
        "抖音当前媒体的来源时长存在冲突，未猜测完整视频长度",
      );
    duration ??= downloadDuration;
    return {
      content: {
        ...content,
        ...(duration !== undefined ? { duration_seconds: duration } : {}),
      },
      media: {
        ...media,
        ...(duration !== undefined
          ? { expectedDurationSeconds: duration }
          : {}),
      },
    };
  }
  if (site === "xiaoyuzhou") {
    const id = pathname.match(/^\/episode\/([a-f0-9]{24})(?:\/|$)/i)?.[1];
    if (!id) throw new Error("请提供小宇宙单集链接");
    const episode = one(
      records(
        states,
        (row) =>
          row.eid === id && typeof row.title === "string" && "media" in row,
      ),
      "小宇宙",
    );
    if (
      episode.isPrivateMedia === true ||
      episode.media?.source?.mode !== "PUBLIC" ||
      episode.payType !== "FREE"
    )
      throw new SiteAccessDenied(
        "小宇宙单集不是明确可访问的免费公开媒体，不使用付费或预览音频",
      );
    const media = publicUrl(episode.media?.source?.url, url);
    if (!media) throw new Error("小宇宙单集未提供公开音频");
    const published =
      typeof episode.pubDate === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        episode.pubDate,
      )
        ? new Date(episode.pubDate)
        : undefined;
    const content = {
      ...metadata(text(episode.title), text(episode.description), "小宇宙"),
      author: text(episode.podcast?.author) || undefined,
      metrics: includeMetrics
        ? sourceMetrics({
            views: episode.playCount,
            likes: episode.clapCount,
            comments: episode.commentCount,
            collects: episode.favoriteCount,
          })
        : undefined,
      duration_seconds:
        typeof episode.duration === "number" &&
        Number.isFinite(episode.duration) &&
        episode.duration > 0
          ? episode.duration
          : undefined,
      source_date:
        published &&
        Number.isFinite(published.getTime()) &&
        published.getUTCFullYear() >= 2000 &&
        published.getTime() <= Date.now() + 86400000
          ? published.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" })
          : undefined,
    };
    return {
      content,
      media: {
        url: media,
        referer: url,
        ...(content.duration_seconds
          ? { expectedDurationSeconds: content.duration_seconds }
          : {}),
        bytes:
          Number.isSafeInteger(episode.media?.size) && episode.media.size > 0
            ? episode.media.size
            : undefined,
      },
    };
  }
  if (site === "feishu") {
    if (!/^\/(?:docx|docs|wiki)\/[A-Za-z0-9]+(?:\/|$)/.test(pathname))
      throw new Error("请提供飞书具体文档链接");
    const body = document.querySelector(
      ".docx-page-block-children, .doc-content, [data-doc-content]",
    );
    if (!body)
      throw new Error(
        "飞书页面未提供公开文档正文，需要授权或动态渲染；不会保存登录页",
      );
    const clean = body.cloneNode(true) as HTMLElement;
    clean
      .querySelectorAll(
        'nav,header,footer,script,style,button,[role="navigation"]',
      )
      .forEach((node) => node.remove());
    const missingImages = Array.from(clean.querySelectorAll("img")).some(
      (image) =>
        !["data-src", "data-original", "data-actualsrc", "src"].some((name) =>
          publicUrl(image.getAttribute(name), url),
        ),
    );
    const markdown = convert(clean.innerHTML, url);
    const plain = clean.textContent?.trim() || "";
    if (
      !markdown ||
      (!plain && !/!\[[^\]]*\]\(<?https?:\/\//.test(markdown)) ||
      /^(?:请登录|登录后查看|无权访问|申请权限|加载中[.。…]*|正在加载[.。…]*)$/.test(
        plain,
      )
    )
      throw new Error("尚未取得可阅读的飞书正文");
    const title =
      document
        .querySelector(
          '.docx-title-block, h1[data-block-type="page"], [data-doc-title]',
        )
        ?.textContent?.trim() ||
      document
        .querySelector('meta[property="og:title"]')
        ?.getAttribute("content")
        ?.trim() ||
      "";
    const readableBody = markdown
      .split("\n")
      .filter((line) => line.replace(/^#{1,6}\s+/, "").trim() !== title)
      .join("\n")
      .trim();
    if (!readableBody) throw new Error("飞书仅有文档标题，尚未取得有效正文");
    return {
      content: {
        ...metadata(title, "", "飞书"),
        markdown: markdown.replace(
          new RegExp(
            "^# " + title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\n+",
          ),
          "",
        ),
        warnings: missingImages
          ? [
              "部分飞书图片未提供公开地址，本次保留可读取的正文，请从原文核对缺图",
            ]
          : undefined,
        author:
          document
            .querySelector('meta[name="author"]')
            ?.getAttribute("content")
            ?.trim() || undefined,
      },
    };
  }
}
