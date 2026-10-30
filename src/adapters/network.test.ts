// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import https from "node:https";
import dns from "node:dns/promises";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import {
  readWebPageResult,
  resolvePublicUrl,
  readPublicImage,
  readPublicMedia,
  readPublicJson,
} from "./network";
import { extractWebPage } from "./extract";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function sources(
  rows: Array<{
    status: number;
    headers?: Record<string, string>;
    body?: Buffer | string;
  }>,
) {
  vi.spyOn(dns, "lookup").mockImplementation(
    async (host: string) =>
      [
        {
          address: host === "private.example" ? "127.0.0.1" : "8.8.8.8",
          family: 4,
        },
      ] as never,
  );
  return vi
    .spyOn(https, "get")
    .mockImplementation((url: any, options: any, callback: any) => {
      expect(options.headers).not.toHaveProperty("X-API-Key");
      expect(options.headers).not.toHaveProperty("Cookie");
      options.lookup(url.hostname, {}, (error: null, address: string) => {
        expect(error).toBeNull();
        expect(address).toBe("8.8.8.8");
      });
      const row = rows.shift();
      if (!row) throw new Error("Unexpected resource request");
      const response = Object.assign(
        Readable.from([Buffer.from(row.body || "")]),
        { statusCode: row.status, headers: row.headers || {} },
      );
      queueMicrotask(() => callback(response));
      return Object.assign(new EventEmitter(), { destroy: () => {} }) as never;
    });
}

describe("public article redirects", () => {
  it("returns the final URL when a short link ends at a non-page response", async () => {
    sources([
      {
        status: 302,
        headers: { location: "https://www.iesdouyin.com/share/video/123/" },
      },
      {
        status: 302,
        headers: { location: "https://www.douyin.com/video/123?previous_page=app_code_link" },
      },
      { status: 404, headers: { "content-type": "text/plain" }, body: "not found" },
    ]);
    await expect(
      resolvePublicUrl("https://v.douyin.com/short/", new AbortController().signal),
    ).resolves.toBe("https://www.douyin.com/video/123?previous_page=app_code_link");
  });
  it("carries only an origin-level Bilibili source hint to subtitle redirects", async () => {
    const requests = sources([
      {
        status: 302,
        headers: { location: "https://cdn.example/subtitle.json" },
      },
      {
        status: 200,
        headers: { "content-type": "application/json" },
        body: '{"body":[]}',
      },
    ]);
    await readPublicJson(
      "https://api.bilibili.com/subtitle",
      new AbortController().signal,
      "https://www.bilibili.com/video/BV17x411w7KC?private=source",
    );
    for (const row of requests.mock.calls) {
      const headers = (row[1] as any).headers;
      expect(headers.Referer).toBe("https://www.bilibili.com/");
      expect(headers["User-Agent"]).toContain("Chrome/");
      expect(JSON.stringify(headers)).not.toContain("private");
    }
  });
  it("re-evaluates the automatic site profile after redirect rather than inheriting headers from a previous domain", async () => {
    const requests = sources([
      { status: 302, headers: { location: "https://unrelated.example/final" } },
      {
        status: 200,
        headers: { "content-type": "application/json" },
        body: '{"code":0}',
      },
    ]);
    await readPublicJson(
      "https://api.bilibili.com/start",
      new AbortController().signal,
    );
    expect((requests.mock.calls[0][1] as any).headers.Referer).toBe(
      "https://www.bilibili.com/",
    );
    expect((requests.mock.calls[1][1] as any).headers.Referer).toBeUndefined();
  });
  it("uses the mobile profile only when explicitly selected and keeps it across redirects", async () => {
    const requests = sources([
      {
        status: 302,
        headers: { location: "https://www.iesdouyin.com/share/video/123/" },
      },
      {
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<h1>公开页面</h1>",
      },
    ]);
    await readWebPageResult(
      "https://mobile.example/start",
      new AbortController().signal,
      true,
    );
    for (const call of requests.mock.calls)
      expect(
        (call[1]?.headers as Record<string, string>)["User-Agent"],
      ).toContain("iPhone");
  });
  it("uses the final verified URL for relative images and links", async () => {
    sources([
      {
        status: 302,
        headers: { location: "https://article.example/folder/page" },
      },
      {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: `<html><title>文章</title><article><p>${"这是具有完整信息的公开文章内容。".repeat(10)}</p><img data-src="photo.png"><a href="next">下一篇</a></article></html>`,
      },
    ]);
    const result = await readWebPageResult(
      "https://share.example/short",
      new AbortController().signal,
    );
    expect(result.url).toBe("https://article.example/folder/page");
    const extracted = extractWebPage(result.html, result.url);
    expect(extracted.markdown).toContain(
      "https://article.example/folder/photo.png",
    );
    expect(extracted.markdown).toContain("https://article.example/folder/next");
  });
  it("rejects a private redirect before a second request", async () => {
    const requests = sources([
      { status: 302, headers: { location: "https://private.example/secrets" } },
    ]);
    await expect(
      readWebPageResult(
        "https://share.example/short",
        new AbortController().signal,
      ),
    ).rejects.toThrow("公网");
    expect(requests).toHaveBeenCalledTimes(1);
  });
  it("does not let a generic short link save a video page description without the site executor", async () => {
    sources([
      {
        status: 302,
        headers: { location: "https://www.bilibili.com/video/test" },
      },
      {
        status: 200,
        headers: { "content-type": "text/html" },
        body: `<html><title>播放器</title><article><p>${"打开应用观看视频的播放器说明。".repeat(20)}</p></article></html>`,
      },
    ]);
    const result = await readWebPageResult(
      "https://share.example/video",
      new AbortController().signal,
    );
    expect(() => extractWebPage(result.html, result.url)).toThrow("站点执行器");
  });
  it("dispatches a redirected public WeChat article to the article adapter", async () => {
    sources([
      {
        status: 302,
        headers: { location: "https://mp.weixin.qq.com/s/article" },
      },
      {
        status: 200,
        headers: { "content-type": "text/html", "content-encoding": "gzip" },
        body: gzipSync(
          '<html><title>原始标题</title><h1 id="activity-name">公众号标题</h1><div id="js_content"><img data-src="https://mmbiz.qpic.cn/image.png"></div></html>',
        ),
      },
    ]);
    const result = await readWebPageResult(
      "https://share.example/article",
      new AbortController().signal,
    );
    expect(extractWebPage(result.html, result.url)).toMatchObject({
      title: "公众号标题",
      source: "微信公众号",
    });
  });
});

