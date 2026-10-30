import { describe, expect, it } from "vitest";
import { applePodcastsLink, type SiteReaders } from "./site-link";

const io: SiteReaders = {
  page: async () => ({ html: "", url: "" }),
  json: async () => ({
    results: [
      {
        trackId: 456,
        trackName: "示例单集",
        artistName: "节目作者",
        releaseDate: "2026-10-24T00:00:00Z",
        trackTimeMillis: 123000,
        description: "节目简介",
        artworkUrl600: "https://is.example.com/cover.jpg",
        episodeUrl: "https://audio.example.com/episode.m4a",
      },
    ],
  }),
};

describe("Apple Podcasts source", () => {
  it("resolves episode metadata, cover and audio from Apple's lookup response", async () => {
    const result = await applePodcastsLink(
      "https://podcasts.apple.com/us/podcast/show/id123?i=456",
      new AbortController().signal,
      io,
      true,
    );
    expect(result.detectedMedia).toBe("audio");
    expect(result.media?.url).toBe("https://audio.example.com/episode.m4a");
    expect(result.content).toMatchObject({
      title: "示例单集",
      author: "节目作者",
      duration_seconds: 123,
    });
    expect(result.content.markdown).toContain("cover.jpg");
  });

  it("requires an episode URL instead of treating a show page as an episode", async () => {
    await expect(
      applePodcastsLink(
        "https://podcasts.apple.com/us/podcast/show/id123",
        new AbortController().signal,
        io,
      ),
    ).rejects.toThrow("具体单集链接");
  });
});
