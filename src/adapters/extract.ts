import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import {
  readArticleMetrics,
  readArticleAccessWarnings,
} from "./article-metrics";
import { literalWechatDate } from "./source-date";
import { wechatAccessError } from "./wechat-access";
import { normalizeWechatCode } from "./wechat-code";
import { sourceTableMarkdown } from "./source-table";
import { extractSitePage, localSite, siteAccessRequired } from "./sites";
import type { MetricSnapshot } from "../note-properties";
export type ExtractedImageFetcher = (
  url: string,
  signal: AbortSignal,
) => Promise<{
  status: number;
  arrayBuffer: ArrayBuffer;
  headers: Record<string, string>;
}>;

export interface ExtractedContent {
  title: string;
  source_title?: string;
  markdown: string;
  author?: string;
  source?: string;
  source_date?: string;
  source_description?: string;
  tags?: string[];
  warnings?: string[];
  file_name?: string;
  file_ext?: string;
  attachments?: string[];
  /** Source-advertised cover/gallery URLs used by the separate local images job. */
  image_urls?: string[];
  duration_seconds?: number;
  transcription_source?: string;
  metrics?: MetricSnapshot;
  /** Ephemeral local capability; deliberately omitted from SyncTask and completion/persistence DTOs. */
  fetchImage?: ExtractedImageFetcher;
  /** A source gallery with no caption must retain a usable image; system gap messages are not source text. */
  requires_image_content?: boolean;
}
export class ArticleBodyUnavailable extends Error {}
export class ArticleAccessRequired extends Error {}

export function assertArticleSource(value: string): void {
  if (
    /(?:^|\.)(youtube\.com|youtu\.be|channels\.weixin\.qq\.com|channels\.wechat\.com)$/.test(
      new URL(value).hostname,
    )
  ) {
    throw new Error(
      "此站点本地适配尚未通过验收，任务保留供重试或按所选策略转云",
    );
  }
}

export function htmlToMarkdown(
  html: string,
  url: string,
  localImages?: ReadonlyMap<string, string>,
  options: { feishuBlocks?: boolean } = {},
): string {
  const document = new DOMParser().parseFromString(html, "text/html");
  document
    .querySelectorAll("script,style,iframe,form,input,button,noscript")
    .forEach((node) => node.remove());
  // Use explicit accessibility heading semantics; styling alone is not proof of a section title.
  for (const node of Array.from(
    document.querySelectorAll('[role="heading"][aria-level]'),
  )) {
    const level = node.getAttribute("aria-level") || "";
    if (
      !/^[1-6]$/.test(level) ||
      node.closest("pre,code,table,blockquote,li") ||
      node.querySelector("h1,h2,h3,h4,h5,h6,img,table,pre")
    )
      continue;
    const heading = document.createElement(`h${level}`);
    heading.append(...Array.from(node.childNodes));
    node.replaceWith(heading);
  }
  // Sphinx and syntax highlighters often put spans directly inside <pre>.
  // Turndown's fenced-code rule expects a single <code> child instead.
  for (const pre of Array.from(document.querySelectorAll("pre"))) {
    pre
      .querySelectorAll("br")
      .forEach((node) => node.replaceWith(document.createTextNode("\n")));
    const language =
      pre
        .querySelector("code")
        ?.className.match(/\blanguage-[a-z0-9_-]+\b/i)?.[0] ||
      pre.className.match(/\blanguage-[a-z0-9_-]+\b/i)?.[0];
    const code = document.createElement("code");
    code.textContent = pre.textContent || "";
    if (language) code.className = language;
    pre.replaceChildren(code);
  }
  // The downloaded HTML has not run the site's lazy-loading JavaScript.
  for (const image of Array.from(document.querySelectorAll("img"))) {
    let inlineFallback: string | undefined;
    for (const name of ["data-src", "data-original", "data-actualsrc", "src"]) {
      const value = image.getAttribute(name)?.trim();
      if (!value) continue;
      try {
        const target = new URL(value, url);
        if (["http:", "https:"].includes(target.protocol)) {
          image.setAttribute("src", target.href);
          inlineFallback = undefined;
          break;
        }
        // A lazy-load placeholder must not hide a later real source.
        if (/^data:image\/(png|jpeg|gif|webp|avif);base64,/i.test(value))
          inlineFallback ??= value;
      } catch {
        /* Try the next site-supplied source. */
      }
    }
    if (inlineFallback) image.setAttribute("src", inlineFallback);
  }
  for (const node of Array.from(document.querySelectorAll("[src],[href]"))) {
    for (const attribute of ["src", "href"]) {
      const value = node.getAttribute(attribute);
      if (!value) continue;
      try {
        const target = new URL(value, url);
        if (["http:", "https:"].includes(target.protocol))
          node.setAttribute(attribute, target.href);
        else if (
          !(
            attribute === "src" &&
            /^data:image\/(png|jpeg|gif|webp|avif);base64,/i.test(value)
          )
        )
          node.removeAttribute(attribute);
      } catch {
        node.removeAttribute(attribute);
      }
    }
  }
  const converter = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
  if (options.feishuBlocks) {
    converter.addRule("feishuListRestart", {
      filter: (node) => node.getAttribute("data-clip2md-list-break") === "true",
      replacement: () => "\n\n<!-- clip2md-source-list-restart -->\n\n",
    });
    converter.addRule("feishuTaskItem", {
      filter: (node) =>
        node.nodeName === "LI" &&
        ["checked", "unchecked"].includes(
          node.getAttribute("data-clip2md-task") || "",
        ),
      replacement: (content, node) =>
        `- [${node.getAttribute("data-clip2md-task") === "checked" ? "x" : " "}] ${content.trim().replace(/\n/g, "\n    ")}\n`,
    });
    converter.addRule("feishuSourceMath", {
      filter: (node) =>
        ["inline", "block"].includes(
          node.getAttribute("data-clip2md-math") || "",
        ),
      replacement: (_content, node) => {
        const source = (node.textContent || "").trim();
        if (!source) return "";
        return node.getAttribute("data-clip2md-math") === "block"
          ? `\n\n$$\n${source}\n$$\n\n`
          : `$${source}$`;
      },
    });
  }
  converter.addRule("tables", {
    filter: "table",
    replacement: (_content, node) =>
      sourceTableMarkdown(node as HTMLTableElement, (html) =>
        converter.turndown(html),
      ),
  });
  if (localImages?.size)
    converter.addRule("extractedVaultImages", {
      filter: (node) =>
        node.nodeName === "IMG" &&
        localImages.has(node.getAttribute("src") || ""),
      // Only caller-provided, already extracted attachments use Vault links.
      // A root-qualified wiki embed also survives moving the resulting note.
      replacement: (_content, node) =>
        `![[${localImages.get(node.getAttribute("src") || "")}]]`,
    });
  return converter.turndown(document.body.innerHTML).trim();
}

