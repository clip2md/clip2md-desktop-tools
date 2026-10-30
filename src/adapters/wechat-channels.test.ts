import { describe, expect, it } from "vitest";
import {
  wechatChannelsFeedError,
  wechatChannelsMediaAddress,
  wechatChannelsMediaCandidates,
  wechatChannelsPlayableAddress,
  wechatChannelsPlayableFromParse,
  wechatChannelsShareAddress,
} from "./wechat-channels";

const playable =
  "https://channels.weixin.qq.com/finder-preview/pages/feed?token=short-lived&eid=export-1";
const media =
  "https://finder.video.qq.com/251/20302/stodownload?encfilekey=signed";

describe("WeChat Channels source validation", () => {
  it.each([
    ["https://weixin.qq.com/sph/AbC123", "https://weixin.qq.com/sph/AbC123"],
    [
      "https://channels.weixin.qq.com/finder-preview/pages/sph?id=AbC123",
      "https://weixin.qq.com/sph/AbC123",
    ],
  ])("normalizes a share address from %s", (input, expected) => {
    expect(wechatChannelsShareAddress(input)).toBe(expected);
  });
  it.each([
    "http://weixin.qq.com/sph/AbC123",
    "https://weixin.qq.com.evil.test/sph/AbC123",
    "https://weixin.qq.com/sph/ab",
    "https://channels.weixin.qq.com/finder-preview/pages/sph?id=AbC123&next=evil",
  ])("rejects a non-canonical share address %s", value => {
    expect(wechatChannelsShareAddress(value)).toBeUndefined();
  });
  it("accepts only the official token-bearing playback page", () => {
    expect(wechatChannelsPlayableAddress(playable)).toBe(playable);
    expect(
      wechatChannelsPlayableAddress(
        "https://channels.weixin.qq.com/finder-preview/pages/feed?eid=1",
      ),
    ).toBeUndefined();
    expect(
      wechatChannelsPlayableAddress(
        "https://channels.weixin.qq.com.evil.test/finder-preview/pages/feed?token=x&eid=y",
      ),
    ).toBeUndefined();
  });
  it.each([
    "https://finder.example/251/20302/stodownload",
    "http://finder.video.qq.com/251/20302/stodownload",
    "https://finder.video.qq.com/redirect/mp4",
    "https://finder.video.qq.com:444/251/20302/stodownload",
  ])("rejects an unsafe media address %s", value => {
    expect(wechatChannelsMediaAddress(value)).toBeUndefined();
  });
  it("maps login and a missing short-lived playback page explicitly", () => {
    expect(wechatChannelsPlayableFromParse({ status: 401 })).toEqual({
      state: "login",
    });
    expect(
      wechatChannelsPlayableFromParse({
        status: 200,
        payload: { code: 0, data: { wx_export_id: "only-id" } },
      }),
    ).toEqual({ state: "unavailable" });
  });
  it("accepts HTTP 201 and a valid signed playback URL", () => {
    expect(
      wechatChannelsPlayableFromParse({
        status: 201,
        payload: { code: 0, data: { playable_url: playable } },
      }),
    ).toEqual({ state: "ready", address: playable });
  });
});

describe("WeChat Channels feed normalization", () => {
  const response = {
    status: 201,
    payload: {
      errCode: 0,
      data: {
        errMsg: { type: 0 },
        feedInfo: {
          description: "说明",
          h264VideoInfo: {
            videoUrl: media,
            urlToken: "&urlToken=preferred",
            duration: 61,
          },
          mediaList: [
            {
              mediaUrl: media,
              urlToken: "&urlToken=duplicate",
              decodeKey: "987654321",
            },
            {
              mediaUrl:
                "https://finder.video.qq.com/251/20303/stodownload",
              urlToken: "&urlToken=fallback",
              decodeKey: "123456789",
              fileSize: 100,
            },
          ],
        },
      },
    },
  };
  it("keeps H264 first and exposes safe H264/media-list fallbacks", () => {
    expect(wechatChannelsMediaCandidates(response.payload)).toEqual([
      {
        url: `${media}&urlToken=preferred`,
        durationSeconds: 61,
      },
      {
        url: `${media}&urlToken=duplicate`,
        decodeKey: "987654321",
      },
      {
        url:
          "https://finder.video.qq.com/251/20303/stodownload?urlToken=fallback",
        decodeKey: "123456789",
      },
    ]);
    expect(wechatChannelsFeedError(response)).toBeUndefined();
  });
  it("reports business errors without echoing unsafe response fields", () => {
    expect(
      wechatChannelsFeedError({
        status: 200,
        payload: {
          errCode: 1,
          errMsg: "<b>该内容已下架</b><script>secret</script>",
        },
      }),
    ).toBe("该内容已下架 secret");
    expect(
      wechatChannelsFeedError({
        status: 200,
        payload: {
          errCode: 0,
          data: {
            errMsg: { type: 1, title: "无法播放", content: "<b>回放已结束</b>" },
          },
        },
      }),
    ).toBe("无法播放：回放已结束");
  });
});

