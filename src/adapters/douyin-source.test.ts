// @vitest-environment jsdom
import { it, expect, vi } from "vitest";
import {
  canonicalDouyinVideo,
  nativeDouyinTarget,
  rememberResolvedDouyinVideo,
} from "./douyin-source";
import { resolveSiteLink } from "./site-link";
import {
  SiteStateUnavailable,
  SiteMediaUnavailable,
  SiteGalleryUnavailable,
  SiteAccessDenied,
  SiteStateConflict,
} from "./sites";
const canonical = "https://www.douyin.com/video/12345",
  short = "https://v.douyin.com/Owned123/";
const mobile =
  "https://www.iesdouyin.com/share/video/12345/?share_token=owned#fragment";
it.each([
  canonical,
  canonical + "/?tracking=owned#hash",
  mobile,
  "https://douyin.com/video/12345",
])("normalizes a concrete video without carrying tracking data: %s", (url) => {
  expect(canonicalDouyinVideo(url)).toBe(canonical);
});
it.each([
  short,
  "https://www.douyin.com/note/12345",
  "https://www.iesdouyin.com/share/note/12345/",
  canonical + "/other",
  "http://www.douyin.com/video/12345",
  "https://secret@www.douyin.com/video/12345",
  "https://www.douyin.com:8443/video/12345",
  "https://www.douyin.com.evil.example/video/12345",
])("does not manufacture a native identity for %s", (url) => {
  expect(canonicalDouyinVideo(url)).toBeUndefined();
});
it("keeps trusted redirect identity ephemeral, request-bound and separate from serialized source errors", () => {
  const error = new SiteStateUnavailable("缺当前作品");
  expect(nativeDouyinTarget(short, error)).toBeUndefined();
  rememberResolvedDouyinVideo(error, short, mobile);
  expect(nativeDouyinTarget(short, error)).toBe(canonical);
  expect(
    nativeDouyinTarget("https://v.douyin.com/Another/", error),
  ).toBeUndefined();
  expect(JSON.stringify(error)).toBe("{}");
  expect(Object.keys(error)).toEqual([]);
  rememberResolvedDouyinVideo(
    error,
    short,
    "https://www.douyin.com/note/12345",
  );
  expect(nativeDouyinTarget(short, error)).toBeUndefined();
});
it.each([
  new SiteAccessDenied("登录"),
  new SiteStateConflict("错作品"),
  new SiteGalleryUnavailable("缺原图"),
  new Error("未知错误"),
])(
  "does not enable a shortlink retry for terminal or non-video error %s",
  (error) => {
    rememberResolvedDouyinVideo(error, short, mobile);
    expect(nativeDouyinTarget(short, error)).toBeUndefined();
  },
);
it.each([
  "https://www.douyin.com/video/999",
  "https://www.douyin.com/note/12345",
  "http://www.douyin.com/video/12345",
])("does not transfer a concrete requested identity to %s", (resolved) => {
  expect(() =>
    rememberResolvedDouyinVideo(
      new SiteStateUnavailable("缺数据"),
      canonical,
      resolved,
    ),
  ).toThrow(SiteStateConflict);
});
it("binds a validated shortlink final URL in the real static reader before supplementing a missing page", async () => {
  const io = {
    page: vi.fn(async () => ({ url: mobile, html: "<p>打开App</p>" })),
    json: vi.fn(async () => ({ status_code: 0 })),
  };
  const error = await resolveSiteLink(
    short,
    new AbortController().signal,
    false,
    io,
  ).catch((error) => error);
  expect(error).toBeInstanceOf(SiteStateUnavailable);
  expect(nativeDouyinTarget(short, error)).toBe(canonical);
  expect(io.page).toHaveBeenCalledTimes(1);
  expect(io.json).toHaveBeenCalledTimes(3);
});
it("resolves a v.douyin.com shortlink to the ordinary video URL before reading it", async () => {
  const io = {
    resolve: vi.fn(async () => "https://www.douyin.com/video/12345?previous_page=app_code_link"),
    page: vi.fn(async () => ({ url: mobile, html: "<p>打开App</p>" })),
    json: vi.fn(async () => ({ status_code: 0 })),
  };
  await resolveSiteLink(
    short,
    new AbortController().signal,
    false,
    io,
  ).catch((error) => error);
  expect(io.resolve).toHaveBeenCalledWith(short, expect.any(AbortSignal));
  expect(io.page).toHaveBeenCalledWith(canonical, expect.any(AbortSignal));
});
it("never grants native fallback when the redirected mobile API explicitly refuses access", async () => {
  const io = {
    page: vi.fn(async () => ({ url: mobile, html: "<p>打开App</p>" })),
    json: vi.fn(async () => ({ status_code: 8 })),
  };
  const error = await resolveSiteLink(
    short,
    new AbortController().signal,
    false,
    io,
  ).catch((error) => error);
  expect(error).toBeInstanceOf(SiteAccessDenied);
  expect(nativeDouyinTarget(short, error)).toBeUndefined();
});
