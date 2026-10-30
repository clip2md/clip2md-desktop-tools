// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { paceStatePayloads } from "./pace-state";
import { publicPageStates } from "./site-state";
import {
  extractSitePage,
  SiteAccessDenied,
  SiteStateConflict,
  SiteStateUnavailable,
} from "./sites";
import { htmlToMarkdown } from "./extract";
const id = "1234567890",
  url = `https://www.douyin.com/video/${id}`;
const detail = (extra = {}) => ({
  aweme_id: id,
  title: "流式原题",
  desc: "来源简介，不是转写",
  author: { nickname: "来源作者" },
  video: { play_addr: { url_list: ["https://cdn.example/owned.mp4"] } },
  ...extra,
});
const documentFor = (source: string) =>
  new DOMParser().parseFromString(`<script>${source}</script>`, "text/html");
const push = (value: unknown) =>
  `self.__pace_f.push(${JSON.stringify([1, JSON.stringify(value)])});`;
const extract = (source: string) =>
  extractSitePage(`<script>${source}</script>`, url, htmlToMarkdown)!;
describe("bounded literal Douyin pace stream", () => {
  it("reassembles split JSON without invoking source initialization or trailing statements", () => {
    const json = JSON.stringify({ videoDetail: detail() }),
      split = 37;
    const source =
      `(self.__pace_f=self.__pace_f||[]).push(${JSON.stringify([1, json.slice(0, split)])});` +
      `self.__pace_f.push(${JSON.stringify([1, json.slice(split)])});throw new Error('never execute');`;
    expect(extract(source)).toMatchObject({
      content: { source_title: "流式原题", author: "来源作者", markdown: "" },
      media: { url: "https://cdn.example/owned.mp4" },
    });
  });
  it("reads complete independent JSON entries and indexed newline records while selecting only the current work", () => {
    const other = { videoDetail: detail({ aweme_id: "9999999999" }) },
      current = { videoDetail: detail() };
    expect(
      paceStatePayloads([
        [1, JSON.stringify(other)],
        [1, JSON.stringify(current)],
      ]),
    ).toContainEqual(current);
    const chunks = `0:${JSON.stringify(other)}\na:${JSON.stringify(current)}\n`;
    expect(
      extract(`self.__pace_f.push(${JSON.stringify([1, chunks])});`).media?.url,
    ).toBe("https://cdn.example/owned.mp4");
  });
  it.each(["self", "window", "globalThis"])(
    "supports explicit literal assignments and pushes from %s",
    (name) => {
      const value = { aweme_detail: detail() };
      expect(
        extract(
          `${name}.__pace_f=${JSON.stringify([[1, JSON.stringify(value)]])};`,
        ).content.source_title,
      ).toBe("流式原题");
    },
  );
  it.each([
    encodeURIComponent(JSON.stringify({ videoDetail: detail() })),
    encodeURIComponent(
      encodeURIComponent(JSON.stringify({ videoDetail: detail() })),
    ),
    JSON.stringify(JSON.stringify({ videoDetail: detail() })),
  ])(
    "decodes bounded transport encodings without arbitrary text mining",
    (value) => {
      expect(paceStatePayloads([[1, value]])).toEqual([
        { videoDetail: detail() },
      ]);
    },
  );
  it.each([
    'self.__pace_f.push(fetch("https://private.invalid"));',
    'self.__pace_f.push((()=>[1,"{}"] )());',
    "function later(){" + push({ videoDetail: detail() }) + "}",
    "if(true){" + push({ videoDetail: detail() }) + "}",
    '(self.__pace_f=doWork()).push([1,"{}"]);',
    'other.__pace_f.push([1,"{}"]);',
  ])("never evaluates or traverses executable source %#", (source) => {
    expect(publicPageStates(documentFor(source))).toEqual([]);
  });
  it("does not treat comments, script strings, external or non-script text as stream pushes", () => {
    const code = push({ videoDetail: detail() });
    expect(
      publicPageStates(
        documentFor(`/*${code}*/;const example=${JSON.stringify(code)};`),
      ),
    ).toEqual([]);
    const page = new DOMParser().parseFromString(
      `<script src="https://cdn.example/external">${code}</script><script type="text/plain">${code}</script>`,
      "text/html",
    );
    expect(publicPageStates(page)).toEqual([]);
  });
  it("rejects an oversize or over-count stream as a whole rather than retaining a misleading prefix", () => {
    expect(
      paceStatePayloads([
        [1, JSON.stringify({ videoDetail: detail() })],
        [1, "x".repeat(2 * 1024 * 1024)],
      ]),
    ).toEqual([]);
    expect(
      paceStatePayloads(Array.from({ length: 161 }, () => [1, "{}"])),
    ).toEqual([]);
    expect(
      paceStatePayloads([
        [
          1,
          Array.from({ length: 321 }, () =>
            JSON.stringify({ videoDetail: detail() }),
          ).join("\n"),
        ],
      ]),
    ).toEqual([]);
    const source = Array.from({ length: 161 }, () =>
      push({ videoDetail: detail() }),
    ).join("");
    expect(publicPageStates(documentFor(source))).toEqual([]);
  });
  it("does not infer state from prose, malformed/truncated JSON, unsupported tuples or function source", () => {
    for (const value of [
      "text " + JSON.stringify({ videoDetail: detail() }),
      '{"videoDetail":',
      'fetch("private")',
      "%7Bbad",
    ])
      expect(paceStatePayloads([[1, value]])).toEqual([]);
    expect(
      paceStatePayloads([
        [2, JSON.stringify({ videoDetail: detail() })],
        [1, {}, "extra"],
      ]),
    ).toEqual([]);
  });
  it("retains conflict and paid-source refusals instead of selecting an arbitrary exact-ID entry", () => {
    expect(() =>
      extract(
        push({ videoDetail: detail() }) +
          push({ videoDetail: detail({ title: "另一份冲突原题" }) }),
      ),
    ).toThrow(SiteStateConflict);
    expect(() =>
      extract(
        push({
          videoDetail: detail({ charge_info: { is_charge_content: true } }),
        }),
      ),
    ).toThrow(SiteAccessDenied);
  });
  it("never substitutes a different work or plain description for current video media", () => {
    expect(() =>
      extract(push({ videoDetail: detail({ aweme_id: "9999999999" }) })),
    ).toThrow(SiteStateUnavailable);
    expect(() => extract(push({ videoDetail: detail({ video: {} }) }))).toThrow(
      "未提供公开媒体",
    );
  });
  it("preserves gallery ordering and source-provided zero metrics without using background audio", () => {
    const source = push({
      videoDetail: detail({
        images: [
          { url_list: ["https://cdn.example/one.png"] },
          { url_list: ["https://cdn.example/two.png"] },
        ],
        statistics: { digg_count: 0 },
      }),
    });
    const result = extractSitePage(
      `<script>${source}</script>`,
      url.replace("/video/", "/note/"),
      htmlToMarkdown,
      true,
    )!;
    expect(result.media).toBeUndefined();
    expect(result.content.metrics?.likes).toBe(0);
    expect(result.content.markdown.indexOf("one.png")).toBeLessThan(
      result.content.markdown.indexOf("two.png"),
    );
  });
  it.each([
    { status_code: 8 },
    { verify_url: "https://source.example/verify?private=source" },
  ])("honors current-work refusal %j before media", (restriction) => {
    expect(() =>
      extract(push({ ...restriction, videoDetail: detail() })),
    ).toThrow(SiteAccessDenied);
    expect(
      extract(
        push({
          ...restriction,
          videoDetail: detail({ aweme_id: "9999999999" }),
        }) + push({ videoDetail: detail() }),
      ).media?.url,
    ).toBe("https://cdn.example/owned.mp4");
  });
});
