import { withAbort } from "./async";
import type { RenderedSnapshot } from "./adapters/rendered-sites";
import { SiteSessions, AuthorizationRequired } from "./auth";
import { platformFor } from "./config";
import type { CommentBatch } from "./comments";
import {
  wechatChannelsPlayableAddress,
  wechatChannelsPlayableFromParse,
  wechatChannelsShareAddress,
} from "./adapters/wechat-channels";
export function snapshotPage(): RenderedSnapshot {
  const isXhs = /(?:^|\.)(?:xiaohongshu|rednote)\.com$/i.test(location.hostname);
  const xhsNoteState = (): unknown => {
    if (!isXhs) return;
    const globals = globalThis as unknown as Record<string, unknown>;
    const id = location.pathname.match(/\/(?:zh\/)?(?:explore|discovery\/item)\/([a-f0-9]{24})(?:\/|$)/i)?.[1];
    if (!id) return;
    const root = globals.__INITIAL_STATE__;
    const queue: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
    const seen = new WeakSet<object>();
    const clone = (value: unknown, depth: number): unknown => {
      if (value === null || typeof value !== "object")
        return typeof value === "bigint" ? String(value) : value;
      if (depth > 24 || seen.has(value)) return undefined;
      seen.add(value);
      if (Array.isArray(value)) return value.slice(0, 128).map((item) => clone(item, depth + 1));
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 256)) {
        if (typeof item === "function") continue;
        const copied = clone(item, depth + 1);
        if (copied !== undefined) result[key] = copied;
      }
      return result;
    };
    for (let index = 0; index < queue.length && index < 100000; index++) {
      const { value, depth } = queue[index];
      if (!value || typeof value !== "object" || depth > 40) continue;
      if (!Array.isArray(value)) {
        const row = value as Record<string, unknown>;
        const rowId = row.noteId ?? row.note_id ?? row.id;
        if (String(rowId || "") === id && (row.desc || row.imageList || row.image_list || row.video || row.videoInfo || row.video_info)) {
          const copied = clone(row, 0);
          if (copied && typeof copied === "object") return { noteId: id, ...(copied as Record<string, unknown>) };
        }
      }
      for (const child of Object.values(value as Record<string, unknown>))
        if (child && typeof child === "object" && !seen.has(child)) queue.push({ value: child, depth: depth + 1 });
    }
  };
  // The state used by Douyin is often streamed through inline scripts rather
  // than exposed as a single global. Keep only the small, data-bearing subset
  // so the offline parser can read it without executing page JavaScript.
  const inlineStateScripts: HTMLScriptElement[] = [];
  let inlineStateBytes = 0;
  for (const script of Array.from(document.scripts)) {
    if (
      script.src ||
      (script.type &&
        !["text/javascript", "application/javascript", "module"].includes(
          script.type,
        )) ||
      ["__NEXT_DATA__", "RENDER_DATA"].includes(script.id)
    )
      continue;
    const text = script.textContent || "";
    if (
      !text ||
      text.length > 2 * 1024 * 1024 ||
      !/(?:__pace_f|_ROUTER_DATA|__NEXT_DATA__|__INITIAL_STATE__|videoDetail|aweme_detail|awemeDetail)/.test(
        text,
      ) ||
      inlineStateBytes + text.length > 4 * 1024 * 1024
    )
      continue;
    if (isXhs && /__INITIAL_STATE__/.test(text)) continue;
    inlineStateScripts.push(script);
    inlineStateBytes += text.length;
    if (inlineStateScripts.length >= 64) break;
  }
  const clone = document.documentElement.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("script").forEach((node) => node.remove());
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const name of [
    "__INITIAL_STATE__",
    "_ROUTER_DATA",
    "__NEXT_DATA__",
    "__INITIAL_DATA__",
    "__pace_f",
  ]) {
    try {
      const text = JSON.stringify(globals[name]);
      if (!text || text.length > 2 * 1024 * 1024) continue;
      const node = document.createElement("script");
      node.type = "application/json";
      node.setAttribute("data-clip2md-live-state", name);
      node.textContent = text.replace(/</g, "\\u003c");
      clone.append(node);
    } catch {
      /* Unserializable state is not source data. */
    }
  }
  if (isXhs) {
    try {
      const state = xhsNoteState();
      if (state !== undefined) {
        const node = document.createElement("script");
        node.type = "application/json";
        node.setAttribute("data-clip2md-live-state", "xiaohongshu-note");
        node.textContent = JSON.stringify(state).replace(/</g, "\\u003c");
        clone.append(node);
      }
    } catch {
      /* Cyclic client state is common; the DOM fallback remains available. */
    }
  }
  for (const node of Array.from(
    document.querySelectorAll(
      'script#__NEXT_DATA__,script#RENDER_DATA,script[type="application/json"]',
    ),
  ).slice(0, 64))
    if ((node.textContent?.length || 0) < 2 * 1024 * 1024)
      clone.append(node.cloneNode(true));
  // JSON-LD carries source-owned authors, dates and interaction counters for
  // many article sites. It is inert data; retain it for the offline parser
  // without copying executable page scripts.
  for (const node of Array.from(
    document.querySelectorAll('script[type="application/ld+json"]'),
  ).slice(0, 32))
    if ((node.textContent?.length || 0) < 1024 * 1024)
      clone.append(node.cloneNode(true));
  // Do not execute these scripts. They are parsed as bounded literals by
  // publicPageStates() after the snapshot reaches the desktop collector.
  for (const node of inlineStateScripts) clone.append(node.cloneNode(true));
  const liveImages = Array.from(document.querySelectorAll('img'));
  clone.querySelectorAll('img').forEach((node,index)=>{ const src=liveImages[index]?.currentSrc; if(src)node.setAttribute('src',src); });
  const html = clone.outerHTML;
  if (html.length > 8 * 1024 * 1024) throw new Error("来源页面过大");
  return {
    url: location.href,
    html,
    audios: Array.from(document.querySelectorAll('audio')).slice(0,16).map(v=>({src:v.currentSrc||v.src,playing:!v.paused&&!v.ended,visible:v.getBoundingClientRect().width>0,area:0,identities:[]})),
    videos: Array.from(document.querySelectorAll("video"))
      .slice(0, 16)
      .map((v) => ({
        src: v.currentSrc || v.src,
        playing: !v.paused && !v.ended,
        visible: v.getBoundingClientRect().width > 0,
        area: Math.max(
          0,
          v.getBoundingClientRect().width * v.getBoundingClientRect().height,
        ),
        identities: [],
      })),
  };
}
function scrollComments(): void {
  const container = document.querySelector<HTMLElement>(
    '[class*="comment-container"], [class*="comment-list"], [data-e2e="comment-list"]',
  );
  // XHS renders comments inside a non-scrolling `.comments-container`; the
  // `.note-scroller` ancestor owns the scroll position and loads next pages.
  let scroller: HTMLElement | null = null;
  for (let node = container; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (
      node.scrollHeight > node.clientHeight + 4 &&
      /(?:auto|scroll)/i.test(`${style.overflowY} ${style.overflow}`)
    ) {
      scroller = node;
      break;
    }
  }
  // The comments component may not have mounted its list class yet, while
  // the surrounding XHS note scroller is already present.
  scroller ||= document.querySelector<HTMLElement>(".note-scroller");
  scroller ||= document.scrollingElement as HTMLElement | null;
  if (!scroller) return;
  // Vue's virtual list listens to the native scroll event; dispatching it is
  // needed in Electron where scrollTo() alone can leave the list at page one.
  scroller.scrollTop = scroller.scrollHeight;
  scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
}
/** Read top-level XHS comments already rendered after the comment scroller advances. */
function pageComments(): Array<Record<string, unknown>> {
  return Array.from(document.querySelectorAll<HTMLElement>(".parent-comment"))
    .map((parent) => {
      const item = parent.querySelector<HTMLElement>(":scope > .comment-item");
      const id = item?.id.match(/^comment-([A-Za-z0-9_-]+)$/)?.[1];
      const author = item?.querySelector<HTMLElement>(".author .name")?.textContent?.trim() || "";
      const text = item?.querySelector<HTMLElement>(".content .note-text, .content")?.textContent?.trim() || "";
      const likeText = item?.querySelector<HTMLElement>(":scope > .comment-inner-container .like .count")?.textContent?.trim() || "";
      const likes = /^\d+$/.test(likeText) ? Number(likeText) : 0;
      return id && author && text && text.length <= 10000
        ? { id, content: text, user_info: { nickname: author }, like_count: likes }
        : undefined;
    })
    .filter(
      (value): value is {
        id: string;
        content: string;
        user_info: { nickname: string };
        like_count: number;
      } => !!value,
    );
}
/** Open the answer-local comment panel on Zhihu before taking the snapshot. */
function openZhihuComments(answerId: string): boolean {
  const answer = document.querySelector<HTMLElement>(
    `.AnswerItem[name="${CSS.escape(answerId)}"], .AnswerItem[data-zop*="${answerId}"]`,
  );
  const button = answer &&
    Array.from(answer.querySelectorAll<HTMLButtonElement>("button")).find((item) =>
      /(?:\d+\s*条评论|添加评论)/.test(item.textContent || ""),
    );
  if (!button) return false;
  button.click();
  return true;
}
/** CSDN keeps the comment list in a lazy side panel; opening the panel starts
 * the public comment request and renders rows into `.comment-list-box`. */
