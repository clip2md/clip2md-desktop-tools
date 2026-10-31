// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { bilibiliOpusLink, type SiteReaders } from "./site-link";

describe("Bilibili Opus article source", () => {
  it("extracts article text and gallery images without requiring a BV video id", async () => {
    const url = "https://www.bilibili.com/opus/1261621092485693461/";
    const io: SiteReaders = {
      page: vi.fn(async () => ({
        url,
        html: `<title>Opus 标题 - 哔哩哔哩</title>
          <div class="opus-module-title__text">Opus 标题</div>
          <div class="opus-module-author__name">作者</div>
          <div class="opus-module-author__pub__text">编辑于 2026年10月24日 21:14</div>
          <div class="opus-module-content"><p>正文内容</p><img src="//i0.hdslb.com/bfs/new_dyn/example.png"></div>`,
      })),
      json: vi.fn(),
    };
    const result = await bilibiliOpusLink(url, new AbortController().signal, io);
    expect(result.content).toMatchObject({
      title: "Opus 标题",
      author: "作者",
      source_date: "2026-10-24",
      source: "B站",
    });
    expect(result.content.markdown).toContain("正文内容");
    expect(result.content.markdown).toContain("https://i0.hdslb.com/bfs/new_dyn/example.png");
    expect(result.content.image_urls).toEqual(["https://i0.hdslb.com/bfs/new_dyn/example.png"]);
  });
});
