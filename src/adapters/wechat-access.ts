/** Local, bounded access diagnostics. No login session or source content is retained. */
export type WechatPageKind = "verification" | "guide" | "unavailable" | "empty";
const messages: Record<WechatPageKind, string> = {
  verification:
    "公众号正文需要访问验证，请在浏览器确认原文可访问后重试；不会自动反复请求",
  guide: "公众号返回扫码或 App 引导页，尚未取得正文，请确认原文地址后重试",
  unavailable: "公众号原文已删除或停止访问，尚未取得正文，请核对原始链接",
  empty: "公众号页面未提供有效正文，可能为空壳或仅含音视频，请核对原文",
};
export class WechatAccessError extends Error {
  constructor(readonly kind: WechatPageKind) {
    super(messages[kind]);
  }
}

/** Only diagnose the wrapper when no valid article was extracted. Article quotations are not access errors. */
export function wechatAccessError(document: Document): WechatAccessError {
  const wrapper = document.body.cloneNode(true) as HTMLElement;
  wrapper
    .querySelectorAll("script,style,noscript,#js_content")
    .forEach((node) => node.remove());
  const text = wrapper.textContent?.replace(/\s+/g, " ").trim() || "";
  const content =
    document.querySelector("#js_content")?.textContent?.trim() || "";
  const notice = `${text} ${content.length < 200 ? content : ""}`;
  if (
    document.querySelector(
      '#wappoc_appmsgcaptcha,#js_verify,[action*="appmsgcaptcha"]',
    ) ||
    /安全验证|访问环境异常|环境异常.*验证|请进行验证/.test(notice)
  )
    return new WechatAccessError("verification");
  if (
    /该内容已被发布者删除|此内容因违规无法查看|内容已删除|已停止访问该网页/.test(
      notice,
    )
  )
    return new WechatAccessError("unavailable");
  if (
    /微信扫一扫.*打开|请在微信.*打开|打开微信.*查看|打开App查看/i.test(notice)
  )
    return new WechatAccessError("guide");
  return new WechatAccessError("empty");
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", stop, { once: true });
  });
}

function turn(previous: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = () => {
      signal.removeEventListener("abort", stop);
      reject(signal.reason);
    };
    signal.addEventListener("abort", stop, { once: true });
    previous.then(
      () => {
        signal.removeEventListener("abort", stop);
        resolve();
      },
      (error) => {
        signal.removeEventListener("abort", stop);
        reject(error);
      },
    );
  });
}

export class WechatRequestGate {
  private tail: Promise<void> = Promise.resolve();
  private nextRequest = 0;
  private failures = new Map<string, { until: number; kind: WechatPageKind }>();
  recordPageRequest(value: string): void {
    const url = new URL(value);
    if (
      ["https:", "http:"].includes(url.protocol) &&
      url.hostname === "mp.weixin.qq.com"
    )
      this.nextRequest = Math.max(this.nextRequest, Date.now() + 2000);
  }
  async run<T>(
    url: string,
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (new URL(url).hostname !== "mp.weixin.qq.com") return operation();
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      // A canceled waiter must not let a later request overtake the current owner.
      await turn(previous, signal);
      signal.throwIfAborted();
      const now = Date.now();
      for (const [key, value] of this.failures)
        if (value.until <= now) this.failures.delete(key);
      const cached = this.failures.get(url);
      if (cached)
        throw new Error(
          `${messages[cached.kind]}（请在 ${Math.ceil((cached.until - now) / 1000)} 秒后重试）`,
        );
      await wait(Math.max(0, this.nextRequest - now), signal);
      this.nextRequest = Date.now() + 2000;
      try {
        return await operation();
      } catch (error) {
        if (!signal.aborted && error instanceof WechatAccessError) {
          if (this.failures.size >= 128)
            this.failures.delete(this.failures.keys().next().value!);
          this.failures.set(url, {
            until: Date.now() + 60000,
            kind: error.kind,
          });
        }
        throw error;
      }
    } finally {
      void previous.then(release);
    }
  }
}
