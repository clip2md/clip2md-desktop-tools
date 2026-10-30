import { describe, expect, it } from "vitest";
import {
  assertFFmpegCapabilities,
  parseVideoPlan,
  netscapeCookies,
  executablePath,
  runTool,
} from "./tools";
import { parseCommentBatch, renderComments, signBilibili } from "./comments";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const source = "https://www.bilibili.com/video/BV1234567890";
const video = {
  url: "https://media.example.test/video.mp4",
  protocol: "https",
  ext: "mp4",
  vcodec: "avc1",
  acodec: "none",
  height: 1080,
};
const audio = {
  url: "https://media.example.test/audio.m4a",
  protocol: "https",
  ext: "m4a",
  vcodec: "none",
  acodec: "aac",
};
describe("complete video planning", () => {
  it("requires local muxing and progress protocols before downloading video", () => {
    expect(() =>
      assertFFmpegCapabilities(
        " E matroska Matroska\n E null Null",
        "Input:\nfile\nOutput:\nfile\npipe\n",
      ),
    ).not.toThrow();
    expect(() =>
      assertFFmpegCapabilities(" E matroska Matroska", "file\npipe"),
    ).toThrow("校验");
  });
  it("selects separate complete tracks and refuses audio-only, oversized resolution, DRM and foreign works", () => {
    expect(
      parseVideoPlan(
        JSON.stringify({
          id: "BV1234567890",
          requested_formats: [video, audio],
        }),
        source,
      ).audio?.url,
    ).toContain("audio");
    for (const info of [
      { id: "BV1234567890", ...audio },
      { id: "other", requested_formats: [video, audio] },
      { id: "BV1234567890", has_drm: true, requested_formats: [video, audio] },
      {
        id: "BV1234567890",
        requested_formats: [{ ...video, height: 2160 }, audio],
      },
      {
        id: "BV1234567890",
        requested_formats: [{ ...video, fragments: [{}] }, audio],
      },
    ])
      expect(() => parseVideoPlan(JSON.stringify(info), source)).toThrow();
  });
  it("writes only user-authorized cookie data and refuses shell command paths", async () => {
    expect(
      netscapeCookies([
        {
          name: "token",
          value: "x",
          domain: ".bilibili.com",
          path: "/",
          secure: true,
        },
      ]),
    ).toContain(".bilibili.com\tTRUE\t/\tTRUE");
    expect(
      netscapeCookies([
        { name: "token\nbad", value: "x", domain: ".bilibili.com", path: "/" },
      ]),
    ).not.toContain("token");
    await expect(executablePath("ffmpeg; injected")).rejects.toThrow();
    await expect(executablePath("/tmp/tool.cmd")).rejects.toThrow();
  });
  it("terminates a real child process when cancelled", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "clipmd-process-test-"),
    );
    const controller = new AbortController();
    const running = runTool(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      directory,
      controller.signal,
    );
    setTimeout(() => controller.abort(), 100);
    try {
      await expect(running).rejects.toThrow("取消");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
describe("source-bound first-level comments", () => {
  it("accepts verified empty replies and rejects blocked responses", () => {
    expect(
      parseCommentBatch({
        platform: "bilibili",
        workId: "42",
        url: source,
        payload: { code: 0, data: { replies: null } },
      }),
    ).toEqual([]);
    expect(() =>
      parseCommentBatch({
        platform: "douyin",
        workId: "42",
        url: "https://www.douyin.com/video/42",
        payload: { status_code: 8, comments: [] },
      }),
    ).toThrow();
  });
  it("filters other works and preserves real zero likes without pretending replies are complete", () => {
    const rows = parseCommentBatch({
      platform: "douyin",
      workId: "42",
      url: "https://www.douyin.com/video/42",
      payload: {
        status_code: 0,
        comments: [
          { cid: "1", aweme_id: "other", text: "wrong" },
          {
            cid: "2",
            aweme_id: "42",
            text: "<script>source</script>",
            user: { nickname: "人" },
            digg_count: 0,
          },
        ],
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].likes).toBe(0);
    expect(
      renderComments({
        comments: rows,
        capturedAt: "2026-10-21",
        coverage: "一级评论样本，不代表全量",
      }),
    ).toContain("&lt;script&gt;");
  });
  it("parses authenticated Zhihu answer comments from the v4 comments response", () => {
    const rows = parseCommentBatch({
      platform: "zhihu",
      workId: "1956385824699552759",
      url: "https://www.zhihu.com/question/1/answer/1956385824699552759",
      payload: {
        data: [{
          id: 11304012016,
          resource_type: "answer",
          content: "<p>评论内容</p>",
          created_time: 1759299203,
          vote_count: 2,
          author: { member: { name: "知乎用户" } },
        }],
      },
    });
    expect(rows).toEqual([expect.objectContaining({ id: "11304012016", author: "知乎用户", text: "评论内容", likes: 2 })]);
  });
  it("builds a stable WBI query and removes forbidden signing characters", () => {
    const signed = signBilibili({ oid: "42", note: "a!'()*" }, "key", 1);
    expect(signed).toMatch(/^note=a&oid=42&wts=1&w_rid=[a-f0-9]{32}$/);
  });
});
