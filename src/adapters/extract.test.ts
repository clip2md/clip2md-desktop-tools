// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { extractWebPage, extractPlainText, htmlToMarkdown } from "./extract";
import { isPublicAddress } from "./network";

describe("local extraction", () => {
  it("preserves highlighted preformatted code as literal fenced text with indentation and line breaks", () => {
    const result = htmlToMarkdown(
      "<p>计算示例</p><pre><span>&gt;&gt;&gt; 17 / 3</span>\n5.666666666666667\n  <span>&lt;script&gt;literal&lt;/script&gt;</span><br>next</pre><p><code>inline()</code></p>",
      "https://example.com",
    );
    expect(result).toContain(
      "```\n>>> 17 / 3\n5.666666666666667\n  <script>literal</script>\nnext\n```",
    );
    expect(result).toContain("`inline()`");
    expect(
      htmlToMarkdown(
        '<pre><code class="language-python"><span>print(1)</span>\n</code></pre>',
        "https://example.com",
      ),
    ).toBe("```python\nprint(1)\n```");
  });
  it("keeps extracted Vault images as stable embeds without promoting other source images", () => {
    const path = "剪藏/附件/task-101/image.png";
    const result = htmlToMarkdown(
      '<p>图片前</p><img src="known.png"><img src="other.png"><p>图片后</p>',
      "https://local.invalid/",
      new Map([["https://local.invalid/known.png", path]]),
    );
    expect(result).toContain(`![[${path}]]`);
    expect(result).toContain("![](https://local.invalid/other.png)");
    expect(result).not.toContain("https://local.invalid/known.png");
    expect(result.indexOf("图片前")).toBeLessThan(
      result.indexOf(`![[${path}]]`),
    );
    expect(result.indexOf(`![[${path}]]`)).toBeLessThan(
      result.indexOf("图片后"),
    );
  });
  it("keeps source metadata, image order and tables without inventing a publication date", () => {
    const article = `<html><head><title>阅读指南</title><meta name="author" content="原作者"></head><body><article><h1>阅读指南</h1>
        <p>${"这是一段完整、可阅读的原文，包含足够的信息。".repeat(20)}</p><img src="/one.png"><table><tr><th>列一</th><th>列二</th></tr><tr><td>A</td><td>B</td></tr></table><img src="/two.png"></article></body></html>`;
    const result = extractWebPage(article, "https://example.com/a");
    expect(result.author).toBe("原作者");
    expect(result.source_date).toBeUndefined();
    expect(result.markdown).toContain("| 列一 | 列二 |");
    expect(result.markdown.indexOf("one.png")).toBeLessThan(
      result.markdown.indexOf("two.png"),
    );
    expect(result.markdown).not.toMatch(/^# 阅读指南/);
  });
  it("rejects login shells and empty inputs; keeps plaintext literal", () => {
    expect(() =>
      extractWebPage(
        "<html><title>登录</title><p>请登录后查看</p></html>",
        "https://example.com",
      ),
    ).toThrow();
    expect(() => extractPlainText("", "a.txt")).toThrow();
    expect(extractPlainText("正文\n\n1. 第一条", "a.md")).toEqual({
      title: "a",
      markdown: "正文\n\n1. 第一条",
    });
    expect(
      htmlToMarkdown(
        '<script>alert(1)</script><a href="javascript:alert(1)">正文</a>',
        "https://example.com",
      ),
    ).not.toContain("javascript:");
  });
  it.each([
    "<h1>这是只有标题而没有文章正文的超长页面标题，不能仅靠字符数认定解析成功</h1>",
    "<p>https://example.com/articles/original-link-only-with-enough-characters</p>",
    '<p><a href="https://example.com/articles/original">https://example.com/articles/original-link-only-with-enough-characters</a></p>',
  ])(
    "rejects generic pages containing only a title or source link: %s",
    (content) => {
      const title =
        "这是只有标题而没有文章正文的超长页面标题，不能仅靠字符数认定解析成功";
      expect(() =>
        extractWebPage(
          `<html><title>${title}</title><article>${content}</article></html>`,
          "https://example.com/articles/original",
        ),
      ).toThrow("正文");
    },
  );
  it("keeps a real article containing a source link, repeated section heading and code", () => {
    const title = "文章标题";
    const result = extractWebPage(
      `<html><title>${title}</title><article><h1>${title}</h1><h2>${title}</h2><p>${"这里是来源实际提供的段落，标题和链接不能代替这些正文信息。".repeat(5)}</p><a href="https://example.com/original">原始链接</a><pre><code>https://example.com/code-example</code></pre></article></html>`,
      "https://example.com/article",
    );
    expect(result.markdown).toContain("来源实际提供的段落");
    expect(result.markdown).toContain(
      "[原始链接](https://example.com/original)",
    );
    expect(result.markdown).toContain("https://example.com/code-example");
  });
});

// Authored DOM contracts, not downloaded articles or live-site acceptance.
describe("public WeChat article extraction", () => {
  const url = "https://mp.weixin.qq.com/s/example";
  const text =
    "原文中的完整段落保留实际信息和顺序，不调用远程模型，不生成摘要或标签。";
  const page = (
    content: string,
    head = "",
    extra = "",
  ) => `<html><head><title>页面标题</title>${head}</head><body>
        <h1 id="activity-name">图文原始标题</h1><a id="js_name">发布账号</a>
        <div id="js_content" style="visibility:hidden">${content}</div>${extra}</body></html>`;
  it("takes only the article body and explicit author; restores lazy images, links and tables", () => {
    const result = extractWebPage(
      page(
        `<h1>图文原始标题</h1><p>${text}</p><img data-src="//mmbiz.qpic.cn/one.png" src="data:image/gif;base64,R0lGODlh">
            <table><tr><th>项目</th><th>状态</th></tr><tr><td>本地</td><td>完成</td></tr></table>
            <img data-original="https://mmbiz.qpic.cn/two.png"><a href="/s/another">相关阅读</a>`,
        '<meta name="author" content="原作者"><meta property="article:published_time" content="2026-10-17T08:00:00+08:00"><meta property="article:tag" content="阅读"><meta property="article:tag" content="写作">',
        "<aside>评论和推荐不进入正文</aside>",
      ),
      url,
    );
    expect(result).toMatchObject({
      title: "图文原始标题",
      author: "原作者",
      source: "微信公众号",
      source_date: "2026-10-17",
      tags: ["阅读", "写作"],
    });
    expect(result.markdown).toContain(text);
    expect(result.markdown).toContain("| 项目 | 状态 |");
    expect(result.markdown).toContain("https://mp.weixin.qq.com/s/another");
    expect(result.markdown.indexOf("one.png")).toBeLessThan(
      result.markdown.indexOf("two.png"),
    );
    expect(result.markdown).not.toMatch(/^# /);
    expect(result.markdown).not.toMatch(/发布账号|评论和推荐|R0lGODlh/);
  });
  it.each([
    "<h1>图文原始标题</h1>".repeat(8),
    "<p>https://mp.weixin.qq.com/s/this-is-only-an-original-link-not-extracted-body</p>",
    '<p><a href="https://mp.weixin.qq.com/s/original">https://mp.weixin.qq.com/s/this-is-only-an-original-link-not-extracted-body</a></p>',
  ])(
    "rejects title/link-only WeChat shells without saving them as article bodies: %s",
    (content) => {
      expect(() => extractWebPage(page(content), url)).toThrow("正文");
    },
  );
  it("keeps missing author and date unknown instead of using the publishing account or today", () => {
    const result = extractWebPage(page(`<p>${text}</p>`), url);
    expect(result.author).toBeUndefined();
    expect(result.source_date).toBeUndefined();
    expect(result.tags).toEqual([]);
  });
  it("reads a literal source timestamp with the publication timezone and never executes scripts", () => {
    const ct = Date.parse("2026-10-17T23:30:00Z") / 1000;
    const result = extractWebPage(
      page(
        `<p>${text}</p>`,
        "",
        `<script>var ct = "${ct}"; throw new Error('must not execute');</script>`,
      ),
      url,
    );
    expect(result.source_date).toBe("2026-10-18");
    expect(
      extractWebPage(
        page(
          `<p>${text}</p>`,
          "",
          "<script>var ct = calculateDate();</script>",
        ),
        url,
      ).source_date,
    ).toBeUndefined();
  });
  it.each([
    "// var ct = 1792279800;",
    "/* var ct = 1792279800; */",
    "const example = 'var ct = 1792279800;';",
    "const example = `var ct = 1792279800;`; ",
    "const pattern = /var ct = 1792279800;/;",
    "function relatedArticle() { var ct = 1792279800; }",
    "var ct = 1792279800; const broken = ;",
  ])(
    "does not treat script examples or nested/invalid declarations as publication data: %s",
    (script) => {
      expect(
        extractWebPage(
          page(`<p>${text}</p>`, "", `<script>${script}</script>`),
          url,
        ).source_date,
      ).toBeUndefined();
    },
  );
  it("does not pick an arbitrary publication timestamp from conflicting scripts or non-JavaScript data", () => {
    const conflict =
      "<script>var ct = 1792279800;</script><script>var ct = 1792366200;</script>";
    expect(
      extractWebPage(page(`<p>${text}</p>`, "", conflict), url).source_date,
    ).toBeUndefined();
    expect(
      extractWebPage(
        page(
          `<p>${text}</p>`,
          "",
          '<script type="text/plain">var ct = 1792279800;</script>',
        ),
        url,
      ).source_date,
    ).toBeUndefined();
  });
  it("accepts matching top-level literal declarations without executing source code", () => {
    const result = extractWebPage(
      page(
        `<p>${text}</p>`,
        "",
        '<script>var unrelated = 1, ct = 1792279800; throw new Error("never execute");</script><script type="module">const ct = "1792279800";</script>',
      ),
      url,
    );
    expect(result.source_date).toBe("2026-10-18");
  });
  it.each([
    "var ct = computeDate();",
    'var ct = "0000000000";',
    "var ct = 1792279800; ct = 1792366200;",
    "var ct = 1792279800; ct++;",
  ])(
    "leaves ambiguous, computed or placeholder publication data unknown: %s",
    (script) => {
      expect(
        extractWebPage(
          page(`<p>${text}</p>`, "", `<script>${script}</script>`),
          url,
        ).source_date,
      ).toBeUndefined();
    },
  );
  it("keeps explicit publication metadata ahead of conflicting script candidates", () => {
    const result = extractWebPage(
      page(
        `<p>${text}</p>`,
        '<meta property="article:published_time" content="2026-10-17">',
        "<script>var ct = 1792279800;</script><script>var ct = 1792366200;</script>",
      ),
      url,
    );
    expect(result.source_date).toBe("2026-10-17");
  });
  it("does not read inline text attached to an external script reference", () => {
    expect(
      extractWebPage(
        page(
          `<p>${text}</p>`,
          "",
          '<script src="https://example.com/related.js">var ct = 1792279800;</script>',
        ),
        url,
      ).source_date,
    ).toBeUndefined();
  });
  it("validates calendar dates and accepts an explicitly displayed Chinese publication date", () => {
    expect(
      extractWebPage(
        page(
          `<p>${text}</p>`,
          "",
          '<em id="publish_time">2026年10月17日 09:30</em>',
        ),
        url,
      ).source_date,
    ).toBe("2026-10-17");
    expect(
      extractWebPage(
        page(
          `<p>${text}</p>`,
          '<meta property="article:published_time" content="2026-02-31">',
        ),
        url,
      ).source_date,
    ).toBeUndefined();
    const generic = `<html><head><title>测试</title><meta name="datePublished" content="2026-02-31"></head><body><article><p>${text.repeat(8)}</p></article></body></html>`;
    expect(
      extractWebPage(generic, "https://example.com/article").source_date,
    ).toBeUndefined();
  });
  it("rejects account pages, removed articles, challenge shells and empty/video-only articles", () => {
    for (const content of [
      "",
      "<p>访问环境异常，请验证后继续</p>",
      '<video src="https://example.com/a.mp4"></video>',
    ]) {
      expect(() => extractWebPage(page(content), url)).toThrow("正文");
    }
    expect(() =>
      extractWebPage("<h1>环境异常</h1><p>请进行验证</p>", url),
    ).toThrow("正文");
    expect(() => extractWebPage("<p>该内容已被发布者删除</p>", url)).toThrow(
      "正文",
    );
    expect(() =>
      extractWebPage(
        page(`<p>${text}</p>`),
        "https://mp.weixin.qq.com/mp/profile_ext",
      ),
    ).toThrow("图文文章链接");
  });
  it("preserves image-only articles and explicitly discloses unextracted embedded media", () => {
    expect(
      extractWebPage(
        page('<img data-src="https://mmbiz.qpic.cn/poster.jpg">'),
        url,
      ).markdown,
    ).toContain("poster.jpg");
    const partial = extractWebPage(
      page(
        `<p>${text}</p><mpvoice>播放原音频</mpvoice><iframe src="https://example.com/player"></iframe>`,
      ),
      url,
    );
    expect(partial.markdown).toContain(text);
    expect(partial.markdown).not.toContain("本次仅提取图文内容");
    expect(partial.warnings?.[0]).toContain("本次仅提取图文内容");
    expect(partial.markdown).not.toContain("https://example.com/player");
    expect(partial.warnings).toHaveLength(1);
  });
  it("ignores long player fallback text when deciding whether an article has a body", () => {
    for (const tag of ["video", "iframe", "mpvoice", "mp-common-videosnap"]) {
      expect(() =>
        extractWebPage(page(`<${tag}>${text.repeat(5)}</${tag}>`), url),
      ).toThrow("正文");
    }
    const result = extractWebPage(
      page(`<p>${text}</p><video>${"播放器提示".repeat(30)}</video>`),
      url,
    );
    expect(result.markdown).toContain(text);
    expect(result.markdown).not.toContain("播放器提示");
    expect(result.warnings).toHaveLength(1);
  });
  it("prefers a real lazy image to an inline placeholder and keeps its query parameters", () => {
    const result = extractWebPage(
      page(
        '<img data-src="data:image/gif;base64,R0lGODlh" data-original="https://mmbiz.qpic.cn/a?wx_fmt=png&amp;token=original" src="/placeholder.gif">',
      ),
      url,
    );
    expect(result.markdown).toContain(
      "https://mmbiz.qpic.cn/a?wx_fmt=png&token=original",
    );
    expect(result.markdown).not.toMatch(/R0lGODlh|placeholder/);
    expect(
      htmlToMarkdown('<img src="data:image/png;base64,aGVsbG8=">', url),
    ).toContain("data:image/png;base64,aGVsbG8=");
  });
  it("falls through invalid date metadata and deduplicates only source-provided tags", () => {
    const result = extractWebPage(
      page(
        `<p>${text}</p>`,
        '<meta property="article:published_time" content="invalid"><meta name="datePublished" content="2026-10-17"><meta property="article:tag" content="阅读,写作"><meta name="article:tag" content="阅读">',
      ),
      url,
    );
    expect(result.source_date).toBe("2026-10-17");
    expect(result.tags).toEqual(["阅读", "写作"]);
    expect(result.author).toBeUndefined();
  });
  it("requires an exact host match and never promotes dangerous lazy sources", () => {
    const html = `<html><title>普通文章</title><article><p>${text.repeat(8)}</p></article></html>`;
    expect(
      extractWebPage(html, "https://mp.weixin.qq.com.evil.example/s/article")
        .source,
    ).not.toBe("微信公众号");
    const result = htmlToMarkdown(
      '<img data-src="javascript:alert(1)" data-original="//example.com/safe.png"><img data-src="file:///etc/passwd"><a href="javascript:alert(1)">链接</a>',
      url,
    );
    expect(result).toContain("https://example.com/safe.png");
    expect(result).not.toMatch(/javascript:|file:/);
  });
});

// Authored layout contract; the live HTTP scenario separately verifies the public page.
describe("Python Insider article metadata", () => {
  const url = "https://blog.python.org/2025/10/sample-post/";
  const page = (header: string) =>
    `<html><title>文章原题 | Python Insider</title><article><header>${header}</header><p>${"文章正文保留原始内容与顺序。".repeat(20)}</p><img src="/image.webp"></article></html>`;
  it("uses the explicit original title, author, publication date and source tags", () => {
    const result = extractWebPage(
      page(
        '<h1>文章原题</h1><a href="/authors/original">原作者</a><time datetime="2025-10-07T00:00:00Z">发布日期</time><span>Updated <time datetime="2026-10-18T00:00:00Z">更新日</time></span><a href="/tags/releases">releases</a><a href="/tags/releases">releases</a>',
      ),
      url,
    );
    expect(result).toMatchObject({
      title: "文章原题",
      author: "原作者",
      source: "Python Insider",
      source_date: "2025-10-07",
      tags: ["releases"],
    });
    expect(result.markdown).toContain("https://blog.python.org/image.webp");
  });
  it("does not replace unknown source fields with the publisher, updated date or outside links", () => {
    const result = extractWebPage(
      page(
        '<h1>文章原题</h1><a href="https://other.example/authors/not-original">外部分享者</a><time datetime="2025-02-31">无效发布日期</time><span>Updated <time datetime="2026-10-18">更新日</time></span>',
      ),
      url,
    );
    expect(result.author).toBeUndefined();
    expect(result.source_date).toBeUndefined();
    expect(result.tags).toEqual([]);
    expect(
      extractWebPage(
        page(
          '<h1>文章原题</h1><span>Updated <time datetime="2026-10-18">仅更新日</time></span>',
        ),
        url,
      ).source_date,
    ).toBeUndefined();
  });
  it("rejects index/profile pages and changed article shells without treating another host as the site", () => {
    expect(() =>
      extractWebPage(
        page("<h1>文章列表</h1>"),
        "https://blog.python.org/tags/releases/",
      ),
    ).toThrow("具体文章");
    expect(() => extractWebPage(page(""), url)).toThrow("文章标题");
    expect(
      extractWebPage(
        page("<h1>文章原题</h1>"),
        "https://blog.python.org.evil.example/2025/10/sample/",
      ).source,
    ).not.toBe("Python Insider");
  });
});

it("keeps a source-backed original title for generic page metadata supplements", () => {
  const page =
    "<html><head><title>Original source title</title></head><body><article><h1>Original source title</h1><p>" +
    "This is a source paragraph with enough readable text. ".repeat(30) +
    "</p></article></body></html>";
  const content = extractWebPage(page, "https://example.test/article");
  expect(content.source_title).toBe("Original source title");
});