function openCsdnComments(): boolean {
  const button = document.querySelector<HTMLElement>(
    '.go-side-comment, [data-report-click*="comment"]',
  );
  if (!button) return false;
  button.click();
  return true;
}
/** Fetch the first bounded page of top-level Zhihu answer comments in the
 * authenticated renderer; the public page does not mount them until clicked. */
async function requestZhihuComments(answerId: string): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await globalThis.fetch(
      `/api/v4/answers/${encodeURIComponent(answerId)}/comments?limit=100&offset=0`,
      { credentials: "include" },
    );
    if (!response.ok) return;
    const value: unknown = await response.json();
    return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  } catch {
    return;
  }
}
/** Ask the already authenticated Douyin page to sign one comment request. */
async function requestDouyinComments(workId: string): Promise<void> {
  const signer = (globalThis as any).byted_acrawler?.frontierSign;
  if (typeof signer !== "function") {
    // A challenge shell does not expose the signer, but the same authenticated
    // session can still return the bounded public list from the normal feed.
    await globalThis.fetch(
      `/aweme/v1/web/comment/list/?aweme_id=${encodeURIComponent(workId)}&cursor=0&count=20&aid=6383&device_platform=webapp`,
      { credentials: "include" },
    );
    return;
  }
  const values: Record<string, string> = {
    device_platform: "webapp",
    aid: "6383",
    channel: "channel_pc_web",
    aweme_id: workId,
    cursor: "0",
    count: "20",
    item_type: "0",
    update_version_code: "170400",
    pc_client_type: "1",
    version_code: "190600",
    version_name: "19.6.0",
    cookie_enabled: "true",
    browser_language: "zh-CN",
    browser_platform: "MacIntel",
    browser_name: "Chrome",
    browser_version: "154.0.0.0",
    browser_online: "true",
    engine_name: "Blink",
    os_name: "Mac OS",
    os_version: "10.15.7",
    cpu_core_num: "8",
    device_memory: "8",
    engine_version: "109.0",
    platform: "PC",
    screen_width: "2560",
    screen_height: "1440",
    effective_type: "4g",
    round_trip_time: "50",
    msToken: globalThis.localStorage?.getItem("xmst") || "",
  };
  const query = Object.keys(values)
    .map((key) => `${key}=${encodeURIComponent(values[key])}`)
    .join("&");
  const signed = await signer(query);
  const bogus = signed?.["X-Bogus"] || signed?.["X_Bogus"];
  if (typeof bogus !== "string" || !bogus) return;
  await globalThis.fetch(
    `/aweme/v1/web/comment/list/?${query}&X-Bogus=${encodeURIComponent(bogus)}`,
    { credentials: "include", headers: { referer: location.href } },
  );
}
/** Fetch the bounded first-party detail response even when the HTML shell is a challenge page. */
async function requestDouyinDetail(workId: string): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await globalThis.fetch(
      `/aweme/v1/web/aweme/detail/?aweme_id=${encodeURIComponent(workId)}&aid=6383&device_platform=webapp`,
      { credentials: "include" },
    );
    if (!response.ok) return;
    const value: unknown = await response.json();
    if (!value || typeof value !== "object") return;
    const detail = (value as Record<string, unknown>).aweme_detail;
    if (!detail || typeof detail !== "object") return;
    const id = (detail as Record<string, unknown>).aweme_id;
    return String(id) === workId ? value as Record<string, unknown> : undefined;
  } catch {
    return;
  }
}
/** Read the authenticated XHS feed response when the web shell omits its SSR state. */
async function requestXhsDetail(noteId: string, token: string): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await globalThis.fetch(
      "https://edith.xiaohongshu.com/api/sns/web/v1/feed",
      {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          source_note_id: noteId,
          image_formats: ["jpg", "webp", "avif"],
          extra: { need_body_topic: "1" },
          xsec_source: "pc_feed",
          xsec_token: token,
        }),
      },
    );
    if (!response.ok) return;
    const value: any = await response.json();
    const item = value?.data?.items?.find((row: any) =>
      String(row?.note_id ?? row?.noteId ?? row?.note_card?.note_id ?? row?.note_card?.noteId) === noteId,
    ) ?? value?.data?.note_card ?? value?.data?.noteCard;
    if (!item || typeof item !== "object") return;
    const card = item.note_card && typeof item.note_card === "object" ? item.note_card : item;
    if (String(card.note_id ?? card.noteId ?? noteId) !== noteId) return;
    return { noteId, ...card } as Record<string, unknown>;
  } catch {
    return;
  }
}
/** Exchange a public share link for a token-bearing page in the authenticated
 * Yuanbao renderer. This function is serialized into that page. */
