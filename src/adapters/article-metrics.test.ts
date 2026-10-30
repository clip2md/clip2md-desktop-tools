// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readArticleMetrics, wantsArticleMetrics } from "./article-metrics";
import { extractWebPage } from "./extract";

const url = "https://source.example/posts/article/?utm_source=inbox";
const title = "一篇完整的原始文章";
const counter = (action: string, count: unknown) => ({
  "@type": "InteractionCounter",
  interactionType: { "@type": action },
  userInteractionCount: count,
});
const article = (statistics: unknown, extra: Record<string, unknown> = {}) => ({
  "@context": "https://schema.org",
  "@type": "BlogPosting",
  url: "https://source.example/posts/article",
  headline: title,
  interactionStatistic: statistics,
  ...extra,
});
const documentFor = (data: unknown) =>
  new DOMParser().parseFromString(
    `<html><head><title>${title}</title><script type="application/ld+json">${JSON.stringify(data)}</script></head><body><article><h1>${title}</h1><p>${"这里是作者提供的完整正文，包含足够的信息用于提取，保持内容与段落顺序。".repeat(20)}</p></article></body></html>`,
    "text/html",
  );
afterEach(() => vi.useRealTimers());

describe("source article interaction counters", () => {
  it("keeps exact counters and true zero with the actual observation time, without inventing coins", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-18T03:00:00Z"));
    const document = documentFor(
      article([
        counter("ViewAction", "2048"),
        counter("LikeAction", 0),
        counter("BookmarkAction", 3),
        counter("CommentAction", 7),
        counter("ShareAction", 2),
        counter("PayAction", 99),
      ]),
    );
    const before = document.documentElement.outerHTML;
    expect(readArticleMetrics(document, url, title)).toEqual({
      views: 2048,
      likes: 0,
      collects: 3,
      comments: 7,
      shares: 2,
      metrics_captured_at: "2026-10-18 11:00:00",
    });
    expect(document.documentElement.outerHTML).toBe(before);
  });
  it("resolves a graph counter for the actual article and ignores website, related article and embedded video counts", () => {
    const data = {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "WebSite",
          interactionStatistic: counter("ViewAction", 9999),
        },
        {
          ...article({ "@id": "#views" }),
          "@context": undefined,
          "@id": "#article",
        },
        { "@id": "#views", ...counter("ViewAction", 0) },
        article(counter("ViewAction", 9000), {
          url: "https://source.example/posts/other",
        }),
        {
          "@type": "VideoObject",
          "@id": "#video",
          interactionStatistic: counter("ViewAction", 8000),
        },
      ],
    };
    expect(readArticleMetrics(documentFor(data), url, title)).toMatchObject({
      views: 0,
    });
  });
  it("requires this page identity or a unique matching headline, never another article or a query identity", () => {
    expect(
      readArticleMetrics(
        documentFor(
          article(counter("LikeAction", 1), {
            url: "https://source.example/posts/article?post=other",
          }),
        ),
        url,
        title,
      ),
    ).toBeUndefined();
    expect(
      readArticleMetrics(
        documentFor(
          article(counter("LikeAction", 1), {
            mainEntityOfPage: "https://outside.example/post",
          }),
        ),
        url,
        title,
      ),
    ).toBeUndefined();
    expect(
      readArticleMetrics(
        documentFor(article(counter("LikeAction", 1), { url: undefined })),
        url,
        title,
      ),
    ).toMatchObject({ likes: 1 });
    expect(
      readArticleMetrics(
        documentFor(
          article(counter("LikeAction", 1), {
            url: undefined,
            headline: "另一个标题",
          }),
        ),
        url,
        title,
      ),
    ).toBeUndefined();
    const circular = documentFor(
      article(counter("LikeAction", 1), { url: undefined }),
    );
    circular.querySelector("h1")!.textContent = "真正的正文标题";
    expect(readArticleMetrics(circular, url, title)).toBeUndefined();
    expect(
      readArticleMetrics(
        documentFor([
          article(counter("LikeAction", 1), { url: undefined }),
          article(counter("LikeAction", 2), { url: undefined }),
        ]),
        url,
        title,
      ),
    ).toBeUndefined();
  });
  it("omits conflicting or malformed counts instead of summing, rounding or interpreting formatted text", () => {
    const invalid = [
      false,
      true,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      "1,000",
      "1.2万",
      "1e3",
      "",
      "-1",
    ];
    const data = article([
      counter("LikeAction", 0),
      counter("LikeAction", 1),
      counter("ViewAction", "00012"),
      ...invalid.map((value) => counter("CommentAction", value)),
    ]);
    expect(readArticleMetrics(documentFor(data), url, title)).toMatchObject({
      views: 12,
    });
    expect(
      readArticleMetrics(documentFor(data), url, title),
    ).not.toHaveProperty("likes");
    expect(
      readArticleMetrics(documentFor(data), url, title),
    ).not.toHaveProperty("comments");
    expect(
      readArticleMetrics(
        documentFor(
          article([counter("LikeAction", 0), counter("LikeAction", 0)]),
        ),
        url,
        title,
      ),
    ).toMatchObject({ likes: 0 });
  });
  it("does not accept a foreign context, ambiguous reference or a different interaction service", () => {
    expect(
      readArticleMetrics(
        documentFor(
          article(counter("LikeAction", 2), {
            "@context": "https://schema.org.evil.example",
          }),
        ),
        url,
        title,
      ),
    ).toBeUndefined();
    expect(
      readArticleMetrics(
        documentFor(
          article({
            ...counter("LikeAction", 2),
            interactionType: {
              "@type": "LikeAction",
              "@context": "https://outside.example/context",
            },
          }),
        ),
        url,
        title,
      ),
    ).toBeUndefined();
    expect(
      readArticleMetrics(
        documentFor(article(counter("constructor", 2))),
        url,
        title,
      ),
    ).toBeUndefined();
    expect(
      readArticleMetrics(
        documentFor(
          article({
            ...counter("LikeAction", 2),
            interactionService: {
              "@type": "WebSite",
              url: "https://outside.example",
            },
          }),
        ),
        url,
        title,
      ),
    ).toBeUndefined();
    const data = {
      "@context": "https://schema.org",
      "@graph": [
        { ...article({ "@id": "#same" }), "@context": undefined },
        { "@id": "#same", ...counter("LikeAction", 2) },
        { "@id": "#same", ...counter("LikeAction", 3) },
      ],
    };
    expect(readArticleMetrics(documentFor(data), url, title)).toBeUndefined();
  });
  it("keeps ordinary article extraction available when metadata is not JSON, unsupported or too large", () => {
    const document = documentFor(article(counter("LikeAction", 2)));
    for (const content of [
      "window.__metricScriptRan=true;",
      JSON.stringify(
        article(counter("LikeAction", 2), {
          "@context": "https://remote.example/context",
        }),
      ),
      " ".repeat(1024 * 1024 + 1),
    ]) {
      document.scripts[0].textContent = content;
      const extracted = extractWebPage(
        document.documentElement.outerHTML,
        url,
        { includeMetrics: true },
      );
      expect(extracted.markdown).toContain("作者提供的完整正文");
      expect(extracted.metrics).toBeUndefined();
    }
    expect((window as any).__metricScriptRan).toBeUndefined();
  });
  it("collects metrics only after a template opts in and never turns a login shell into article success", () => {
    const html = documentFor(article(counter("LikeAction", 0))).documentElement
      .outerHTML;
    expect(
      wantsArticleMetrics('---\ntitle: "{{note_title}}"\n---', "{{content}}"),
    ).toBe(false);
    expect(wantsArticleMetrics("likes: {{likes}}")).toBe(true);
    expect(wantsArticleMetrics("", "采集时间 {{metrics_captured_at}}")).toBe(
      true,
    );
    expect(extractWebPage(html, url).metrics).toBeUndefined();
    expect(
      extractWebPage(html, url, { includeMetrics: true }).metrics,
    ).toMatchObject({ likes: 0 });
    const shell = html.replace(
      /<article>[\s\S]*?<\/article>/,
      "<p>请登录后查看</p>",
    );
    expect(() =>
      extractWebPage(shell, url, { includeMetrics: true }),
    ).toThrow();
  });
});
