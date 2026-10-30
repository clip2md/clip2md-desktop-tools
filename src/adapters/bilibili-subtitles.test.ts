import { describe, expect, it, vi } from "vitest";
import { bilibiliSubtitleMarkdown } from "./bilibili-subtitles";
import { bilibiliLink, type SiteReaders } from "./site-link";

const cue = (from: number, to: number, content = "来源字幕") => ({
  from,
  to,
  content,
});
const url = "https://www.bilibili.com/video/BV17x411w7KC?p=2";
const signal = () => new AbortController().signal;
function readers(payloads: any[]): SiteReaders {
  return { page: vi.fn(), json: vi.fn(async () => payloads.shift()) };
}
const view = () => ({
  code: 0,
  data: {
    bvid: "BV17x411w7KC",
    cid: 1,
    title: "原视频",
    duration: 999,
    pages: [
      { page: 1, cid: 1, duration: 300 },
      { page: 2, cid: 2, duration: 10 },
    ],
  },
});
const player = (
  tracks: any[] = [
    { lan: "zh-CN", subtitle_url: "https://cdn.example/one.json" },
  ],
) => ({ code: 0, data: { cid: 2, subtitle: { subtitles: tracks } } });

describe("Bilibili source subtitle timeline", () => {
  it("keeps fractional cue starts, overlapping cues and a silent tail without inventing coverage", () => {
    expect(
      bilibiliSubtitleMarkdown({ body: [cue(1.9, 4), cue(3, 5)] }, 100),
    ).toBe("[00:00:01] 来源字幕\n\n[00:00:03] 来源字幕");
  });
  it("allows equal cue starts and a one-second source-duration rounding margin", () => {
    expect(
      bilibiliSubtitleMarkdown({ body: [cue(9, 10.8), cue(9, 11)] }, 10),
    ).toBeTruthy();
  });
  it("preserves escaping and multi-hour timestamps in existing subtitle notes", () => {
    expect(
      bilibiliSubtitleMarkdown({
        body: [cue(360001, 360002, "<原文> [引用] *字* `码`")],
      }),
    ).toBe("[100:00:01] \\<原文\\> \\[引用\\] \\*字\\* \\`码\\`");
  });
  it.each([undefined, NaN, Infinity, 0, -1])(
    "does not fabricate a duration bound when the selected duration is unknown: %s",
    (duration) => {
      expect(
        bilibiliSubtitleMarkdown({ body: [cue(100, 102)] }, duration),
      ).toBeTruthy();
    },
  );
  it.each([
    [cue(12, 13)],
    [cue(9, 11.01)],
    [cue(4, 5), cue(3, 4)],
    [cue(-1, 2)],
    [cue(1, 0)],
    [cue(NaN, 3)],
    [cue(1, Infinity)],
    [cue(1e100, 1e100)],
    [cue(1, 2, " ")],
    [null],
    [{ from: "1", to: 2, content: "来源字幕" }],
    [cue(0, 1), { to: 3, content: "缺时间" }],
  ])(
    "rejects an invalid track as a whole rather than silently dropping a bad cue: %#",
    (...rows) => {
      expect(bilibiliSubtitleMarkdown({ body: rows }, 10)).toBeUndefined();
    },
  );
  it.each([
    {},
    { body: [] },
    { body: "not an array" },
    { body: new Array(100001).fill(cue(0, 1)) },
  ])("does not accept an empty or over-budget transcript %#", (payload) => {
    expect(bilibiliSubtitleMarkdown(payload)).toBeUndefined();
  });
  it("tries the next advertised track after a timeline exceeds the selected part, skipping malformed descriptors", async () => {
    const io = readers([
      view(),
      player([
        null,
        { lan: "en", subtitle_url: "https://cdn.example/two.json" },
        { lan: "zh-CN", subtitle_url: "https://cdn.example/one.json" },
      ]),
      { body: [cue(15, 16, "其他分P字幕")] },
      { body: [cue(1, 3, "当前分P字幕")] },
    ]);
    const result = await bilibiliLink(url, signal(), io);
    expect(result.content.markdown).toContain("当前分P字幕");
    expect(result.content.markdown).not.toContain("其他分P");
    expect(result.content.duration_seconds).toBe(10);
    expect(result.content.transcription_source).toBe("bilibili_subtitles");
    expect(result.content.warnings).toHaveLength(1);
    expect(result.media).toBeUndefined();
    expect(
      vi
        .mocked(io.json)
        .mock.calls.map((call) => call[0])
        .slice(2),
    ).toEqual(["https://cdn.example/one.json", "https://cdn.example/two.json"]);
  });
  it("falls back to public media after a malformed timeline without retaining any partial subtitle body", async () => {
    const io = readers([
      view(),
      player(),
      { body: [cue(0, 1, "不应保留"), cue(30, 31)] },
      {
        code: 0,
        data: {
          cid: 2,
          dash: { audio: [{ baseUrl: "https://cdn.example/full.m4a" }] },
        },
      },
    ]);
    const result = await bilibiliLink(url, signal(), io);
    expect(result.content.markdown).toBe("");
    expect(result.content.transcription_source).toBeUndefined();
    expect(result.media?.url).toBe("https://cdn.example/full.m4a");
    expect(result.media?.expectedDurationSeconds).toBe(10);
    expect(result.content.warnings).toHaveLength(1);
  });
  it("does not use total collection duration when the selected part lacks duration", async () => {
    const data = view();
    delete (data.data.pages[1] as any).duration;
    const io = readers([data, player(), { body: [cue(1000, 1002)] }]);
    const result = await bilibiliLink(url, signal(), io);
    expect(result.content.duration_seconds).toBeUndefined();
    expect(result.content.transcription_source).toBe("bilibili_subtitles");
    expect(result.content.warnings).toBeUndefined();
  });
});
