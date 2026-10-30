// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { extractWebPage, htmlToMarkdown } from "./extract";

const url = "https://mp.weixin.qq.com/s/owned-code";
const article = (body: string) =>
  `<h1 id="activity-name">代码示例</h1><div id="js_content"><p>这是独立编写的公众号正文，代码来自显式的编辑器行节点，不执行页面脚本，也不猜测语言。</p>${body}</div>`;
const snippet = (lines: string[], language = "python", separator = "") =>
  `<section class="code-snippet__fix code-snippet__js"><ul class="code-snippet__line-index"><li>1</li><li>2</li></ul><pre class="code-snippet__js" data-lang="${language}">${lines.map((line) => `<code>${line}</code>`).join(separator)}</pre></section>`;

describe("WeChat source code lines", () => {
  it.each(["", "\n  "])(
    "preserves source line boundaries, indentation, blank lines and literal HTML with separator %j",
    (separator) => {
      const result = extractWebPage(
        article(
          snippet(
            [
              "<span>def read():</span>",
              "  return &quot;&lt;原文&gt;&amp;&quot;",
              "",
              "read()",
            ],
            "python",
            separator,
          ),
        ),
        url,
      );
      expect(result.markdown).toContain(
        '```python\ndef read():\n  return "<原文>&"\n\nread()\n```',
      );
      expect(result.markdown).not.toMatch(/^- +[12]$/m);
    },
  );
  it("uses a longer fence for source code containing triple backticks and keeps images in source order", () => {
    const result = extractWebPage(
      article(
        '<img data-src="https://mmbiz.qpic.cn/before.png">' +
          snippet(
            ["const text = &quot;literal&quot;;", "```", "  next();"],
            "javascript",
          ) +
          '<img data-src="https://mmbiz.qpic.cn/after.png">',
      ),
      url,
    );
    expect(result.markdown).toContain(
      '````javascript\nconst text = "literal";\n```\n  next();\n````',
    );
    expect(result.markdown.indexOf("before.png")).toBeLessThan(
      result.markdown.indexOf("const text"),
    );
    expect(result.markdown.indexOf("const text")).toBeLessThan(
      result.markdown.indexOf("after.png"),
    );
  });
  it.each(["", "unknown_source", "shell", "cpp", "CSharp"])(
    "keeps a valid declared language %j without inferring JavaScript from the layout class",
    (language) => {
      const result = extractWebPage(
        article(snippet(["first()", "second()"], language)),
        url,
      );
      expect(result.markdown).toContain(
        "```" + language + "\nfirst()\nsecond()\n```",
      );
    },
  );
  it.each([
    "python onclick=bad",
    "python&#10;bad",
    "x".repeat(65),
    "&quot; onmouseover=&quot;bad",
  ])("omits invalid language metadata %j", (language) => {
    const result = extractWebPage(
      article(snippet(["first()", "second()"], language)),
      url,
    );
    expect(result.markdown).toContain("```\nfirst()\nsecond()\n```");
    expect(result.markdown).not.toContain("onclick");
  });
  it("preserves explicit breaks inside source lines and does not execute or retain source scripts", () => {
    const result = extractWebPage(
      article(
        snippet([
          "first()<br>  second()",
          '<span>&lt;script&gt;literal&lt;/script&gt;</span><script>throw new Error("never-run")</script>',
        ]),
      ),
      url,
    );
    expect(result.markdown).toContain(
      "first()\n  second()\n<script>literal</script>",
    );
    expect(result.markdown).not.toContain("never-run");
  });
  it("does not turn ordinary adjacent inline code into line-per-code snippets", () => {
    const result = extractWebPage(
      article(
        '<pre><code>first()</code><code>second()</code></pre><ul class="code-snippet__line-index"><li>正文列表</li></ul>',
      ),
      url,
    );
    expect(result.markdown).toContain("```\nfirst()second()\n```");
    expect(result.markdown).toContain("正文列表");
  });
  it("leaves an unrecognized mixed snippet layout on the generic path without dropping text", () => {
    const result = extractWebPage(
      article(
        '<pre class="code-snippet__js">prefix<code>first()</code><span>suffix</span></pre>',
      ),
      url,
    );
    expect(result.markdown).toContain("```\nprefixfirst()suffix\n```");
  });
  it("does not enable site-specific line normalization on generic pages with the same class", () => {
    expect(
      htmlToMarkdown(snippet(["first()", "second()"]), "https://example.com/"),
    ).toContain("first()second()");
  });
  it("preserves an existing explicit code language and multiline single-code content when data-lang is absent", () => {
    const result = extractWebPage(
      article(
        '<pre class="code-snippet__js"><code class="language-rust">fn main() {\n  work();\n}</code></pre>',
      ),
      url,
    );
    expect(result.markdown).toContain(
      "```rust\nfn main() {\n  work();\n}\n```",
    );
  });
  it("retains consecutive empty source lines instead of collapsing them with layout whitespace", () => {
    const result = extractWebPage(
      article(snippet(["first()", "", "", "second()"], "python", "\n  ")),
      url,
    );
    expect(result.markdown).toContain("```python\nfirst()\n\n\nsecond()\n```");
  });
});
