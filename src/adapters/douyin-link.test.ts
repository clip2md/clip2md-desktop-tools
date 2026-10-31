// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { readDouyinPage } from "./douyin-link";
import { resolveSiteLink } from "./site-link";
import {
  SiteAccessDenied,
  SiteGalleryUnavailable,
  SiteMediaUnavailable,
  SiteStateConflict,
} from "./sites";
const url = "https://www.douyin.com/video/1234567890";
const detail = () => ({
  aweme_id: "1234567890",
  title: "来源标题",
  desc: "来源简介",
  author: { nickname: "来源作者" },
  video: { play_addr: { url_list: ["https://media.example/clip.mp4"] } },
});
const html = (value: unknown) =>
  `<script type="application/json">${JSON.stringify({ aweme_detail: value })}</script>`;
function setup(first = { url, html: "<p>打开App</p>" }) {
  const controller = new AbortController(),
    io = {
      page: vi.fn(async () => ({
        url: "https://www.iesdouyin.com/share/video/1234567890/",
        html: "<p>打开App</p>",
      })),
      json: vi.fn(
        async (_url: string, _signal: AbortSignal, _referer?: string) => ({
          status_code: 0,
          aweme_detail: detail(),
        }),
      ),
    };
  return {
    controller,
    io,
    run: (metrics = false) =>
      readDouyinPage(first, controller.signal, io, metrics),
  };
}
it("keeps a successful static work at one page without optional mobile or API requests", async () => {
  const { io, run } = setup({ url, html: html(detail()) });
  expect((await run()).media?.url).toContain("clip.mp4");
  expect(io.page).not.toHaveBeenCalled();
  expect(io.json).not.toHaveBeenCalled();
});
it("uses a single fixed public detail request after two shells and reuses exact-work metadata extraction", async () => {
  const { io, run } = setup();
  const result = await run();
  expect(result.content).toMatchObject({
    source: "抖音",
    source_title: "来源标题",
    author: "来源作者",
    markdown: "",
  });
  expect(io.page).toHaveBeenCalledTimes(1);
  expect(io.json).toHaveBeenCalledTimes(1);
  expect(io.json).toHaveBeenCalledWith(
    "https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=1234567890",
    expect.any(AbortSignal),
    "https://www.douyin.com/",
  );
});
it("tries the webapp detail variants when the first endpoint has no current-work payload", async () => {
  const { io, run } = setup();
  io.json
    .mockResolvedValueOnce({ status_code: 0 })
    .mockResolvedValueOnce({ status_code: 0, aweme_detail: detail() });
  const result = await run();
  expect(result.content).toMatchObject({
    source_title: "来源标题",
    author: "来源作者",
  });
  expect(io.json).toHaveBeenCalledTimes(2);
  expect(io.json.mock.calls[1][0]).toContain("aid=6383");
  expect(io.json.mock.calls[1][0]).toContain("device_platform=webapp");
});
it("accepts the Jingxuan modal URL used by Douyin share cards", async () => {
  const modalUrl = "https://www.douyin.com/jingxuan?modal_id=1234567890";
  const { io, run } = setup({ url: modalUrl, html: "<p>打开App</p>" });
  const result = await run();
  expect(result.content).toMatchObject({
    source_title: "来源标题",
    author: "来源作者",
  });
  expect(io.json.mock.calls[0][0]).toContain("aweme_id=1234567890");
});
it("does not fetch detail after the mobile page itself contains usable media", async () => {
  const { io, run } = setup();
  io.page.mockResolvedValue({
    url: "https://www.iesdouyin.com/share/video/1234567890/",
    html: html(detail()),
  });
  expect((await run()).media?.url).toContain("clip.mp4");
  expect(io.json).not.toHaveBeenCalled();
});
it("does not repeat an already-read mobile share page", async () => {
  const { io, run } = setup({
    url: "https://www.iesdouyin.com/share/video/1234567890/",
    html: "<p>打开App</p>",
  });
  expect((await run()).media?.url).toContain("clip.mp4");
  expect(io.page).not.toHaveBeenCalled();
  expect(io.json).toHaveBeenCalledTimes(1);
});
it("binds a generic short-link result to its final work identity before using the API", async () => {
  const { controller, io } = setup();
  io.page.mockResolvedValue({
    url: "https://www.iesdouyin.com/share/video/1234567890/",
    html: "<p>打开App</p>",
  });
  expect(
    (
      await resolveSiteLink(
        "https://share.example/owned",
        controller.signal,
        false,
        io,
      )
    ).media?.url,
  ).toContain("clip.mp4");
  expect(io.page).toHaveBeenCalledTimes(1);
});
it("recovers a note missing its image list without falling back to background audio", async () => {
  const note = url.replace("/video/", "/note/"),
    { io, run } = setup({ url: note, html: html(detail()) });
  io.page.mockResolvedValue({
    url: "https://www.iesdouyin.com/share/note/1234567890/",
    html: "<p>打开App</p>",
  });
  io.json.mockResolvedValue({
    status_code: 0,
    aweme_detail: {
      ...detail(),
      images: [{ url_list: ["https://images.example/a.png"] }],
    },
  } as any);
  const result = await run();
  expect(result.media).toBeUndefined();
  expect(result.content.markdown).toContain("a.png");
});
it("keeps an image post failure separate from missing video media even if its API supplies background music", async () => {
  const { io, run } = setup({
    url: url.replace("/video/", "/note/"),
    html: "<p>打开App</p>",
  });
  io.page.mockResolvedValue({
    url: "https://www.iesdouyin.com/share/note/1234567890/",
    html: "<p>打开App</p>",
  });
  await expect(run()).rejects.toBeInstanceOf(SiteGalleryUnavailable);
});
it.each(["desktop", "mobile"])(
  "never requests detail after an explicit %s access challenge",
  async (stage) => {
    const blocked = '<p>请完成验证</p><input name="captcha">',
      input = { url, html: stage === "desktop" ? blocked : "<p>打开App</p>" };
    const { io, run } = setup(input);
    if (stage === "mobile")
      io.page.mockResolvedValue({
        url: "https://www.iesdouyin.com/share/video/1234567890/",
        html: blocked,
      });
    await expect(run()).rejects.toBeInstanceOf(SiteAccessDenied);
    expect(io.json).not.toHaveBeenCalled();
  },
);
it.each([403, 412, 429, 451])(
  "stops on optional HTTP %s instead of discarding the access reason",
  async (status) => {
    const { io, run } = setup();
    io.json.mockRejectedValue(
      new Error(`原站返回 HTTP ${status}，请确认登录和访问权限`),
    );
    await expect(run()).rejects.toBeInstanceOf(SiteAccessDenied);
    expect(io.json).toHaveBeenCalledTimes(1);
  },
);
it("stops when the JSON reader reports an HTML or verification response", async () => {
  const { io, run } = setup();
  io.json.mockRejectedValue(
    new Error("原站未返回有效结构化数据，可能需要登录或访问验证"),
  );
  await expect(run()).rejects.toBeInstanceOf(SiteAccessDenied);
});
it.each([
  { status_code: 8 },
  { status_code: 0, verify_url: "https://www.douyin.com/verify" },
])("does not accept an API verification payload %#", async (payload) => {
  const { io, run } = setup();
  io.json.mockResolvedValue(payload as any);
  await expect(run()).rejects.toBeInstanceOf(SiteAccessDenied);
});
it("rejects a wrong-work API response and does not expose an upstream message", async () => {
  const { io, run } = setup();
  io.json.mockResolvedValue({
    status_code: 0,
    aweme_detail: { ...detail(), aweme_id: "999" },
    message: "private upstream details",
  } as any);
  await expect(run()).rejects.toBeInstanceOf(SiteStateConflict);
});
it("never accepts a paid API work as an unprotected media input", async () => {
  const { io, run } = setup();
  io.json.mockResolvedValue({
    status_code: 0,
    aweme_detail: { ...detail(), charge_info: { is_charge_content: true } },
  } as any);
  await expect(run()).rejects.toBeInstanceOf(SiteAccessDenied);
});
it.each(["paid", "conflict"])(
  "does not call optional routes after a static %s work",
  async (mode) => {
    const data =
      mode === "paid"
        ? {
            aweme_detail: {
              ...detail(),
              charge_info: { is_charge_content: true },
            },
          }
        : { one: detail(), two: { ...detail(), desc: "冲突" } };
    const { io, run } = setup({
      url,
      html: `<script type="application/json">${JSON.stringify(data)}</script>`,
    });
    await expect(run()).rejects.toThrow();
    expect(io.page).not.toHaveBeenCalled();
    expect(io.json).not.toHaveBeenCalled();
  },
);
it("keeps known original metadata when a same-id API row has no usable state or media", async () => {
  for (const api of [
    { aweme_id: "1234567890" },
    { aweme_id: "1234567890", video: {} },
  ]) {
    const { io, run } = setup({ url, html: html({ ...detail(), video: {} }) });
    io.json.mockResolvedValue({ status_code: 0, aweme_detail: api } as any);
    await expect(run()).rejects.toMatchObject({
      content: { source_title: "来源标题", author: "来源作者" },
    });
  }
});
it.each(["empty", "unavailable", "oversized"])(
  "preserves known source metadata when optional detail is %s",
  async (mode) => {
    const { io, run } = setup({ url, html: html({ ...detail(), video: {} }) });
    if (mode === "unavailable")
      io.json.mockRejectedValue(new Error("原站返回 HTTP 503"));
    else
      io.json.mockResolvedValue(
        (mode === "empty"
          ? { status_code: 0 }
          : {
              status_code: 0,
              aweme_detail: { ...detail(), desc: "x".repeat(2 * 1024 * 1024) },
            }) as any,
      );
    const pending = run();
    await expect(pending).rejects.toMatchObject({
      content: { source_title: "来源标题", author: "来源作者", markdown: "" },
    });
    await expect(pending).rejects.toBeInstanceOf(SiteMediaUnavailable);
  },
);
it("does not interpret script delimiters in API source text as HTML or second work data", async () => {
  const { io, run } = setup();
  io.json.mockResolvedValue({
    status_code: 0,
    aweme_detail: {
      ...detail(),
      desc: "来源 </script><script>window.__INITIAL_STATE__={fake:true}</script>",
    },
  });
  const result = await run();
  expect(result.media?.url).toContain("clip.mp4");
  expect(result.content.source_description).toContain("</script>");
  expect((globalThis as any).__INITIAL_STATE__).toBeUndefined();
});
it("captures real zero metrics only when the existing template policy requests them", async () => {
  const { io, run } = setup();
  io.json.mockResolvedValue({
    status_code: 0,
    aweme_detail: {
      ...detail(),
      statistics: { digg_count: 0, collect_count: 5 },
    },
  } as any);
  expect((await run()).content.metrics).toBeUndefined();
  expect((await run(true)).content.metrics).toMatchObject({
    likes: 0,
    collects: 5,
  });
});
it.each(["cancel", "timeout"])(
  "settles API %s even if the reader ignores abort, with no accepted late media",
  async (mode) => {
    const { controller, io, run } = setup();
    let finish!: (value: any) => void;
    io.json.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    vi.useFakeTimers();
    try {
      const pending = run(),
        checked = expect(pending).rejects.toThrow(
          mode === "cancel" ? "停止当前项" : "超过30秒",
        );
      await vi.advanceTimersByTimeAsync(0);
      expect(io.json).toHaveBeenCalledTimes(1);
      if (mode === "cancel") controller.abort(new Error("停止当前项"));
      else await vi.advanceTimersByTimeAsync(30000);
      await checked;
      expect(io.json.mock.calls[0][1].aborted).toBe(true);
      finish({ status_code: 0, aweme_detail: detail() });
      await vi.advanceTimersByTimeAsync(0);
      expect(io.json).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  },
);
