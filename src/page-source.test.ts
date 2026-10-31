// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { snapshotPage, workIdentityFromUrl } from "./page-source";
import { publicPageStates } from "./adapters/site-state";

describe("snapshotPage", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps Douyin inline pace state for the offline property parser", () => {
    const detail = {
      aweme_id: "123",
      desc: "正文标题",
      author: { nickname: "作者" },
    };
    document.head.innerHTML = `<script>window.__pace_f.push(${JSON.stringify([
      1,
      JSON.stringify({ videoDetail: detail }),
    ])});</script>`;
    const snapshot = snapshotPage();
    const states = publicPageStates(
      new DOMParser().parseFromString(snapshot.html, "text/html"),
    );
    expect(states).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          videoDetail: expect.objectContaining({ aweme_id: "123" }),
        }),
      ]),
    );
  });

  it("does not copy unrelated executable page scripts", () => {
    document.head.innerHTML =
      "<script>window.__private_token = 'secret'</script>";
    const snapshot = snapshotPage();
    expect(snapshot.html).not.toContain("__private_token");
  });
  it("keeps inert JSON-LD source metadata while dropping executable scripts", () => {
    document.head.innerHTML = '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"标题"}</script>';
    const snapshot = snapshotPage();
    expect(snapshot.html).toContain('application/ld+json');
    expect(snapshot.html).toContain('"headline":"标题"');
  });
  it("keeps XHS initial state for note metadata and media extraction", () => {
    document.head.innerHTML = `<script>window.__INITIAL_STATE__=${JSON.stringify({ note: { noteId: "0123456789abcdef01234567", desc: "正文" } })};</script>`;
    const snapshot = snapshotPage();
    expect(snapshot.html).toContain("__INITIAL_STATE__");
    expect(publicPageStates(new DOMParser().parseFromString(snapshot.html, "text/html"))).toEqual(
      expect.arrayContaining([expect.objectContaining({ note: expect.objectContaining({ desc: "正文" }) })]),
    );
  });
});

describe("workIdentityFromUrl", () => {
  it.each([
    ["https://www.zhihu.com/question/433226615/answer/107204764383", "107204764383"],
    ["https://www.douyin.com/video/7698659081447329050", "7698659081447329050"],
    ["https://www.bilibili.com/opus/1261621092485693461/", "1261621092485693461"],
  ])("selects the work identity from %s", (url, identity) => {
    expect(workIdentityFromUrl(url)).toBe(identity);
  });
});
