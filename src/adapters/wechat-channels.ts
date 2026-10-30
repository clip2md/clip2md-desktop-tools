/** Pure validation and normalization for the official WeChat Channels preview flow. */

export interface WechatChannelsMediaCandidate {
  url: string;
  decodeKey?: string;
  durationSeconds?: number;
}

const SHORT_ID = /^[A-Za-z0-9]{3,64}$/;
const MEDIA_PATH = /^\/(?:\d+\/){2}stodownload$/;

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
}

function secureUrl(value: string | undefined): URL | undefined {
  if (!value) return;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443")
    )
      return;
    return url;
  } catch {
    return;
  }
}

/** Normalize either a share link or its public `pages/sph?id=` redirect. */
export function wechatChannelsShareAddress(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      url.hash
    )
      return;
    let id: string | undefined;
    if (url.hostname === "weixin.qq.com" && !url.search)
      id = url.pathname.match(/^\/sph\/([^/?#]+)\/?$/)?.[1];
    else if (
      url.hostname === "channels.weixin.qq.com" &&
      url.pathname === "/finder-preview/pages/sph" &&
      [...url.searchParams.keys()].join(",") === "id"
    )
      id = url.searchParams.get("id") || undefined;
    return id && SHORT_ID.test(id)
      ? `https://weixin.qq.com/sph/${id}`
      : undefined;
  } catch {
    return;
  }
}

/** A token-bearing official playback page is transient and must never be persisted. */
export function wechatChannelsPlayableAddress(value: unknown): string | undefined {
  const url = secureUrl(typeof value === "string" ? value : undefined);
  if (
    !url ||
    url.hostname !== "channels.weixin.qq.com" ||
    url.pathname !== "/finder-preview/pages/feed" ||
    url.hash ||
    !url.searchParams.get("token") ||
    !url.searchParams.get("eid")
  )
    return;
  return url.href;
}

/** Only a signed Tencent media path may be downloaded. */
export function wechatChannelsMediaAddress(value: unknown): string | undefined {
  const url = secureUrl(typeof value === "string" ? value : undefined);
  if (
    !url ||
    url.hostname !== "finder.video.qq.com" ||
    !MEDIA_PATH.test(url.pathname) ||
    url.hash
  )
    return;
  return url.href;
}

/** Extract the transient playback URL returned after an authenticated Yuanbao request. */
export function wechatChannelsPlayableFromParse(
  response: unknown,
): { state: "ready"; address: string } | { state: "login" | "unavailable" } {
  if (!plainObject(response)) return { state: "unavailable" };
  const status = response.status;
  if (status === 401 || status === 403) return { state: "login" };
  if (typeof status === "number" && (status < 200 || status >= 300))
    return { state: "unavailable" };
  const payload = plainObject(response.payload) ? response.payload : undefined;
  if (!payload) return { state: "unavailable" };
  const code = payload.code;
  if (code !== undefined && code !== null && Number(code) !== 0)
    return { state: "unavailable" };
  const data = plainObject(payload.data) ? payload.data : undefined;
  const address = wechatChannelsPlayableAddress(data?.playable_url);
  return address ? { state: "ready", address } : { state: "unavailable" };
}

function appendUrlToken(base: string, token: string | undefined): string {
  if (!token) return base;
  if (/^https?:\/\//i.test(token)) return token;
  if (base.includes(token)) return base;
  const normalized = token.replace(/^[?&]/, "");
  return `${base}${base.includes("?") ? "&" : "?"}${normalized}`;
}

function mediaCandidate(
  value: unknown,
  urlToken?: string,
  fallbackDuration?: number,
): WechatChannelsMediaCandidate | undefined {
  if (!plainObject(value)) return;
  const raw =
    text(value.videoUrl) ||
    text(value.mediaUrl) ||
    text(value.url);
  if (!raw) return;
  const url = wechatChannelsMediaAddress(appendUrlToken(raw, urlToken || text(value.urlToken)));
  if (!url) return;
  const key = text(value.decodeKey) || text(value.decryptKey);
  const duration = Number(
    value.durationSeconds ??
    value.duration_seconds ??
    value.videoPlayLen ??
    value.duration,
  );
  return {
    url,
    ...(key ? { decodeKey: key } : {}),
    ...(Number.isFinite(duration) && duration > 0
      ? { durationSeconds: duration }
      : fallbackDuration && fallbackDuration > 0
        ? { durationSeconds: fallbackDuration }
        : {}),
  };
}

/** Preserve the source's quality preference while exposing safe fallbacks. */
export function wechatChannelsMediaCandidates(feedResponse: unknown): WechatChannelsMediaCandidate[] {
  if (!plainObject(feedResponse)) return [];
  const data = plainObject(feedResponse.data) ? feedResponse.data : feedResponse;
  const feed = plainObject(data.feedInfo)
    ? data.feedInfo
    : plainObject(feedResponse.feedInfo)
      ? feedResponse.feedInfo
      : {};
  const explicit = [
    feed.h264VideoInfo,
    feed.videoUrl ? feed : undefined,
    feed.originVideoUrl ? { videoUrl: feed.originVideoUrl } : undefined,
    feed.h265VideoInfo,
  ];
  const found: WechatChannelsMediaCandidate[] = [];
  const add = (candidate: unknown, token?: string, duration?: number) => {
    if (!plainObject(candidate)) return;
    const row = mediaCandidate(candidate, token, duration);
    if (row && !found.some(item => item.url === row.url)) found.push(row);
  };
  for (const row of explicit) add(row);
  const fallbackDuration = Number(
    feed.videoDuration ?? feed.durationSeconds ?? feed.duration_seconds,
  );
  const rows = Array.isArray(feed.mediaList) ? feed.mediaList : [];
  for (const row of rows.slice(0, 16)) {
    if (!plainObject(row)) continue;
    const duration = Number(row.durationSeconds ?? row.duration_seconds ?? row.videoPlayLen ?? row.duration);
    add(row, text(row.urlToken), Number.isFinite(duration) && duration > 0 ? duration : fallbackDuration);
  }
  return found.slice(0, 8);
}

function plainMessage(value: unknown): string {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

/** Return a safe source error without retaining response headers or credentials. */
export function wechatChannelsFeedError(response: unknown): string | undefined {
  if (!plainObject(response)) return "视频号接口未返回有效数据";
  const status = response.status;
  if (status === 401 || status === 403) return "视频号授权已失效，请重新登录腾讯元宝";
  if (typeof status === "number" && (status < 200 || status >= 300))
    return `视频号接口返回 HTTP ${status}`;
  const payload = plainObject(response.payload) ? response.payload : undefined;
  if (!payload) return "视频号接口未返回有效数据";
  const code = Number(payload.errCode ?? 0);
  if (code !== 0)
    return plainMessage(payload.errMsg) || "视频号接口返回错误";
  const data = plainObject(payload.data) ? payload.data : {};
  const err = plainObject(data.errMsg) ? data.errMsg : {};
  const detail = [
    plainMessage(err.title),
    plainMessage(err.content),
  ].filter(Boolean).join("：");
  const type = Number(err.type ?? 0);
  if (type !== 0 || detail) return detail || "该视频号内容无法播放";
  if (!wechatChannelsMediaCandidates(payload).length)
    return "视频号未返回可下载的音视频流";
}

