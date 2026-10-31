/** Public source headers only. Never accept an account key, cookie or signed referer. */
const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";
const YOUTUBE_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.250 Safari/537.36";
export function publicSourceHeaders(
  value: string,
  referer?: string,
  userAgent?: string,
): Record<string, string> {
  const host = new URL(value).hostname.toLowerCase();
  const belongs = (domain: string) =>
    host === domain || host.endsWith("." + domain);
  let origin: string | undefined;
  if (referer) {
    const source = new URL(referer);
    if (
      !["https:", "http:"].includes(source.protocol) ||
      source.username ||
      source.password
    )
      throw new Error("公开来源页地址无效");
    origin = source.origin + "/";
  }
  const sourceHost = origin ? new URL(origin).hostname : "";
  const wechat = host === "mp.weixin.qq.com" || host === "weixin.qq.com" || host === "channels.weixin.qq.com" || belongs("finder.video.qq.com");
  const douyin =
    belongs("douyin.com") ||
    belongs("iesdouyin.com") ||
    /(?:^|\.)(?:douyin|iesdouyin)\.com$/.test(sourceHost);
  const xiaohongshu =
    belongs("xiaohongshu.com") ||
    belongs("rednote.com") ||
    belongs("xhslink.com") ||
    belongs("xhslink.cn") ||
    belongs("xhscdn.com") ||
    /(?:^|\.)(?:xiaohongshu|rednote)\.com$/.test(sourceHost);
  const bilibili =
    belongs("bilibili.com") ||
    belongs("bilivideo.com") ||
    host === "b23.tv" ||
    sourceHost === "bilibili.com" ||
    sourceHost.endsWith(".bilibili.com");
  const youtube =
    belongs("youtube.com") ||
    belongs("googlevideo.com") ||
    belongs("googleapis.com") ||
    host === "youtu.be" ||
    /(?:^|\.)(?:youtube\.com|youtu\.be)$/.test(sourceHost);
  const twitter =
    belongs("x.com") ||
    belongs("twitter.com") ||
    belongs("twimg.com") ||
    /(?:^|\.)(?:x\.com|twitter\.com)$/.test(sourceHost);
  const kuaishou = belongs("kuaishou.com") || belongs("kwai.com") || belongs("ks-cdn.com") || belongs("kwimgs.com") || belongs("kwaicdn.com") || belongs("gifshow.com");
  const toutiao = belongs("toutiao.com") || belongs("toutiaoimg.cn") || belongs("ixigua.com");
  return {
    "User-Agent":
      userAgent ||
      (youtube || twitter || kuaishou || toutiao
        ? YOUTUBE_UA
        : bilibili || wechat || douyin || xiaohongshu
        ? DESKTOP_UA
        : "Mozilla/5.0 Clip2MD-Desktop/1.0"),
    Accept: "*/*",
    "Accept-Encoding": "identity",
    ...(wechat || douyin || xiaohongshu
      ? { "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" }
      : {}),
    ...(origin || bilibili || youtube || twitter || kuaishou || toutiao
      ? {
          Referer:
            origin ||
            (youtube ? "https://www.youtube.com/" : twitter ? "https://x.com/" : kuaishou ? "https://www.kuaishou.com/" : toutiao ? "https://www.toutiao.com/" : "https://www.bilibili.com/"),
        }
      : {}),
  };
}