async function requestWechatFinderPlayable(shareUrl: string): Promise<Record<string, unknown>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (location.origin !== "https://yuanbao.tencent.com")
      return { state: "unavailable" };
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), 25000);
    const response = await globalThis.fetch("/api/weixin/get_parse_result", {
      method: "POST",
      credentials: "same-origin",
      signal: controller.signal,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ type: "video_channel_url", url: shareUrl, scene: 1 }),
    });
    let payload: unknown;
    if (response.ok)
      payload = await response.json();
    return { status: response.status, payload };
  } catch { return { state: "unavailable" }; }
  finally { if (timer) clearTimeout(timer); }
}
/** Read the feed from the exact short-lived official playback page. This
 * function is serialized into the Channels renderer. */
async function requestWechatFinderFeed(playbackUrl: string): Promise<Record<string, unknown>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (location.href !== playbackUrl)
      return { state: "unavailable" };
    const parsed = new URL(location.href);
    const token = parsed.searchParams.get("token");
    const exportId = parsed.searchParams.get("eid");
    if (!token || !exportId)
      return { state: "unavailable" };
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), 25000);
    const response = await globalThis.fetch(
      "/finder-preview/api/feed/get_feed_info",
      {
        method: "POST",
        credentials: "omit",
        signal: controller.signal,
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          baseReq: { generalToken: token },
          exportId,
        }),
      },
    );
    let payload: unknown;
    if (response.ok)
      payload = await response.json();
    return { status: response.status, payload };
  } catch { return { state: "unavailable" }; }
  finally { if (timer) clearTimeout(timer); }
}
async function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      signal.removeEventListener("abort", stop);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}
export async function sourcePage(
  sessions: SiteSessions,
  url: string,
  signal: AbortSignal,
  onCommentBatch?: (batch: CommentBatch) => void,
): Promise<RenderedSnapshot> {
  const platform = platformFor(url);
  const needsCommentLoad = !!onCommentBatch || ["twitter", "weibo", "douban", "wechat", "kuaishou", "toutiao", "xiaoyuzhou"].includes(platform);
  const target = sessions.targetFor(url);
  signal.throwIfAborted();
  const win = await sessions.open(target, false);
  const stop = () => sessions.release(win);
  signal.addEventListener("abort", stop, { once: true });
  let attached = false;
  const capturedMediaUrls: string[] = [];
  const bodies: Promise<void>[] = [];
  let received = 0;
  let captureError: unknown;
  const pending = new Map<string, string>();
  let documentReady: (()=>void)|undefined;
  const workIdFromUrl = workIdentityFromUrl;
  // Short links (for example v.douyin.com) do not contain the aweme id until
  // the renderer follows the redirect. Keep the requested id mutable and
  // fill it from the final first-party URL before installing comment filters.
  let workId = workIdFromUrl(url);
  const captureNetworkMedia = ["douyin", "twitter", "wechat", "wechat-channel", "kuaishou", "toutiao"].includes(platform);
  try {
    if (onCommentBatch || captureNetworkMedia) {
      win.webContents.debugger.attach("1.3");
      attached = true;
      win.webContents.debugger.on(
        "message",
        (_event: unknown, method: string, params: any) => {
          if (
            captureNetworkMedia &&
            method === "Network.responseReceived" &&
            capturedMediaUrls.length < 16 &&
            typeof params.response?.url === "string"
          ) {
            try {
              const media = new URL(params.response.url);
              const hls = /^(?:video\/|application\/(?:vnd\.apple\.mpegurl|x-mpegurl))/i.test(String(params.response.mimeType || "")) ||
                /\.m3u8(?:\?|$)/i.test(media.pathname);
              if (
                media.protocol === "https:" &&
                ((platform === "douyin" && /(?:douyinvod\.com|bytecdn\.cn|byteimg\.com|douyinstatic\.com|douyinpic\.com|pstatp\.com|zjcdn\.com|snssdk\.com|bytedance\.com|bytedance\.net|byted\.org|ixigua\.com|douyincdn\.com|amemv\.com|muscdn\.com)$/i.test(media.hostname)) ||
                  (platform === "twitter" && /(?:^|\.)twimg\.com$/i.test(media.hostname)) ||
                  ((platform === "wechat" || platform === "wechat-channel") &&
                    /(?:^|\.)finder\.video\.qq\.com$/i.test(media.hostname)) ||
                  (platform === "kuaishou" && /(?:^|\.)(?:ks-cdn|kwimgs|kwaicdn|gifshow)\.com$/i.test(media.hostname)) ||
                  (platform === "toutiao" && /(?:^|\.)(?:toutiaoimg\.cn|ixigua\.com|byteimg\.com|pstatp\.com)$/i.test(media.hostname))) &&
                (params.response.status === 200 || params.response.status === 206) &&
                (/^(?:video\/|application\/(?:vnd\.apple\.mpegurl|x-mpegurl))/i.test(String(params.response.mimeType || "")) ||
                  /\.m3u8(?:\?|$)/i.test(media.pathname) ||
                  /\.(?:mp4|webm)(?:\?|$)/i.test(media.pathname) ||
                  /(?:video|play|media)/i.test(media.pathname))
              ) {
                const captured = hls ? `${media.href}#clip2md-hls` : media.href;
                if (hls) capturedMediaUrls.unshift(captured);
                else capturedMediaUrls.push(captured);
              }
            } catch {
              /* Ignore malformed or non-media response URLs. */
            }
          }
          if (!onCommentBatch || !workId) return;
          if (method === "Network.responseReceived" && received < 50) {
            let endpoint: URL;
            try {
              endpoint = new URL(params.response.url);
            } catch {
              return;
            }
            const expected =
              platform === "douyin"
                ? "/aweme/v1/web/comment/list/"
                : "/api/sns/web/v2/comment/page";
            const id = endpoint.searchParams.get(
              platform === "douyin" ? "aweme_id" : "note_id",
            );
            if (
              endpoint.pathname === expected &&
              id === workId &&
              platformFor(endpoint.href) === platform &&
              params.response.status === 200
            ) {
              received++;
              pending.set(params.requestId, endpoint.href);
            }
          }
          if (
            method !== "Network.loadingFinished" ||
            !pending.has(params.requestId)
          )
            return;
          const endpoint = pending.get(params.requestId)!;
          pending.delete(params.requestId);
          bodies.push(
            (async () => {
              const body = await win.webContents.debugger.sendCommand(
                "Network.getResponseBody",
                { requestId: params.requestId },
              );
              if (
                !signal.aborted &&
                typeof body.body === "string" &&
                body.body.length <= 2 * 1024 * 1024 &&
                !body.base64Encoded
              ) {
                let payload: unknown;
                try {
                  payload = JSON.parse(body.body);
                } catch {
                  throw new Error("原站评论响应格式无效");
                }
                onCommentBatch({ platform, workId, payload, url: endpoint });
              }
            })().catch((error) => {
              captureError = error;
            }),
          );
        },
      );
      // Give CDP a short opportunity to enable network events before
      // navigation. A renderer that never acknowledges must not block login or
      // page capture indefinitely.
      const enabled = win.webContents.debugger
        .sendCommand("Network.enable", {
          maxResourceBufferSize: 256 * 1024,
          maxTotalBufferSize: 4 * 1024 * 1024,
        })
        .catch(() => undefined);
      await withAbort(
        Promise.race([
          enabled,
          new Promise<void>((resolve) => setTimeout(resolve, 150)),
        ]),
        signal,
      );
    }
    await withAbort(new Promise<void>((resolve,reject)=>{
      documentReady=()=>{const current:unknown=win.webContents.getURL?.();if(typeof current==='string'&&sessions.allowed(target,current))resolve();};
      win.webContents.on('dom-ready',documentReady);
      void win.loadURL(url).then(resolve,reject);
    }), signal);
    signal.throwIfAborted();
    if (!workId) {
      const navigated = win.webContents.getURL?.();
      if (typeof navigated === "string") workId = workIdFromUrl(navigated);
    }
    if (onCommentBatch && platform === "xiaohongshu") {
      // The XHS note shell resolves navigation before its comment component
      // mounts; wait for the real list instead of scrolling the page shell.
      for (let attempt = 0; attempt < 20; attempt++) {
        const ready = await withAbort(
          win.webContents.executeJavaScript(
            `Boolean(document.querySelector('[class*="comment-container"], [class*="comment-list"], [data-e2e="comment-list"]'))`,
            false,
          ) as Promise<boolean>,
          signal,
        );
        if (ready) break;
        await pause(500, signal);
      }
    }
    if (onCommentBatch && platform === "zhihu" && workId) {
      await withAbort(
        win.webContents.executeJavaScript(
          `(${openZhihuComments.toString()})(${JSON.stringify(workId)})`,
          false,
        ) as Promise<unknown>,
        signal,
      );
      await pause(2500, signal);
    }
    if (onCommentBatch && platform === "csdn") {
      // CSDN's static HTML contains the side-panel button before its comment
      // script attaches the click handler. Give the page a short settling
      // window, then retry until a real row is rendered.
      await pause(2200, signal);
      for (let attempt = 0; attempt < 12; attempt++) {
        const ready = await withAbort(
          win.webContents.executeJavaScript(
            `Boolean(document.querySelector('.go-side-comment, [data-report-click*="comment"]'))`,
            false,
          ) as Promise<boolean>,
          signal,
        );
        if (ready) break;
        await pause(500, signal);
      }
      for (let attempt = 0; attempt < 5; attempt++) {
        await withAbort(
          win.webContents.executeJavaScript(
            `(${openCsdnComments.toString()})()`,
            false,
          ) as Promise<unknown>,
          signal,
        );
        await pause(1200, signal);
        const rows = await withAbort(
          win.webContents.executeJavaScript(
            `document.querySelectorAll('.comment-list-box .comment-list-item').length`,
            false,
          ) as Promise<number>,
          signal,
        );
        if (rows > 0) break;
      }
    }
    for (let i = 0; i < (needsCommentLoad ? 12 : 3); i++) {
      await pause(1000, signal);
      if (needsCommentLoad)
        await withAbort(
          win.webContents.executeJavaScript(
            `(${scrollComments.toString()})()`,
            false,
          ) as Promise<unknown>,
          signal,
        );
    }
    if (onCommentBatch && platform === "zhihu" && workId) {
      const payload = await withAbort(
        win.webContents.executeJavaScript(
          `(${requestZhihuComments.toString()})(${JSON.stringify(workId)})`,
          false,
        ) as Promise<Record<string, unknown> | undefined>,
        signal,
      );
      if (payload)
        onCommentBatch({
          platform,
          workId,
          payload,
          url: `https://www.zhihu.com/api/v4/answers/${encodeURIComponent(workId)}/comments`,
        });
    }
    if (onCommentBatch && platform === "xiaohongshu" && workId) {
      // The XHS API can deliver the next page before CDP emits its loading
      // event. The rendered top-level rows are an identity-safe fallback and
      // include every page that the authenticated scroller has visibly loaded.
      const rows = await withAbort(
        win.webContents.executeJavaScript(
          `(${pageComments.toString()})()`,
          false,
        ) as Promise<Array<Record<string, unknown>>>,
        signal,
      );
      if (Array.isArray(rows) && rows.length)
        onCommentBatch({
          platform,
          workId,
          payload: { success: true, data: { comments: rows } },
          url: `https://edith.xiaohongshu.com/api/sns/web/v2/comment/page?note_id=${encodeURIComponent(workId)}`,
        });
    }
    if (onCommentBatch && platform === "douyin" && workId) {
      try {
        await withAbort(
          win.webContents.executeJavaScript(
            `(${requestDouyinComments.toString()})(${JSON.stringify(workId)})`,
            false,
          ) as Promise<unknown>,
          signal,
        );
        await pause(500, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        // The page may not expose its signer; the normal scroll/request path
        // remains authoritative and will report a precise empty-response state.
      }
    }
    let snapshot = await withAbort(
      win.webContents.executeJavaScript(
        `(${snapshotPage.toString()})()`,
        false,
      ) as Promise<RenderedSnapshot>,
      signal,
    );
    if (platform === "wechat-channel") {
      const shareUrl = wechatChannelsShareAddress(url);
      if (!shareUrl)
        throw new Error("无法识别视频号分享链接");
      // Yuanbao alone issues the short-lived token-bearing playback page.
      // Keep that credential in a separate official page, matching the page
      // boundary used by qiaomu-clipper.
      const yuanbao = await sessions.open("wechat-channel", false);
      const stopYuanbao = () => sessions.release(yuanbao);
      signal.addEventListener("abort", stopYuanbao, { once: true });
      try {
        await withAbort(yuanbao.loadURL("https://yuanbao.tencent.com/"), signal);
        const parsedResponse = await withAbort(
          yuanbao.webContents.executeJavaScript(
            `(${requestWechatFinderPlayable.toString()})(${JSON.stringify(shareUrl)})`,
            false,
          ) as Promise<Record<string, unknown>>,
          signal,
        );
        const parsed = wechatChannelsPlayableFromParse(parsedResponse);
        if (parsed.state === "login")
          throw new AuthorizationRequired(
            "腾讯元宝登录状态已失效，请重新登录后继续视频号采集",
          );
        if (parsed.state !== "ready")
          throw new Error(
            "腾讯元宝未返回视频号播放地址，分享链接可能已失效或当前账号无权观看",
          );
        if (!wechatChannelsPlayableAddress(parsed.address))
          throw new Error("腾讯元宝返回的视频号播放地址无效");
        const player = await sessions.open("wechat-channel", false);
        const stopPlayer = () => sessions.release(player);
        signal.addEventListener("abort", stopPlayer, { once: true });
        try {
          await withAbort(player.loadURL(parsed.address), signal);
          const detailResponse = await withAbort(
            player.webContents.executeJavaScript(
              `(${requestWechatFinderFeed.toString()})(${JSON.stringify(parsed.address)})`,
              false,
            ) as Promise<Record<string, unknown>>,
            signal,
          );
          const status = Number(detailResponse.status || 0);
          if (
            status === 401 ||
            status === 403 ||
            (status >= 300 && status < 400)
          )
            throw new AuthorizationRequired(
              "视频号播放授权已失效，请重新登录腾讯元宝后继续采集",
            );
          if (detailResponse.state === "unavailable")
            throw new Error("视频号播放页未返回可核验的数据");
          const node = `<script type="application/json" data-clip2md-live-state="wechat-finder">${JSON.stringify(detailResponse).replace(/</g, "\\u003c")}</script>`;
          snapshot.html += node;
        } finally {
          signal.removeEventListener("abort", stopPlayer);
          sessions.release(player);
        }
      } finally {
        signal.removeEventListener("abort", stopYuanbao);
        sessions.release(yuanbao);
      }
    }
    let douyinDetail: Record<string, unknown> | undefined;
    let xhsDetail: Record<string, unknown> | undefined;
    const xhsWorkId = platform === "xiaohongshu"
      ? new URL(url).pathname.match(/^\/(?:zh\/)?(?:explore|discovery\/item)\/([a-f0-9]{24})(?:\/|$)/i)?.[1]
      : undefined;
    if (xhsWorkId) {
      const parsed = new URL(url);
      xhsDetail = await withAbort(
        win.webContents.executeJavaScript(
          `(${requestXhsDetail.toString()})(${JSON.stringify(xhsWorkId)},${JSON.stringify(parsed.searchParams.get("xsec_token") || "")})`,
          false,
        ) as Promise<Record<string, unknown> | undefined>,
        signal,
      );
      if (xhsDetail) {
        const node = `<script type="application/json" data-clip2md-live-state="xiaohongshu-api">${JSON.stringify(xhsDetail).replace(/</g, "\\u003c")}</script>`;
        if (!onCommentBatch && /(?:请先登录|请登录后查看|登录后查看|登录后继续访问|安全验证|访问验证|访问环境异常|验证码|滑块验证)/.test(snapshot.html))
          snapshot = { url, html: `<html><head><title>小红书笔记</title></head><body>${node}</body></html>`, audios: [], videos: [] };
        else
          snapshot.html += node;
      }
    }
    if (platform === "douyin" && workId) {
      const challenge = /(?:验证码中间页|安全验证|访问验证|请完成验证|滑块验证)/.test(snapshot.html);
      if (challenge) {
        // The challenge shell blocks detail and comment endpoints. The same
        // authenticated partition can still access them after loading the
        // public feed, so keep the debugger listener alive and switch briefly.
        await withAbort(win.loadURL("https://www.douyin.com/"), signal);
        await pause(1000, signal);
      }
      douyinDetail = await withAbort(
        win.webContents.executeJavaScript(
          `(${requestDouyinDetail.toString()})(${JSON.stringify(workId)})`,
          false,
        ) as Promise<Record<string, unknown> | undefined>,
        signal,
      );
      if (douyinDetail) {
        const node = `<script type="application/json" data-clip2md-live-state="douyin-api">${JSON.stringify(douyinDetail).replace(/</g, "\\u003c")}</script>`;
        if (challenge) {
          if (onCommentBatch) {
            await withAbort(
              win.webContents.executeJavaScript(
                `(${requestDouyinComments.toString()})(${JSON.stringify(workId)})`,
                false,
              ) as Promise<unknown>,
              signal,
            );
            await pause(1000, signal);
          }
          snapshot = { url, html: `<html><head><title>抖音作品</title></head><body>${node}</body></html>`, audios: [], videos: [] };
        } else {
          snapshot.html += node;
        }
      }
    }
    if (capturedMediaUrls.length) {
      snapshot.videos = [
        ...capturedMediaUrls.map((src) => ({
          src,
          playing: false,
          visible: true,
          area: 0,
          identities: workId ? [workId] : [],
        })),
        ...snapshot.videos,
      ].slice(0, 32);
    }
    if (
      !sessions.allowed(target,snapshot.url) || platformFor(snapshot.url) !== platform ||
      ((platform === "douyin" || platform === "xiaohongshu") &&
        new URL(url).pathname !== "/" && !workIdFromUrl(snapshot.url) &&
        !(platform === "douyin" && workId && /^\/(?:jingxuan)?$/.test(new URL(snapshot.url).pathname))) ||
      (workId && workIdFromUrl(snapshot.url) !== workId)
    )
      throw new AuthorizationRequired(
        "页面跳转到登录或其他作品，请在原站授权后重试",
      );
    if (
      platform === "douyin" &&
      /(?:验证码中间页|安全验证|访问验证|请完成验证|滑块验证)/.test(snapshot.html) &&
      !douyinDetail
    )
      throw new AuthorizationRequired(
        "抖音原站出现验证码或访问验证，请在登录窗口完成验证后重试",
      );
    await withAbort(Promise.all(bodies), signal);
    signal.throwIfAborted();
    if (captureError)
      throw captureError instanceof Error
        ? captureError
        : new Error("评论采集失败");
    return snapshot;
  } finally {
    if(documentReady)win.webContents.removeListener('dom-ready',documentReady);
    signal.removeEventListener("abort", stop);
    if (attached && !win.isDestroyed()) {
      try {
        win.webContents.debugger.detach();
      } catch {
        /* Window already stopped. */
      }
    }
    sessions.release(win);
  }
}

/** Select a route-specific work identity without confusing a containing page. */
export function workIdentityFromUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    // Answer URLs can also contain broad article or video path segments.
    const answerId = parsed.pathname.match(/\/answer\/([1-9]\d{0,19})(?:\/|$)/)?.[1];
    const pathId = parsed.pathname.match(
      /\/(?:video|explore|discovery\/item|status|article|article\/details|p|note|short-video|opus)\/([A-Za-z0-9]+)/,
    )?.[1];
    const modalId = parsed.searchParams.get("modal_id") ||
      parsed.searchParams.get("aweme_id");
    return answerId || pathId || (/^[1-9]\d{0,19}$/.test(modalId || "") ? modalId || undefined : undefined);
  } catch {
    return;
  }
}
