// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { publicPageStates } from "./site-state";
import {
  extractSitePage,
  localSite,
  sourceMetrics,
  sourceMedia,
  douyinWorkId,
  SiteAccessDenied,
  SiteContentUnavailable,
  SiteStateUnavailable,
  SiteGalleryUnavailable,
} from "./sites";
import { htmlToMarkdown, extractWebPage } from "./extract";

const noteId = "0123456789abcdef01234567";
const state = (value: unknown) =>
  `<script>window.__INITIAL_STATE__=${JSON.stringify(value)};</script>`;
const extract = (html: string, url: string) =>
  extractSitePage(html, url, htmlToMarkdown)!;
describe("literal public site states", () => {
  it("accepts literal undefined without executing trailing page code or changing prototype state", () => {
    const document = new DOMParser().parseFromString(
      '<script>window.__INITIAL_STATE__={note:{desc:"undefined",missing:undefined},"__proto__":{polluted:true}}; throw new Error("never execute");</script>',
      "text/html",
    );
    const values = publicPageStates(document) as any[];
    expect(values[0].note).toEqual({ desc: "undefined", missing: null });
    expect(({} as any).polluted).toBeUndefined();
  });
  it.each([
    '(()=>({desc:"fake"}))()',
    '{get desc(){throw new Error("never")}}',
    "{...unknown}",
    '{desc:fetch("https://private.invalid")}',
    'JSON.parse(fetch("https://private.invalid"))',
  ])("never evaluates executable initial state %s", (expression) => {
    const document = new DOMParser().parseFromString(
      `<script>window.__INITIAL_STATE__=${expression};</script>`,
      "text/html",
    );
    expect(publicPageStates(document)).toEqual([]);
  });
  it("reads a literal serialized router state without invoking source-page JSON functions", () => {
    const document = new DOMParser().parseFromString(
      '<script>window._ROUTER_DATA=JSON.parse("{\\"work\\":123}");throw new Error("not executed")</script>',
      "text/html",
    );
    expect(publicPageStates(document)).toEqual([{ work: 123 }]);
  });
  it("decodes JSON state but ignores nested assignments, external and non-JavaScript sources", () => {
    const document = new DOMParser().parseFromString(
      `<script id="RENDER_DATA">${encodeURIComponent('{"primary":true}')}</script>
          <script>function example(){window.__INITIAL_STATE__={fake:true}}</script>
          <script src="https://example.invalid">window.__INITIAL_STATE__={fake:true}</script>
          <script type="text/plain">window.__INITIAL_STATE__={fake:true}</script>`,
      "text/html",
    );
    expect(publicPageStates(document)).toEqual([{ primary: true }]);
  });
});
describe("Douyin work identity", () => {
  it("extracts modal_id identities used by Jingxuan share cards", () => {
    expect(
      douyinWorkId("https://www.douyin.com/jingxuan?modal_id=7695240752057666854"),
    ).toBe("7695240752057666854");
  });
});
describe("Xiaohongshu exact-note adapter", () => {
  const url = `https://www.xiaohongshu.com/explore/${noteId}`;
  const note = () => ({
    noteId,
    type: "normal",
    title: "原站标题",
    desc: "第一段\n第二段",
    user: { nickname: "作者" },
    time: Date.parse("2026-10-17T00:00:00Z"),
    tagList: [{ name: "原站标签" }, { name: "原站标签" }],
    imageList: [
      { urlDefault: "https://images.example/1.jpg" },
      { urlDefault: "https://images.example/2.jpg" },
    ],
  });
  it("retains source page numbers and an in-place gap when the middle image has no public representation", () => {
    const result = extract(
      state({
        note: {
          ...note(),
          imageList: [
            { urlDefault: "https://images.example/1.jpg" },
            { urlDefault: "javascript:blocked" },
            { original: "https://images.example/3.jpg" },
          ],
        },
      }),
      url,
    ).content;
    expect(result.markdown).toContain("![原图 1]");
    expect(result.markdown).toContain("![原图 3]");
    expect(result.markdown).not.toContain("![原图 2]");
    expect(result.markdown.indexOf("1.jpg")).toBeLessThan(
      result.markdown.indexOf("第 2 张图片未取得"),
    );
    expect(result.markdown.indexOf("第 2 张图片未取得")).toBeLessThan(
      result.markdown.indexOf("3.jpg"),
    );
    expect(result.warnings).toHaveLength(1);
  });
  it("accepts the authenticated web-feed card shape used when the XHS shell has no SSR state", () => {
    const result = extract(
      state({
        noteId,
        note_id: noteId,
        type: "video",
        title: "API 标题",
        desc: "API 正文",
        user: { nickname: "API 作者" },
        interact_info: { liked_count: 12, collected_count: 3, comment_count: 4, share_count: 5 },
        video: { url_list: ["https://sns-video-bd.xhscdn.com/api-video.mp4"], duration: 123000 },
      }),
      url,
    );
    expect(result.content).toMatchObject({ title: "API 标题", author: "API 作者", source: "小红书" });
    expect(result.media?.url).toContain("api-video.mp4");
    expect(result.content.metrics).toBeUndefined();
  });
  it.each(
    [[], [{}], [{ urlDefault: "javascript:blocked" }]].map((imageList) => ({
      imageList,
    })),
  )(
    "does not count missing image placeholders or a title as useful content: %j",
    ({ imageList }) => {
      expect(() =>
        extract(state({ note: { ...note(), desc: "", imageList } }), url),
      ).toThrow(SiteGalleryUnavailable);
    },
  );
  it("preserves a valid description as partial content when every listed image is unavailable", () => {
    const result = extract(
      state({ note: { ...note(), imageList: [{}, {}] } }),
      url,
    ).content;
    expect(result.markdown).toContain("第一段");
    expect(result.markdown).toContain("第 1 张图片未取得");
    expect(result.markdown).toContain("第 2 张图片未取得");
    expect(result.warnings).toHaveLength(1);
  });
  it("deduplicates an exact repeated image URL while retaining the following original index", () => {
    const result = extract(
      state({
        note: {
          ...note(),
          imageList: [
            { urlDefault: "https://images.example/1.jpg" },
            { original: "https://images.example/1.jpg" },
            { urlDefault: "https://images.example/3.jpg" },
          ],
        },
      }),
      url,
    ).content;
    expect(result.markdown.match(/!\[/g)).toHaveLength(2);
    expect(result.markdown).toContain("![原图 3]");
  });
  it("preserves author, source tags and image order while excluding a related recommendation", () => {
    const target = note(),
      other = {
        ...note(),
        noteId: "ffffffffffffffffffffffff",
        title: "推荐作品",
      };
    const result = extract(
      state({
        note: {
          noteDetailMap: {
            [noteId]: { note: target },
            related: { note: other },
          },
        },
      }),
      url,
    ).content;
    expect(result).toMatchObject({
      title: "原站标题",
      source: "小红书",
      author: "作者",
      tags: ["原站标签"],
      source_date: "2026-10-17",
    });
    expect(result.markdown.indexOf("1.jpg")).toBeLessThan(
      result.markdown.indexOf("2.jpg"),
    );
    expect(result.markdown).not.toContain("推荐作品");
    expect(extractWebPage(state({ note: target }), url).markdown).toBe(
      result.markdown,
    );
  });
  it("reads source metrics only when enabled, preserving real zero and omitting approximate or invalid counts", () => {
    const html = state({
      note: {
        ...note(),
        interactInfo: {
          likedCount: "0",
          collectedCount: 12,
          commentCount: "1.2万",
          shareCount: true,
        },
      },
    });
    expect(extractWebPage(html, url).metrics).toBeUndefined();
    expect(
      extractWebPage(html, url, { includeMetrics: true }).metrics,
    ).toMatchObject({ likes: 0, collects: 12 });
    expect(
      extractWebPage(html, url, { includeMetrics: true }).metrics,
    ).not.toHaveProperty("comments");
    expect(
      sourceMetrics({ views: -1, likes: Infinity, coins: false }),
    ).toBeUndefined();
  });
  it("rejects wrong identities, empty shells and conflicting snapshots", () => {
    expect(() =>
      extract(state({ note: { ...note(), noteId: "wrong" } }), url),
    ).toThrow("当前作品");
    expect(() =>
      extract("<title>登录小红书</title><p>请打开App</p>", url),
    ).toThrow("当前作品");
    expect(() =>
      extract(state({ a: note(), b: { ...note(), desc: "冲突" } }), url),
    ).toThrow("当前作品");
  });
  it("prefers XHS muxed MP4 over silent fMP4 and exposes its cover to the images job", () => {
    const result = extract(state({ note: {
      ...note(), type: "video",
      imageList: [{ infoList: [{ imageScene: "WB_DFT", url: "http://sns-webpic-qc.xhscdn.com/cover.jpg" }] }],
      video: { media: { stream: {
        EF5: [{ masterUrl: "http://sns-video-qc.xhscdn.com/silent.m4s", duration: 1000 }],
        EF4: [{ masterUrl: "http://sns-video-qc.xhscdn.com/muxed.mp4", format: "mp4", audioDuration: 1000, duration: 1000 }],
      } }, capa: { duration: 1 } },
    } }), url);
    expect(result.media?.url).toContain("muxed.mp4");
    expect(result.content.image_urls).toEqual(["http://sns-webpic-qc.xhscdn.com/cover.jpg"]);
    expect(result.media?.expectedDurationSeconds).toBe(1);
  });
  it("routes videos to media extraction and never accepts the description as a transcript", () => {
    const html = state({
      note: {
        ...note(),
        type: "video",
        video: {
          media: {
            stream: { h264: [{ masterUrl: "https://media.example/v.mp4" }] },
          },
        },
      },
    });
    expect(extract(html, url).media?.url).toBe("https://media.example/v.mp4");
    expect(() => extractWebPage(html, url)).toThrow("站点执行器");
  });
  it("selects one best usable image representation in source order without duplicating previews", () => {
    const html = state({
      note: {
        ...note(),
        imageList: [
          {
            original: "https://images.example/original.jpg",
            urlDefault: "https://images.example/default.jpg",
            urlPre: "https://images.example/thumb.jpg",
          },
          {
            original: "javascript:blocked",
            urlSizeLarge: "https://images.example/large.jpg",
            urlDefault: "https://images.example/small.jpg",
          },
          { urlPre: "https://images.example/last.jpg" },
        ],
      },
    });
    const body = extract(html, url).content.markdown;
    expect(body.match(/!\[/g)).toHaveLength(3);
    for (const name of ["original.jpg", "large.jpg", "last.jpg"])
      expect(body).toContain(name);
    for (const name of ["default.jpg", "thumb.jpg", "small.jpg", "javascript:"])
      expect(body).not.toContain(name);
    expect(body.indexOf("original.jpg")).toBeLessThan(
      body.indexOf("large.jpg"),
    );
  });
  it("skips an unusable first h264 entry instead of losing the next publicly supplied media", () => {
    const html = state({
      note: {
        ...note(),
        type: "video",
        video: {
          media: {
            stream: {
              h264: [
                { masterUrl: "javascript:blocked" },
                { masterUrl: "https://media.example/usable.mp4" },
              ],
            },
          },
        },
      },
    });
    expect(extract(html, url).media?.url).toBe(
      "https://media.example/usable.mp4",
    );
  });
  it("preserves advertised h264 backup URLs and later streams for bounded download recovery", () => {
    const result = extract(
      state({
        note: {
          ...note(),
          type: "video",
          video: {
            media: {
              stream: {
                h264: [
                  {
                    masterUrl: "https://media.example/expired.mp4",
                    backupUrls: [
                      "https://media.example/backup.mp4?token=source",
                    ],
                  },
                  {
                    master_url: "https://media.example/other.mp4",
                    backup_urls: [
                      "https://media.example/backup.mp4?token=source",
                    ],
                  },
                ],
              },
            },
          },
        },
      }),
      url,
    );
    expect(result.media).toEqual({
      url: "https://media.example/expired.mp4",
      referer: url,
      alternatives: [
        "https://media.example/backup.mp4?token=source",
        "https://media.example/other.mp4",
      ],
    });
  });
  it.each(["h265", "av1", "h266", "future_codec"])(
    "uses a published %s representation when h264 is absent",
    (codec) => {
      const result = extract(
        state({
          note: {
            ...note(),
            type: "video",
            video: {
              media: {
                stream: {
                  [codec]: [
                    {
                      master_url:
                        "https://cdn.example/other-codec.mp4?signature=source",
                    },
                  ],
                },
              },
            },
          },
        }),
        url,
      );
      expect(result.media?.url).toBe(
        "https://cdn.example/other-codec.mp4?signature=source",
      );
      expect(result.content.markdown).toBe("");
      expect(result.content.source_title).toBe("原站标题");
    },
  );
  it("leaves a later codec within the bounded attempt budget after a normal primary and backup", () => {
    const result = extract(
      state({
        note: {
          ...note(),
          type: "video",
          video: {
            media: {
              stream: {
                h264: [
                  {
                    masterUrl: "https://cdn.example/old1.mp4",
                    backupUrls: [
                      "https://cdn.example/old2.mp4",
                      "https://cdn.example/old3.mp4",
                    ],
                  },
                ],
                h265: [{ masterUrl: "https://cdn.example/usable.mp4" }],
              },
            },
          },
        },
      }),
      url,
    );
    expect(
      [result.media?.url, ...result.media!.alternatives!].slice(0, 3),
    ).toEqual([
      "https://cdn.example/old1.mp4",
      "https://cdn.example/old2.mp4",
      "https://cdn.example/usable.mp4",
    ]);
  });
  it("uses explicit direct URLs and video-info aliases without recursively collecting related media", () => {
    const result = extract(
      state({
        note: {
          note_id: noteId,
          note_type: "video",
          display_title: "来源原题",
          video_info: {
            play_url: "https://cdn.example/direct.mp4",
            related: { url: "https://cdn.example/unrelated.mp4" },
          },
        },
      }),
      url,
    );
    expect(result.media?.url).toBe("https://cdn.example/direct.mp4");
    expect(result.media?.alternatives).toBeUndefined();
  });
  it("maps a published original-video path only to the fixed source CDN, retaining a full published URL unchanged", () => {
    const input = (key: string) =>
      state({
        note: {
          ...note(),
          type: "video",
          video: { consumer: { originVideoKey: key } },
        },
      });
    expect(extract(input("stream/owned-original.mp4"), url).media?.url).toBe(
      "https://sns-video-bd.xhscdn.com/stream/owned-original.mp4",
    );
    expect(
      extract(input("https://cdn.example/original.mp4?signature=source"), url)
        .media?.url,
    ).toBe("https://cdn.example/original.mp4?signature=source");
    for (const key of [
      "../private",
      "safe/../private",
      "safe//private",
      "/absolute",
      "evil.example:443/file",
      "safe/file?injected=1",
    ])
      expect(() => extract(input(key), url)).toThrow("公开可转写媒体");
  });
  it("keeps an explicit image-note type on its gallery path even if source metadata carries video fields", () => {
    const result = extract(
      state({
        note: { ...note(), videoUrl: "https://cdn.example/background.mp4" },
      }),
      url,
    );
    expect(result.media).toBeUndefined();
    expect(result.content.markdown).toContain("1.jpg");
  });
  it("stops on a visible source verification page even when a stale valid note state is present", () => {
    expect(() =>
      extract(
        '<p>请完成验证</p><input name="captcha">' + state({ note: note() }),
        url,
      ),
    ).toThrow("访问验证");
  });
  it.each(["请完成安全验证", "请进行安全验证"])(
    "rejects the visible verification heading %s before stale video state",
    (heading) => {
      expect(() =>
        extract(
          `<h1>${heading}</h1>` +
            state({
              note: {
                ...note(),
                type: "video",
                videoUrl: "https://cdn.example/stale.mp4",
              },
            }),
          url,
        ),
      ).toThrow("访问验证");
    },
  );
  it("does not treat an article discussing verification as a verification page", () => {
    expect(
      extract(
        "<p>教程介绍：请完成安全验证以后如何操作。</p>" +
          state({ note: note() }),
        url,
      ).content.markdown,
    ).toContain("第一段");
  });
  it.each([
    "https://xhslink.cn/a/owned",
    "https://xhslink.com/a/owned",
    "https://www.xhslink.cn/a/owned",
  ])(
    "recognizes a source short-link domain %s without matching lookalikes",
    (short) => {
      expect(localSite(short)).toBe("xiaohongshu");
      expect(localSite(short.replace("xhslink.", "xhslink-"))).toBeUndefined();
    },
  );
  it.each(["笔记不存在", "该笔记已被删除", "该内容暂时无法访问，请返回首页"])(
    "rejects a source unavailable page %s before stale note state",
    (message) => {
      expect(() =>
        extract(`<h1>${message}</h1>` + state({ note: note() }), url),
      ).toThrow(SiteContentUnavailable);
    },
  );
  it.each([
    "https://www.xiaohongshu.com/login?redirect=private",
    "https://www.xiaohongshu.com/signin",
    "https://www.xiaohongshu.com/auth/entry",
  ])(
    "classifies explicit login destination %s without exposing query data",
    (target) => {
      try {
        extract(state({ note: note() }), target);
        throw new Error("Expected rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(SiteAccessDenied);
        expect(String(error)).not.toContain("private");
        expect(String(error)).toContain("不需要重新绑定");
      }
    },
  );
  it("keeps an unknown landing page distinct from confirmed deletion or login and never returns its recommendations", () => {
    expect(() =>
      extract(
        "<h1>发现更多</h1>" + state({ note: note() }),
        "https://www.xiaohongshu.com/explore",
      ),
    ).toThrow(SiteStateUnavailable);
  });
  it("does not mistake article quotations or hidden unavailable text for a source restriction", () => {
    const html =
      "<div hidden>笔记不存在</div><p>教程记录了“该笔记已被删除”的提示及恢复步骤。</p>" +
      state({ note: note() });
    expect(extract(html, url).content.markdown).toContain("第一段");
  });
});
it("bounds and deduplicates source-advertised media without accepting local, relative or credential-bearing addresses", () => {
  const media = sourceMedia(
    [
      "file:///tmp/a",
      "/relative",
      "javascript:bad",
      "https://user:secret@cdn.example/a",
      "//cdn.example/a?signature=source",
      "https://cdn.example/a?signature=source",
      ...Array.from({ length: 20 }, (_, i) => `https://cdn.example/${i}`),
    ],
    "https://source.example/post",
  );
  expect(media?.url).toBe("https://cdn.example/a?signature=source");
  expect(media?.alternatives).toHaveLength(7);
  expect(media?.alternatives?.[0]).toBe("https://cdn.example/0");
});
describe("Douyin current-work adapter", () => {
  const url = "https://www.douyin.com/video/1234567890";
  const detail = () => ({
    aweme_id: "1234567890",
    desc: "原站说明",
    create_time: 1792195200,
    author: { nickname: "原作者" },
    video: { play_addr: { url_list: ["https://media.example/d.mp4"] } },
  });
  it("keeps camel-case web metadata and source metrics from the exact work without collecting a recommendation", () => {
    const html = state({
      videoDetail: {
        awemeId: "1234567890",
        title: "网页原题",
        desc: "原站说明",
        createTime: 1792195200,
        authorInfo: { nickname: "网页作者" },
        stats: {
          playCount: 0,
          diggCount: "0",
          collectCount: 5,
          commentCount: 8,
          shareCount: 9,
        },
        video: { playAddr: { url: "https://media.example/current.mp4" } },
      },
      recommendation: {
        ...detail(),
        aweme_id: "999",
        author: { nickname: "推荐作者" },
        statistics: { digg_count: 999 },
      },
    });
    const result = extractSitePage(html, url, htmlToMarkdown, true)!;
    expect(result.content).toMatchObject({
      source_title: "网页原题",
      author: "网页作者",
      source_date: "2026-10-17",
      metrics: { views: 0, likes: 0, collects: 5, comments: 8, shares: 9 },
    });
    expect(result.media?.url).toBe("https://media.example/current.mp4");
    expect(result.content.markdown).toBe("");
    expect(extract(html, url).content.metrics).toBeUndefined();
  });
  it("uses the source-provided Douyin cover before any local video-frame fallback", () => {
    const result = extract(
      state({
        detail: {
          ...detail(),
          video: {
            ...detail().video,
            cover: { url_list: ["https://p.douyinpic.com/cover.webp"] },
          },
        },
      }),
      url,
    );
    expect(result.content.markdown).toContain(
      "https://p.douyinpic.com/cover.webp",
    );
    expect(result.content.markdown).not.toContain("video-cover");
  });
  it("retains explicit zero in snake-case fields rather than replacing it with an alternate count", () => {
    const result = extractSitePage(
      state({
        detail: {
          ...detail(),
          statistics: { digg_count: 0, diggCount: 99 },
          stats: { diggCount: 100 },
        },
      }),
      url,
      htmlToMarkdown,
      true,
    )!;
    expect(result.content.metrics?.likes).toBe(0);
  });
  it.each([
    { aweme_id: "1234567890", awemeId: "999" },
    { aweme_id: "999", awemeId: "1234567890" },
  ])("rejects conflicting source identity aliases %j", (identity) => {
    expect(() =>
      extract(state({ detail: { ...detail(), ...identity } }), url),
    ).toThrow("身份字段冲突");
  });
  it.each([
    { chargeInfo: { isChargeContent: true } },
    { chargeInfo: { isChargeContent: 1 } },
    {
      charge_info: { is_charge_content: false },
      chargeInfo: { isChargeContent: true },
    },
  ])("keeps camel paid restrictions terminal %j", (restriction) => {
    expect(() =>
      extract(state({ detail: { ...detail(), ...restriction } }), url),
    ).toThrow("付费");
  });
  it.each([
    { statusCode: 8 },
    { verifyUrl: "https://example.com/private" },
    { status_code: 0, statusCode: 8 },
  ])(
    "keeps camel current-work access restriction terminal %j",
    (restriction) => {
      expect(() =>
        extract(state({ ...restriction, videoDetail: detail() }), url),
      ).toThrow("要求验证");
    },
  );
  it("preserves direct source-published image URL aliases in order without using background music", () => {
    const result = extract(
      state({
        detail: {
          ...detail(),
          images: [
            { url: "https://media.example/one.png" },
            { src: "https://media.example/two.png" },
          ],
        },
      }),
      url.replace("/video/", "/note/"),
    );
    expect(result.media).toBeUndefined();
    expect(result.content.markdown.indexOf("one.png")).toBeLessThan(
      result.content.markdown.indexOf("two.png"),
    );
  });
  it("accepts URL-encoded share data and binds media to the requested work", () => {
    const html = `<script id="RENDER_DATA">${encodeURIComponent(JSON.stringify({ detail: detail() }))}</script>`;
    const result = extract(html, url);
    expect(result.media?.url).toBe("https://media.example/d.mp4");
    expect(result.content).toMatchObject({
      source: "抖音",
      author: "原作者",
      markdown: "",
    });
  });
  it("saves image posts in source order without transcribing their background music", () => {
    const result = extract(
      state({
        aweme_detail: {
          ...detail(),
          images: [
            { url_list: ["https://images.example/a.jpg"] },
            { url_list: ["https://images.example/b.jpg"] },
          ],
        },
      }),
      url.replace("/video/", "/note/"),
    );
    expect(result.media).toBeUndefined();
    expect(result.content.markdown).toContain("原站说明");
    expect(result.content.markdown.indexOf("a.jpg")).toBeLessThan(
      result.content.markdown.indexOf("b.jpg"),
    );
  });
  it.each([
    {
      play_addr: {
        url_list: ["javascript:bad", "https://media.example/alternate.mp4"],
      },
    },
    { playAddr: { urlList: ["", "https://media.example/alternate.mp4"] } },
    {
      play_addr: { url_list: ["/page-not-media"] },
      bit_rate: [
        { play_addr: { url_list: ["data:bad"] } },
        { playAddr: { urlList: ["https://media.example/alternate.mp4"] } },
      ],
    },
    { download_addr: { url_list: ["https://media.example/alternate.mp4"] } },
    { downloadAddr: { urlList: ["https://media.example/alternate.mp4"] } },
  ])("uses an explicitly supplied public media representation %#", (video) => {
    const result = extract(state({ detail: { ...detail(), video } }), url);
    expect(result.media?.url).toBe("https://media.example/alternate.mp4");
    expect(result.content.markdown).toBe("");
  });
  it("prefers playback media without manufacturing watermark-free URLs", () => {
    const result = extract(
      state({
        detail: {
          ...detail(),
          video: {
            bitRate: [
              {
                playAddr: {
                  urlList: ["https://media.example/play.mp4?watermark=1"],
                },
              },
            ],
            download_addr: { url_list: ["https://media.example/download.mp4"] },
          },
        },
      }),
      url,
    );
    expect(result.media?.url).toBe(
      "https://media.example/play.mp4?watermark=1",
    );
  });
  it("selects one valid address per image and reports missing images separately from body", () => {
    const result = extract(
      state({
        detail: {
          ...detail(),
          images: [
            {
              url_list: [
                "javascript:bad",
                "https://images.example/a.jpg",
                "https://images.example/mirror.jpg",
              ],
            },
            { urlList: ["https://images.example/b.jpg"] },
            { url_list: [] },
          ],
        },
      }),
      url,
    );
    expect(result.media).toBeUndefined();
    expect(result.content.markdown.match(/!\[/g)).toHaveLength(2);
    expect(result.content.markdown).not.toContain("mirror.jpg");
    expect(result.content.warnings).toHaveLength(1);
    expect(result.content.markdown.indexOf("a.jpg")).toBeLessThan(
      result.content.markdown.indexOf("b.jpg"),
    );
  });
  it("does not accept a description or background music as an inaccessible gallery", () => {
    expect(() =>
      extract(
        state({
          detail: { ...detail(), images: [{ url_list: ["javascript:bad"] }] },
        }),
        url,
      ),
    ).toThrow("原图");
  });
  it("keeps missing Douyin gallery pages in source position without renumbering later originals", () => {
    const result = extract(
      state({
        detail: {
          ...detail(),
          images: [
            { url_list: ["https://images.example/first.png"] },
            { url_list: [] },
            {
              url_list: ["javascript:bad", "https://images.example/third.png"],
            },
          ],
          video: {
            play_addr: { url_list: ["https://media.example/background.mp4"] },
          },
        },
      }),
      url,
    );
    expect(result.media).toBeUndefined();
    expect(result.content.markdown).toContain("![原图 3]");
    expect(result.content.markdown).not.toContain("![原图 2]");
    expect(result.content.markdown.indexOf("first.png")).toBeLessThan(
      result.content.markdown.indexOf("第 2 张图片未取得"),
    );
    expect(result.content.markdown.indexOf("第 2 张图片未取得")).toBeLessThan(
      result.content.markdown.indexOf("third.png"),
    );
    expect(result.content.warnings).toHaveLength(1);
  });
  it("deduplicates a repeated exact Douyin image while retaining the next source index", () => {
    const result = extract(
      state({
        detail: {
          ...detail(),
          images: [
            { url_list: ["https://images.example/first.png"] },
            { url_list: ["https://images.example/first.png"] },
            { url_list: ["https://images.example/third.png"] },
          ],
        },
      }),
      url,
    );
    expect(result.content.markdown.match(/!\[/g)).toHaveLength(2);
    expect(result.content.markdown).toContain("![原图 3]");
  });
  it.each([undefined, []])(
    "does not transcribe background music of a note with a missing image list %j",
    (images) => {
      expect(() =>
        extract(
          state({ detail: { ...detail(), images } }),
          url.replace("/video/", "/note/"),
        ),
      ).toThrow("背景音乐");
    },
  );
  it("rejects stale valid media behind an explicit visible access challenge", () => {
    expect(() =>
      extract(
        '<p>请完成验证</p><input name="captcha">' + state({ detail: detail() }),
        url,
      ),
    ).toThrow("访问验证");
  });
  it("rejects paid works, unrelated media and a description without public video", () => {
    expect(() =>
      extract(
        state({
          aweme_detail: {
            ...detail(),
            charge_info: { is_charge_content: true },
          },
        }),
        url,
      ),
    ).toThrow("付费");
    expect(() =>
      extract(state({ aweme_detail: { ...detail(), aweme_id: "other" } }), url),
    ).toThrow("当前作品");
    expect(() =>
      extract(state({ aweme_detail: { ...detail(), video: {} } }), url),
    ).toThrow("简介");
  });
});
describe("Xiaoyuzhou and Feishu public sources", () => {
  const url = `https://www.xiaoyuzhoufm.com/episode/${noteId}`;
  const episode = () => ({
    eid: noteId,
    title: "单集标题",
    description: "单集简介不是转写",
    payType: "FREE",
    isPrivateMedia: false,
    pubDate: "2026-10-17T02:00:00Z",
    podcast: { author: "节目作者" },
    media: {
      size: 12345,
      source: { mode: "PUBLIC", url: "https://media.example/e.m4a" },
    },
  });
  const page = (value: unknown) =>
    `<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { episode: value } } })}</script>`;
  it("reads the public single-episode media and metadata without converting shownotes into a transcript", () => {
    const result = extract(page(episode()), url);
    expect(result.media).toMatchObject({
      url: "https://media.example/e.m4a",
      bytes: 12345,
    });
    expect(result.content).toMatchObject({
      source: "小宇宙",
      author: "节目作者",
      source_date: "2026-10-17",
      markdown: "",
    });
  });
  it("rejects private episodes and podcast listing pages", () => {
    expect(() =>
      extract(page({ ...episode(), isPrivateMedia: true }), url),
    ).toThrow("免费公开媒体");
    expect(() =>
      extract(page(episode()), url.replace("/episode/", "/podcast/")),
    ).toThrow("单集");
  });
  it.each([
    { payType: undefined },
    { payType: "PAID" },
    { payType: "TRIAL" },
    { isPrivateMedia: true },
    { media: { source: { url: "https://media.example/preview.mp3" } } },
    {
      media: {
        source: { mode: "PRIVATE", url: "https://media.example/preview.mp3" },
      },
    },
  ])("requires explicit free and public declarations %#", (patch) => {
    expect(() => extract(page({ ...episode(), ...patch }), url)).toThrow(
      "免费公开媒体",
    );
  });
  it("binds a positive source duration to the exact episode media and retains the raw title", () => {
    const result = extract(page({ ...episode(), duration: 123.4 }), url);
    expect(result.media?.expectedDurationSeconds).toBe(123.4);
    expect(result.content.source_title).toBe("单集标题");
    expect(result.content.markdown).toBe("");
  });
  it.each([
    "not a date",
    "tomorrow",
    "2999-01-01T00:00:00Z",
    "1999-01-01T00:00:00Z",
    "2026-10-17",
  ])("does not fabricate a publication day from %s", (pubDate) => {
    expect(
      extract(page({ ...episode(), pubDate }), url).content.source_date,
    ).toBeUndefined();
  });
  it("extracts only a public Feishu body and preserves headings, tables and image references", () => {
    const html =
      '<title>页面壳</title><div data-doc-title>文档原题</div><nav>登录与工具</nav><div class="docx-page-block-children"><h2>章节</h2><p>实际文档正文</p><table><tr><th>列</th></tr><tr><td>值</td></tr></table><img src="https://images.example/f.png"></div>';
    const result = extract(
      html,
      "https://team.feishu.cn/docx/DocToken",
    ).content;
    expect(result).toMatchObject({ title: "文档原题", source: "飞书" });
    expect(result.markdown).toContain("## 章节");
    expect(result.markdown).toContain("| 列 |");
    expect(result.markdown).toContain("f.png");
    expect(result.markdown).not.toContain("登录与工具");
  });
  it("rejects Feishu authorization and dynamic shells without inventing a document", () => {
    expect(() =>
      extract("<h1>登录飞书</h1>", "https://team.feishu.cn/wiki/Token"),
    ).toThrow("授权或动态渲染");
    expect(() =>
      extract(
        "<div data-doc-content>申请权限</div>",
        "https://team.feishu.cn/docx/Token",
      ),
    ).toThrow("正文");
    expect(
      localSite("https://feishu.cn.evil.example/docx/Token"),
    ).toBeUndefined();
    expect(() =>
      extract(
        "<div data-doc-title>只有标题</div><div data-doc-content><h1>只有标题</h1></div>",
        "https://team.feishu.cn/docx/Token",
      ),
    ).toThrow("标题");
    expect(() =>
      extract(
        "<div data-doc-content>加载中...</div>",
        "https://team.feishu.cn/docx/Token",
      ),
    ).toThrow("正文");
  });
});