describe("public source cancellation and images", () => {
  it("downloads a public media redirect with only an origin referer and no account material", async () => {
    const bytes = Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from("ftypisom"),
      Buffer.alloc(12),
    ]);
    const requests = sources([
      { status: 302, headers: { location: "https://cdn.example/file" } },
      { status: 200, headers: { "content-type": "video/mp4" }, body: bytes },
    ]);
    const result = await readPublicMedia(
      "https://media.example/a",
      new AbortController().signal,
      "https://www.bilibili.com/video/BV17x411w7KC?token=private#fragment",
    );
    expect(result.extension).toBe("mp4");
    expect(result.bytes).toEqual(bytes);
    for (const row of requests.mock.calls) {
      expect((row[1]?.headers as Record<string, string>)?.Referer).toBe(
        "https://www.bilibili.com/",
      );
      expect(JSON.stringify(row[1]?.headers)).not.toMatch(
        /private|Cookie|Authorization/,
      );
    }
  });
  it("does not send private or verification-page media to native tools", async () => {
    sources([
      { status: 302, headers: { location: "https://private.example/a" } },
    ]);
    await expect(
      readPublicMedia(
        "https://media.example/a",
        new AbortController().signal,
        "https://www.douyin.com/video/123",
      ),
    ).rejects.toThrow("公网");
    sources([
      {
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<h1>登录后查看</h1>",
      },
    ]);
    await expect(
      readPublicMedia(
        "https://media.example/a",
        new AbortController().signal,
        "https://www.douyin.com/video/123",
      ),
    ).rejects.toThrow("访问验证");
  });
  it("rejects malformed JSON without including the private source response in the error", async () => {
    sources([
      {
        status: 200,
        headers: { "content-type": "text/html" },
        body: "private_cookie=secret",
      },
    ]);
    await expect(
      readPublicJson("https://api.example/data", new AbortController().signal),
    ).rejects.toThrow("未返回有效结构化数据");
  });
  it("shares a single wall-clock budget across redirect DNS lookups", async () => {
    vi.useFakeTimers();
    const requests = sources([
      { status: 302, headers: { location: "https://redirect.example/final" } },
    ]);
    let late!: (addresses: any) => void;
    vi.mocked(dns.lookup)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () => resolve([{ address: "8.8.8.8", family: 4 }] as never),
              20000,
            );
          }) as never,
      )
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            late = resolve;
          }) as never,
      );
    const pending = expect(
      readWebPageResult(
        "https://article.example/start",
        new AbortController().signal,
      ),
    ).rejects.toThrow("超过 60 秒");
    await vi.advanceTimersByTimeAsync(20000);
    expect(requests).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(40000);
    await pending;
    late([{ address: "8.8.8.8", family: 4 }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("ends a continuously streaming response at the total deadline even without an idle timeout", async () => {
    vi.useFakeTimers();
    vi.spyOn(dns, "lookup").mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
    ] as never);
    let chunks = 0,
      aborted = false;
    vi.spyOn(https, "get").mockImplementation(
      (_url: any, options: any, callback: any) => {
        const response = Object.assign(new EventEmitter(), {
          statusCode: 200,
          headers: { "content-type": "text/html" },
        });
        const timer = setInterval(() => {
          chunks++;
          response.emit("data", Buffer.from("still streaming"));
        }, 10000);
        options.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            clearInterval(timer);
            response.emit("error", options.signal.reason);
          },
          { once: true },
        );
        queueMicrotask(() => callback(response));
        return new EventEmitter() as never;
      },
    );
    const pending = expect(
      readWebPageResult(
        "https://article.example/slow",
        new AbortController().signal,
      ),
    ).rejects.toThrow("超过 60 秒");
    await vi.advanceTimersByTimeAsync(60000);
    await pending;
    expect(chunks).toBeGreaterThanOrEqual(5);
    expect(aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["page", "image"])(
    "bounds unresolved DNS with the resource deadline (%s) and never starts a late request",
    async (kind) => {
      vi.useFakeTimers();
      const requests = sources([]);
      let finish!: (addresses: any) => void;
      vi.mocked(dns.lookup).mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }) as never,
      );
      const read = kind === "page" ? readWebPageResult : readPublicImage;
      const pending = expect(
        read("https://article.example/source", new AbortController().signal),
      ).rejects.toThrow("超过 60 秒");
      await vi.advanceTimersByTimeAsync(60000);
      await pending;
      finish([{ address: "8.8.8.8", family: 4 }]);
      await vi.advanceTimersByTimeAsync(0);
      expect(requests).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("does not resolve or connect an already stopped task", async () => {
    const requests = sources([]);
    const signal = new AbortController();
    signal.abort(new Error("已停止"));
    await expect(
      readWebPageResult("https://article.example/page", signal.signal),
    ).rejects.toThrow("已停止");
    expect(dns.lookup).not.toHaveBeenCalled();
    expect(requests).not.toHaveBeenCalled();
  });
  it("stops while DNS is pending and ignores the late lookup result", async () => {
    const requests = sources([]);
    const signal = new AbortController();
    let finish!: (addresses: any) => void;
    vi.mocked(dns.lookup).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }) as never,
    );
    const pending = readWebPageResult(
      "https://article.example/page",
      signal.signal,
    );
    signal.abort(new Error("已停止域名解析等待"));
    await expect(pending).rejects.toThrow("已停止域名解析等待");
    finish([{ address: "8.8.8.8", family: 4 }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(requests).not.toHaveBeenCalled();
  });
  it("handles a late DNS error after cancellation without restarting the task", async () => {
    const requests = sources([]);
    const signal = new AbortController();
    let fail!: (error: Error) => void;
    vi.mocked(dns.lookup).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }) as never,
    );
    const pending = readPublicImage(
      "https://images.example/picture.png",
      signal.signal,
    );
    signal.abort(new Error("停止图片下载"));
    await expect(pending).rejects.toThrow("停止图片下载");
    fail(new Error("late DNS failure"));
    await Promise.resolve();
    await Promise.resolve();
    expect(requests).not.toHaveBeenCalled();
  });
  it("rejects mixed public/private DNS answers before opening a connection", async () => {
    const requests = sources([]);
    vi.mocked(dns.lookup).mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ] as never);
    await expect(
      readPublicImage(
        "https://images.example/picture.png",
        new AbortController().signal,
      ),
    ).rejects.toThrow("公网");
    expect(requests).not.toHaveBeenCalled();
  });
  it("follows an image redirect with verified destinations and no account credentials", async () => {
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const requests = sources([
      {
        status: 302,
        headers: {
          location: "https://cdn.example/picture?wx_fmt=png&token=source",
        },
      },
      { status: 200, headers: { "content-type": "image/png" }, body: bytes },
    ]);
    const result = await readPublicImage(
      "https://images.example/original",
      new AbortController().signal,
    );
    expect(new Uint8Array(result.arrayBuffer)).toEqual(new Uint8Array(bytes));
    expect(result.headers["content-type"]).toBe("image/png");
    expect(String(requests.mock.calls[1][0])).toBe(
      "https://cdn.example/picture?wx_fmt=png&token=source",
    );
    for (const call of requests.mock.calls)
      expect(call[1]?.headers).not.toHaveProperty("Authorization");
    expect(dns.lookup).toHaveBeenCalledTimes(2);
  });
  it("rejects image redirects to private destinations without fetching the target", async () => {
    const requests = sources([
      { status: 302, headers: { location: "https://private.example/picture" } },
    ]);
    await expect(
      readPublicImage(
        "https://images.example/original",
        new AbortController().signal,
      ),
    ).rejects.toThrow("公网");
    expect(requests).toHaveBeenCalledTimes(1);
  });
});
