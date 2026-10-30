import { createHash } from "node:crypto";
import { readPublicJson } from "./adapters/network";
import { AuthorizationRequired, type SiteSessions } from "./auth";
import { standardComments } from './adapters/authenticated-page';
import { canonicalDouyinVideoUrl } from './adapters/sites';
import { nowBeijingDateTime, formatBeijingDateTime } from './date-format';
import { sourcePage } from "./page-source";
import type { PlatformName } from "./config";
export interface SourceComment {
  id: string;
  author: string;
  text: string;
  publishedAt?: string;
  likes?: number;
}
export interface CommentBatch {
  platform: PlatformName;
  workId: string;
  payload: any;
  url: string;
}
export interface CommentResult {
  comments: SourceComment[];
  capturedAt: string;
  coverage: string;
  reportedTotal?: number;
}
const table = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];
export function signBilibili(
  params: Record<string, string>,
  key: string,
  now = Math.floor(Date.now() / 1000),
): string {
  const values = { ...params, wts: String(now) };
  const query = Object.keys(values)
    .sort()
    .map(
      (k) =>
        encodeURIComponent(k) +
        "=" +
        encodeURIComponent(
          values[k as keyof typeof values].replace(/[!'()*]/g, ""),
        ),
    )
    .join("&");
  return (
    query +
    "&w_rid=" +
    createHash("md5")
      .update(query + key)
      .digest("hex")
  );
}
function comment(row: any, platform: PlatformName): SourceComment | undefined {
  if (!row || typeof row !== "object") return;
  const rawId =
    platform === "bilibili"
      ? (row.rpid_str ?? row.rpid)
      : platform === "douyin"
        ? row.cid
        : row.id;
  const text =
    platform === "bilibili"
      ? row.content?.message
      : platform === "douyin"
        ? row.text
        : platform === "zhihu"
          ? String(row.content || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
          : row.content;
  const author =
    platform === "bilibili"
      ? row.member?.uname
      : platform === "douyin"
        ? row.user?.nickname
        : platform === "zhihu"
          ? row.author?.member?.name
          : row.user_info?.nickname;
  if (
    !["string", "number"].includes(typeof rawId) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(String(rawId)) ||
    typeof text !== "string" ||
    !text.trim() ||
    text.length > 10000
  )
    return;
  const timestamp =
    platform === "bilibili"
      ? row.ctime
      : platform === "douyin"
        ? row.create_time
        : platform === "zhihu"
          ? row.created_time
          : row.create_time / 1000;
  const likes = Number(
    platform === "bilibili"
      ? row.like
      : platform === "douyin"
        ? row.digg_count
        : platform === "zhihu"
          ? row.vote_count
          : row.like_count,
  );
  return {
    id: String(rawId),
    text,
    author: typeof author === "string" ? author.slice(0, 200) : "",
    publishedAt:
      Number.isFinite(timestamp) &&
      timestamp > 0 &&
      timestamp <= Date.now() / 1000
        ? formatBeijingDateTime(timestamp * 1000)
        : undefined,
    likes: Number.isSafeInteger(likes) && likes >= 0 ? likes : undefined,
  };
}
export function parseCommentBatch(batch: CommentBatch): SourceComment[] {
  const p = batch.payload;
  if (batch.platform === "douyin") {
    if (p.status_code !== 0) {
      const code = Number(p.status_code);
      if ([4, 5, 8, 9, 401, 403].includes(code))
        throw new AuthorizationRequired("抖音评论接口要求登录或访问验证");
      throw new Error("抖音评论接口返回异常，可能触发了原站风控，请稍后重试");
    }
    if (!Array.isArray(p.comments))
      throw new Error("抖音评论接口未返回评论列表，可能尚未展开评论或页面仍在加载");
    return p.comments
      .filter(
        (r: any) =>
          r.aweme_id === undefined || String(r.aweme_id) === batch.workId,
      )
      .map((r: any) => comment(r, batch.platform))
      .filter(Boolean);
  }
  if (batch.platform === "xiaohongshu") {
    if (p.success !== true || !Array.isArray(p.data?.comments))
      throw new Error("小红书评论接口未返回评论列表，页面可能未展开评论或当前作品没有一级评论");
    return p.data.comments
      .filter(
        (r: any) =>
          r.note_id === undefined || String(r.note_id) === batch.workId,
      )
      .map((r: any) => comment(r, batch.platform))
      .filter(Boolean);
  }
  if (batch.platform === "zhihu") {
    if (!Array.isArray(p.data))
      throw new Error("知乎评论接口未返回评论列表，页面可能未展开评论或当前回答没有一级评论");
    return p.data
      .filter((r: any) => r.resource_type === undefined || r.resource_type === "answer")
      .map((r: any) => comment(r, batch.platform))
      .filter(Boolean);
  }
  if (
    p.code !== 0 ||
    !p.data ||
    (p.data.replies !== null && !Array.isArray(p.data.replies))
  )
    throw new Error("B站评论接口未返回评论列表，页面可能未展开评论或当前作品没有一级评论");
  return [...(p.data.top_replies || []), ...(p.data.replies || [])]
    .map((r) => comment(r, "bilibili"))
    .filter((r): r is SourceComment => !!r);
}
export async function collectComments(
  url: string,
  platform: PlatformName,
  limit: number,
  sessions: SiteSessions,
  signal: AbortSignal,
): Promise<CommentResult> {
  if(!['bilibili','douyin','xiaohongshu','zhihu'].includes(platform)) {
    // CSDN renders comments in a lazy side panel. Passing a no-op batch
    // handler enables sourcePage's bounded panel-opening/scroll path without
    // treating DOM rows as network comment batches.
    const snapshot=await sourcePage(sessions,url,signal,platform==='csdn'?(()=>undefined):undefined);
    return {comments:standardComments(snapshot,platform,limit),capturedAt:nowBeijingDateTime(),coverage:'原站页面当前实际加载且有稳定标识的评论样本，不代表全量评论或回复'};
  }
  const comments = new Map<string, SourceComment>();
  let reportedTotal: number | undefined;
  let observed = false;
  if (platform === "bilibili") {
    const id = new URL(url).pathname.match(
      /\/video\/(BV[A-Za-z0-9]{10}|av\d+)/,
    )?.[1];
    if (!id) throw new Error("评论采集需要B站完整作品链接");
    const view = await readPublicJson(
      "https://api.bilibili.com/x/web-interface/view?" +
        (id.startsWith("BV") ? "bvid=" + id : "aid=" + id.slice(2)),
      signal,
    );
    if (
      view.code !== 0 ||
      !Number.isSafeInteger(view.data?.aid) ||
      (id.startsWith("BV")
        ? view.data.bvid !== id
        : String(view.data.aid) !== id.slice(2))
    )
      throw new Error("B站评论作品身份不一致");
    const nav = await readPublicJson(
      "https://api.bilibili.com/x/web-interface/nav",
      signal,
    );
    const image = nav.data?.wbi_img;
    const stem = (value: string) =>
      new URL(value).pathname.split("/").pop()!.split(".")[0];
    if (
      typeof image?.img_url !== "string" ||
      typeof image?.sub_url !== "string"
    )
      throw new AuthorizationRequired("B站签名信息不可用，请授权后重试");
    const combined = stem(image.img_url) + stem(image.sub_url);
    if (combined.length !== 64) throw new Error("B站签名信息结构无效");
    const key = table
      .map((i) => combined[i])
      .join("")
      .slice(0, 32);
    let cursor = "";
    for (
      let page = 0;
      page < Math.ceil(limit / 20) + 2 && comments.size < limit;
      page++
    ) {
      signal.throwIfAborted();
      const query = signBilibili(
        {
          oid: String(view.data.aid),
          type: "1",
          mode: "3",
          ps: "20",
          pagination_str: JSON.stringify({ offset: cursor }),
          web_location: "1315875",
        },
        key,
      );
      const payload = await readPublicJson(
        "https://api.bilibili.com/x/v2/reply/wbi/main?" + query,
        signal,
        "https://www.bilibili.com/",
      );
      const rows = parseCommentBatch({
        platform,
        workId: String(view.data.aid),
        payload,
        url,
      });
      observed = true;
      for (const row of rows) {
        comments.set(row.id, row);
        if (comments.size >= limit) break;
      }
      const total = payload.data.cursor?.all_count;
      if (Number.isSafeInteger(total) && total >= 0) reportedTotal = total;
      const next = payload.data.cursor?.pagination_reply?.next_offset;
      if (payload.data.cursor?.is_end === true || !next || next === cursor)
        break;
      cursor = String(next);
    }
  } else {
    const sourceUrls = platform === "douyin"
      ? [
          canonicalDouyinVideoUrl(url) || url,
          (() => {
            const id = canonicalDouyinVideoUrl(url)?.match(/\/video\/(\d+)$/)?.[1];
            return id ? `https://www.iesdouyin.com/share/video/${id}/?from_ssr=1` : url;
          })(),
        ]
      : [url];
    let lastError: unknown;
    for (const sourceUrl of [...new Set(sourceUrls)]) {
      try {
        await sourcePage(sessions, sourceUrl, signal, (batch) => {
          const rows = parseCommentBatch(batch);
          observed = true;
          for (const row of rows) {
            if (comments.size < limit) comments.set(row.id, row);
          }
        });
        if (observed) break;
      } catch (error) {
        if (signal.aborted) throw error;
        lastError = error;
      }
    }
    if (!observed && lastError instanceof AuthorizationRequired) throw lastError;
  }
  if (!observed)
    throw new Error(
      "原站页面未返回可核验的评论，请先打开原帖评论后重试；这不等同于登录失效",
    );
  return {
    comments: [...comments.values()],
    reportedTotal,
    capturedAt: nowBeijingDateTime(),
    coverage:
      platform === "bilibili"
        ? "按原站热门排序分页采集的一级评论，不含回复正文，不代表全量评论"
        : "独立原站页面实际加载的一级评论样本，排序由原站页面决定；不含回复正文，不代表全量评论",
  };
}
export function renderComments(result: CommentResult): string {
  const literal = (s: string) => s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return (
    `采集时间：${result.capturedAt}\n\n采集数量：${result.comments.length}${result.reportedTotal === undefined ? "" : ` / 原站报告 ${result.reportedTotal}`}\n\n范围：${result.coverage}\n\n` +
    result.comments
      .map(
        (c) =>
          `### ${literal(c.author || "原站未提供昵称")}\n\n评论 ID：${c.id}${c.publishedAt ? " · " + c.publishedAt : ""}${c.likes === undefined ? "" : " · 赞 " + c.likes}\n\n${literal(c.text)}`,
      )
      .join("\n\n---\n\n")
  );
}