function publicationDate(raw: string): string | undefined {
  const match = raw
    .trim()
    .match(/^(\d{4})[-年](\d{1,2})[-月](\d{1,2})(?:日)?(?:T|\s|$)/);
  if (!match) return;
  const date = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === date
    ? date
    : undefined;
}

function withoutRepeatedTitle(markdown: string, title: string): string {
  return markdown.split("\n")[0]?.replace(/^#\s+/, "").trim() === title
    ? markdown.replace(/^#\s+[^\n]+\n*/, "")
    : markdown;
}

/** A page wrapper's title/link is not an extracted article, however long it is. */
function assertReadableBody(markdown: string, title: string): void {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  const content = markdown
    .split("\n")
    .filter((line) => {
      const heading = line.match(/^#{1,6}\s+(.+?)(?:\s+#+)?$/);
      return !heading || normalize(heading[1]) !== normalize(title);
    })
    .join("\n")
    .trim();
  const singleLink =
    /^(?:https?:\/\/[^\s]+|<https?:\/\/[^>\s]+>|\[[^\]\n]*\]\(<?https?:\/\/[^)\n]+\))$/i;
  if (
    !content ||
    normalize(content) === normalize(title) ||
    singleLink.test(content)
  ) {
    throw new ArticleBodyUnavailable(
      "尚未取得有效正文，来源仅包含标题或链接，请确认原文可访问后重试",
    );
  }
}

/** Validate extracted DOCX content before adding the original-file link or system notices. */
export function assertDocumentBody(markdown: string, title: string): void {
  const body = markdown
    .split("\n")
    .filter((line) => !/^#{1,6}\s+/.test(line))
    .join("\n");
  try {
    assertReadableBody(body, title);
  } catch {
    throw new Error("DOCX 未取得有效正文，仅有标题或链接；原件已保留");
  }
}

/** Explicit article-header fields on Python Insider's public article layout. */
function pythonInsiderMetadata(
  document: Document,
  url: string,
): Partial<ExtractedContent> | undefined {
  const source = new URL(url);
  if (source.hostname !== "blog.python.org") return;
  if (!/^\/\d{4}\/\d{2}\/[^/]+\/?$/.test(source.pathname))
    throw new Error("请提供 Python Insider 的具体文章链接");
  const header = document.querySelector("article > header");
  const title = header?.querySelector("h1")?.textContent?.trim();
  if (!title)
    throw new Error("尚未取得博客文章标题，请确认原文或页面布局是否变化");
  const sourceLinks = (prefix: string) =>
    Array.from(header!.querySelectorAll<HTMLAnchorElement>("a[href]")).filter(
      (link) => {
        try {
          const target = new URL(link.getAttribute("href") || "", url);
          return (
            target.origin === source.origin &&
            target.pathname.startsWith(prefix)
          );
        } catch {
          return false;
        }
      },
    );
  return {
    title,
    source: "Python Insider",
    author: sourceLinks("/authors/")[0]?.textContent?.trim() || undefined,
    // The first header time is the published date; the later one is Updated.
    source_date: publicationDate(
      header!
        .querySelector(":scope > div > time[datetime], :scope > time[datetime]")
        ?.getAttribute("datetime") || "",
    ),
    tags: [
      ...new Set(
        sourceLinks("/tags/")
          .map((link) => link.textContent?.trim() || "")
          .filter(Boolean),
      ),
    ],
  };
}

function wechatArticle(
  document: Document,
  url: string,
  meta: (name: string) => string,
): ExtractedContent {
  if (!/^\/s(?:\/|$)/.test(new URL(url).pathname))
    throw new Error("仅支持公众号图文文章链接，请提供原文地址");
  const content = document.querySelector("#js_content");
  if (!content) throw wechatAccessError(document);
  const clean = content.cloneNode(true) as HTMLElement;
  const mediaSelector =
    "iframe,video,audio,mpvoice,mp-video,qqmusic,mp-common-videosnap,mp-common-mpaudio";
  const hasMedia = Boolean(clean.querySelector(mediaSelector));
  // Player controls/fallback text are not extracted article content.
  clean
    .querySelectorAll(
      `script,style,noscript,form,input,button,${mediaSelector}`,
    )
    .forEach((node) => node.remove());
  normalizeWechatCode(clean);
  const text = clean.textContent?.trim() || "";
  const markdown = htmlToMarkdown(clean.innerHTML, url);
  const hasImage = /!\[[^\]]*\]\(https?:\/\//i.test(markdown);
  if (
    (text.length < 30 && !hasImage) ||
    !markdown ||
    /^(?:请登录|登录后查看|安全验证|验证码|访问环境异常|环境异常|该内容已被发布者删除)[\s\S]{0,180}$/.test(
      text,
    )
  ) {
    throw wechatAccessError(document);
  }
  const title =
    document.querySelector("#activity-name")?.textContent?.trim() ||
    meta("og:title") ||
    document.title.trim();
  if (!title) throw new Error("公众号文章缺少原始标题，请确认原文可访问");
  assertReadableBody(markdown, title);
  let date =
    publicationDate(meta("article:published_time")) ||
    publicationDate(meta("datePublished")) ||
    publicationDate(document.querySelector("#publish_time")?.textContent || "");
  if (!date) date = literalWechatDate(document);
  const warnings = hasMedia
    ? ["原文包含音视频，本次仅提取图文内容，音视频请从原文查看"]
    : [];
  return {
    title,
    source_title: title,
    markdown: withoutRepeatedTitle(markdown, title),
    source: "微信公众号",
    source_date: date,
    author: meta("author") || undefined,
    source_description:
      meta("description") || meta("og:description") || undefined,
    tags: [
      ...new Set(
        Array.from(
          document.querySelectorAll(
            'meta[property="article:tag"],meta[name="article:tag"]',
          ),
        ).flatMap((node) =>
          (node.getAttribute("content") || "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
        ),
      ),
    ],
    warnings,
  };
}

export function extractWebPage(
  html: string,
  url: string,
  options: { includeMetrics?: boolean } = {},
): ExtractedContent {
  assertArticleSource(url);
  const document = new DOMParser().parseFromString(html, "text/html");
  // Readability resolves links before Turndown. DOMParser otherwise inherits
  // Obsidian's app:// origin (or the test runner origin), losing source links.
  document.querySelectorAll("base").forEach((node) => node.remove());
  const base = document.createElement("base");
  base.href = url;
  document.head.prepend(base);
  const meta = (name: string) =>
    document
      .querySelector(`meta[property="${name}"],meta[name="${name}"]`)
      ?.getAttribute("content")
      ?.trim() || "";
  const withSourceMetadata = (result: ExtractedContent): ExtractedContent => {
    const warnings = [
      ...(result.warnings || []),
      ...readArticleAccessWarnings(document, url, result.title),
    ];
    const metrics = options.includeMetrics
      ? readArticleMetrics(document, url, result.title)
      : undefined;
    return {
      ...result,
      ...(warnings.length ? { warnings } : {}),
      ...(metrics ? { metrics } : {}),
    };
  };
  if (new URL(url).hostname === "mp.weixin.qq.com")
    return withSourceMetadata(wechatArticle(document, url, meta));
  if (localSite(url)) {
    const result = extractSitePage(
      html,
      url,
      htmlToMarkdown,
      options.includeMetrics,
    );
    if (!result || result.media)
      throw new Error(
        "此链接需要站点执行器获取字幕或媒体转写，不能将页面简介作为正文",
      );
    return result.content;
  }
  const password = Array.from(
    document.querySelectorAll('input[type="password"]'),
  ).some(
    (node) =>
      !node.closest(
        '[hidden],[aria-hidden="true"],[style*="display:none"],[style*="display: none"]',
      ),
  );
  const visible = document.body.cloneNode(true) as HTMLElement;
  visible
    .querySelectorAll('script,style,noscript,[hidden],[aria-hidden="true"]')
    .forEach((node) => node.remove());
  const visibleText = visible.textContent?.replace(/\s+/g, " ").trim() || "";
  if (
    password ||
    siteAccessRequired(html) ||
    /^\/(?:login|signin|sign-in)(?:\/|$)/i.test(new URL(url).pathname) ||
    /^(?:请登录|登录后查看|安全验证|验证码|access denied|verify you are human)[\s\S]{0,180}$/i.test(
      visibleText,
    )
  )
    throw new ArticleAccessRequired("来源返回登录或访问验证页面，尚未取得正文");
  const siteMetadata = pythonInsiderMetadata(document, url);
  const originalTitle = meta("og:title") || document.title;
  // Readability normally strips the explicit code-language classes before the
  // Markdown converter sees them. Preserve only those source declarations.
  const codeClasses = [
    ...new Set(
      Array.from(document.querySelectorAll("pre,pre code")).flatMap((node) =>
        Array.from(node.classList).filter((name) =>
          /^language-[a-z0-9_-]{1,64}$/i.test(name),
        ),
      ),
    ),
  ];
  const article = new Readability(document.cloneNode(true) as Document, {
    keepClasses: false,
    classesToPreserve: codeClasses,
  }).parse();
  if (!article?.content)
    throw new ArticleBodyUnavailable(
      "未取得正文，可能需要登录或该站点尚未支持",
    );
  const text = article.textContent?.trim() || "";
  if (
    text.length < 600 &&
    /访问过于频繁|访问环境异常|验证后继续|请在微信中打开|扫码登录|verify you are human/i.test(
      text,
    )
  )
    throw new ArticleAccessRequired("来源为访问验证页，尚未取得正文");
  if (
    /^(请登录|登录后查看|安全验证|验证码|打开\s*App|access denied|verify you are human)[\s\S]{0,180}$/i.test(
      text,
    )
  )
    throw new ArticleAccessRequired(
      "来源返回登录、验证或空内容，请在浏览器确认原文可访问后重试",
    );
  if (
    text.length < 200 &&
    /^(?:(?:please\s+)?(?:enable|turn on)\s+javascript\b[\s\S]{0,140}|you need to enable javascript\b[\s\S]{0,140}|(?:loading|please wait)[.!…\s]*|(?:正在加载|加载中|请稍候)[\s\S]{0,120})$/i.test(
      text,
    )
  )
    throw new ArticleBodyUnavailable(
      "来源尚未加载文章正文，请启用动态候选或稍后重试",
    );
  if (text.length < 30)
    throw new ArticleBodyUnavailable(
      "来源尚未提供可读取正文，可能仍在加载或需要登录",
    );
  const title = (
    siteMetadata?.title ||
    article.title ||
    originalTitle ||
    "未命名网页"
  ).trim();
  const markdown = withoutRepeatedTitle(
    htmlToMarkdown(article.content, url),
    title,
  );
  assertReadableBody(markdown, title);
  const rawDate = meta("article:published_time") || meta("datePublished");
  const sourceDate = publicationDate(rawDate);
  // A byline is site-supplied; there is no LLM or sharing-user substitution here.
  const tags = meta("article:tag")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  return withSourceMetadata({
    title,
    source_title:
      siteMetadata?.title || article.title || originalTitle || undefined,
    markdown,
    source: article.siteName || new URL(url).hostname,
    author: article.byline || meta("author") || undefined,
    source_date: sourceDate,
    source_description:
      meta("description") || meta("og:description") || undefined,
    tags,
    ...siteMetadata,
  });
}

export function extractPlainText(
  value: string,
  filename: string,
): ExtractedContent {
  const markdown = value.replace(/^\uFEFF/, "").trim();
  if (!markdown || markdown.includes("\u0000"))
    throw new Error("文件为空或不是有效的 UTF-8 文本");
  return {
    title: filename.replace(/\.(txt|md|markdown)$/i, "") || "文本",
    markdown,
  };
}

export function extractPlainTextBytes(
  bytes: ArrayBuffer,
  filename: string,
): ExtractedContent {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(
      "原文件不是有效的 UTF-8 文本，请另存为 UTF-8 后重新导入；原件已保留",
    );
  }
  return extractPlainText(text, filename);
}
