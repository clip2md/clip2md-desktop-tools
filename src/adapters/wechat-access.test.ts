// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractWebPage, htmlToMarkdown } from "./extract";
import { WechatAccessError, WechatRequestGate } from "./wechat-access";

const url = "https://mp.weixin.qq.com/s/authored-example";
afterEach(() => vi.useRealTimers());
describe("authored WeChat access and reading structure", () => {
  it.each([
    ['<div id="wappoc_appmsgcaptcha">请进行验证</div>', "verification"],
    ["<p>微信扫一扫可打开此内容</p>", "guide"],
    ["<p>该内容已被发布者删除</p>", "unavailable"],
    ['<div id="js_content"><video>播放视频</video></div>', "empty"],
  ])(
    "classifies a non-deliverable page without saving a placeholder: %s",
    (html, kind) => {
      try {
        extractWebPage(html, url);
        throw new Error("must reject");
      } catch (error) {
        expect(error).toBeInstanceOf(WechatAccessError);
        expect((error as WechatAccessError).kind).toBe(kind);
      }
    },
  );
  it("does not treat an article quoting a verification warning as an access error", () => {
    const text =
      "这篇原文介绍如何处理安全验证和访问环境异常，示例文字属于文章内容。".repeat(
        4,
      );
    expect(
      extractWebPage(
        `<h1 id="activity-name">操作说明</h1><div id="js_content"><p>${text}</p></div>`,
        url,
      ).markdown,
    ).toContain(text);
  });
  it("restores explicit heading semantics but preserves emphasis, lists, code and ordinary centered text", () => {
    const result = htmlToMarkdown(
      '<div role="heading" aria-level="2"><strong>章节标题</strong></div><p style="text-align:center"><strong>强调文字</strong></p><ul><li><span role="heading" aria-level="3">列表内容</span></li></ul><pre><code>role="heading"</code></pre><p role="heading" aria-level="9">无效层级</p>',
      url,
    );
    expect(result).toContain("## **章节标题**");
    expect(result).toContain("**强调文字**");
    expect(result).not.toMatch(
      /^#{1,6} .*强调文字|^#{1,6} .*列表内容|^#{1,6} .*无效层级/m,
    );
    expect(result).toContain('```\nrole="heading"\n```');
  });
});
describe("bounded WeChat request gate", () => {
  it("spaces the next task from the most recent page profile rather than only from the first task start", async () => {
    vi.useFakeTimers();
    const gate = new WechatRequestGate(),
      signal = new AbortController().signal;
    const first = gate.run(url, signal, async () => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      gate.recordPageRequest(url);
      return "第一条";
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(await first).toBe("第一条");
    const fetch = vi.fn(async () => "第二条"),
      second = gate.run(url + "-next", signal, fetch);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await second).toBe("第二条");
  });
  it("caches only access failures for one minute and fetches again after expiration", async () => {
    vi.useFakeTimers();
    const gate = new WechatRequestGate(),
      signal = new AbortController().signal;
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new WechatAccessError("verification"))
      .mockResolvedValue("正文");
    const first = expect(gate.run(url, signal, fetch)).rejects.toMatchObject({
      kind: "verification",
    });
    await vi.advanceTimersByTimeAsync(0);
    await first;
    await expect(gate.run(url, signal, fetch)).rejects.toThrow("秒后重试");
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60000);
    const retry = gate.run(url, signal, fetch);
    await vi.advanceTimersByTimeAsync(0);
    expect(await retry).toBe("正文");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("does not cache network failures and spaces subsequent requests", async () => {
    vi.useFakeTimers();
    const gate = new WechatRequestGate(),
      signal = new AbortController().signal;
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue("正文");
    const first = expect(gate.run(url, signal, fetch)).rejects.toThrow(
      "network",
    );
    await vi.advanceTimersByTimeAsync(0);
    await first;
    const retry = gate.run(url, signal, fetch);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await retry).toBe("正文");
  });
  it("cancels a queued waiter promptly without releasing the running owner or starting a late request", async () => {
    vi.useFakeTimers();
    const gate = new WechatRequestGate(),
      signal = new AbortController().signal,
      controller = new AbortController();
    let release!: (text: string) => void;
    const first = gate.run(
      url,
      signal,
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(0);
    const canceledFetch = vi.fn(),
      lastFetch = vi.fn().mockResolvedValue("最后一条");
    const canceled = expect(
      gate.run(url + "2", controller.signal, canceledFetch),
    ).rejects.toThrow("停止");
    controller.abort(new Error("停止"));
    await canceled;
    const last = gate.run(url + "3", signal, lastFetch);
    await vi.advanceTimersByTimeAsync(5000);
    expect(lastFetch).not.toHaveBeenCalled();
    release("第一条");
    expect(await first).toBe("第一条");
    await vi.advanceTimersByTimeAsync(0);
    expect(await last).toBe("最后一条");
    expect(canceledFetch).not.toHaveBeenCalled();
  });
});
