// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { htmlToMarkdown, extractWebPage } from "./extract";
const convert = (body: string) =>
  htmlToMarkdown(body, "https://example.com/source");

describe("source table columns and headers", () => {
  it("does not promote the first data row into a heading and retains the source caption", () => {
    expect(
      convert(
        "<table><caption>原始表题</caption><tr><td>甲</td><td>1</td></tr><tr><td>乙</td><td>2</td></tr></table>",
      ),
    ).toBe("原始表题\n\n|  |  |\n| --- | --- |\n| 甲 | 1 |\n| 乙 | 2 |");
  });
  it("preserves explicit column headings and row header emphasis", () => {
    expect(
      convert(
        '<table><tr><th>项目</th><th>值</th></tr><tr><th scope="row">本地</th><td>5</td></tr></table>',
      ),
    ).toBe("| 项目 | 值 |\n| --- | --- |\n| **本地** | 5 |");
  });
  it("does not mistake a first row-header cell for a column heading", () => {
    expect(
      convert('<table><tr><th scope="row">甲</th><td>1</td></tr></table>'),
    ).toBe("|  |  |\n| --- | --- |\n| **甲** | 1 |");
  });
  it("uses an explicit thead even when its source cells are td", () => {
    expect(
      convert(
        "<table><thead><tr><td>项目</td><td>值</td></tr></thead><tbody><tr><td>甲</td><td>1</td></tr></tbody></table>",
      ),
    ).toContain("| 项目 | 值 |\n| --- | --- |\n| 甲 | 1 |");
  });
  it("keeps data below and beside a rowspan in the correct column without duplicating merged text", () => {
    const result = convert(
      '<table><tr><th>项目</th><th>数值</th><th>备注</th></tr><tr><td rowspan="2">同组</td><td>10</td><td>甲</td></tr><tr><td>20</td><td>乙</td></tr></table>',
    );
    expect(result).toContain("| 同组 | 10 | 甲 |\n|  | 20 | 乙 |");
    expect(result.match(/同组/g)).toHaveLength(1);
    expect(result).toContain("覆盖位置留空");
  });
  it("keeps colspan and a later ordinary row aligned with all original columns", () => {
    const result = convert(
      '<table><tr><th colspan="2">合并标题</th><th>末列</th></tr><tr><td>A</td><td>B</td><td>C</td></tr></table>',
    );
    expect(result).toContain(
      "| 合并标题 |  | 末列 |\n| --- | --- | --- |\n| A | B | C |",
    );
  });
  it("supports a rectangular rowspan and colspan without shifting lower-row cells", () => {
    const result = convert(
      '<table><tr><td rowspan="2" colspan="2">区域</td><td>A</td></tr><tr><td>B</td></tr></table>',
    );
    expect(result).toContain("| 区域 |  | A |\n|  |  | B |");
  });
  it("limits rowspan zero to its own tbody and does not shift the next group", () => {
    const result = convert(
      '<table><tbody><tr><td rowspan="0">组一</td><td>A</td></tr><tr><td>B</td></tr></tbody><tbody><tr><td>组二</td><td>C</td></tr></tbody></table>',
    );
    expect(result).toContain("| 组一 | A |\n|  | B |\n| 组二 | C |");
  });
  it.each([
    '<tr><td rowspan="3">越界</td><td>A</td></tr><tr><td>B</td></tr>',
    '<tr><td>A</td><td rowspan="2">占用</td></tr><tr><td colspan="2">重叠</td></tr>',
    '<thead><tr><th rowspan="2">跨行组</th></tr></thead><tbody><tr><td>正文</td></tr></tbody>',
  ])(
    "refuses an ambiguous source grid instead of assigning values to incorrect columns %#",
    (body) => {
      expect(() => convert("<table>" + body + "</table>")).toThrow("错位表格");
    },
  );
  it.each([
    '<tr><td colspan="1000">超宽</td></tr>',
    '<tr><td colspan="256">超量</td></tr>'.repeat(40),
  ])("refuses over-budget span expansion %#", (body) => {
    expect(() => convert("<table>" + body + "</table>")).toThrow("大小限制");
  });
  it("retains relative images, links, literal pipe text, line breaks and cell formatting", () => {
    const result = convert(
      '<table><caption><strong>表题</strong></caption><tr><th>内容</th></tr><tr><td><a href="/a">原文</a><br>A | B<img src="/one.png"><strong>粗体</strong></td></tr></table>',
    );
    expect(result).toContain("**表题**");
    expect(result).toContain("[原文](https://example.com/a)");
    expect(result).toContain("A \\| B");
    expect(result).toContain("![](https://example.com/one.png)");
    expect(result).toContain("**粗体**");
    expect(result).toContain("<br>");
  });
  it("retains caller-provided Vault image references inside table cells", () => {
    expect(
      htmlToMarkdown(
        '<table><tr><th>原图</th></tr><tr><td><img src="/one.png"></td></tr></table>',
        "https://example.com/",
        new Map([["https://example.com/one.png", "附件/task-1/one.png"]]),
      ),
    ).toContain("![[附件/task-1/one.png]]");
  });
  it("keeps nested table rows inside their source cell rather than adding them as outer rows", () => {
    const result = convert(
      "<table><tr><th>外列</th></tr><tr><td>单元格<table><tr><th>内列</th></tr><tr><td>内值</td></tr></table></td></tr></table>",
    );
    expect(
      result.split("\n").filter((line) => line.startsWith("|")),
    ).toHaveLength(3);
    expect(result).toContain("内列");
    expect(result).toContain("内值");
  });
  it("applies source grid conversion to WeChat article bodies without changing body order", () => {
    const result = extractWebPage(
      '<h1 id="activity-name">来源原题</h1><div id="js_content"><p>来源正文足够完整，表格只是文章的一部分，不是标题或访问提示。</p><table><tr><td rowspan="2">组</td><td>甲</td></tr><tr><td>乙</td></tr></table><p>原文尾部</p></div>',
      "https://mp.weixin.qq.com/s/own-table",
    );
    expect(result.markdown).toContain("| 组 | 甲 |\n|  | 乙 |");
    expect(result.markdown.indexOf("来源正文")).toBeLessThan(
      result.markdown.indexOf("| 组"),
    );
    expect(result.markdown.indexOf("| 组")).toBeLessThan(
      result.markdown.indexOf("原文尾部"),
    );
  });
  it("does not double-wrap a source row heading that is already bold", () => {
    expect(
      convert(
        '<table><tr><th scope="row"><strong>原行标题</strong></th><td>原值</td></tr></table>',
      ),
    ).toContain("| **原行标题** | 原值 |");
  });
  it("retains source rowspan through generic Readability extraction", () => {
    const body =
      "<title>文章表格</title><article><h1>文章表格</h1><p>" +
      "这篇独立编写的文章包含实际段落，来源表格的合并范围应在通用正文提取后继续保持对应列。".repeat(
        10,
      ) +
      '</p><table><tr><th>组别</th><th>来源数值</th></tr><tr><td rowspan="2">同组</td><td>一</td></tr><tr><td>二</td></tr></table></article>';
    expect(
      extractWebPage(body, "https://example.com/source").markdown,
    ).toContain("| 同组 | 一 |\n|  | 二 |");
  });
  it("keeps a plain caption on a merged WeChat table after a code block", () => {
    const result = extractWebPage(
      '<h1 id="activity-name">公众号原始标题</h1><div id="js_content"><p>这是独立编写的完整公众号正文，保留来源字段、段落和原图。</p><pre class="code-snippet__js" data-lang="python"><code>read()</code></pre><table><caption>来源表题</caption><tr><th>组别</th><th>结果</th></tr><tr><td rowspan="2">本地</td><td>甲</td></tr><tr><td>乙</td></tr></table></div>',
      "https://mp.weixin.qq.com/s/owned-table",
    );
    expect(result.markdown).toContain("来源表题");
  });
});
