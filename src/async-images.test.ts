import { describe, expect, it } from "vitest";
import { withAbort } from "./async";
import { imageExtension } from "./images";
describe("bounded native calls and image validation", () => {
  it("cancels a native promise that never settles", async () => {
    const controller = new AbortController();
    const pending = withAbort(new Promise(() => {}), controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
  it("does not treat arbitrary leading bytes or an MP4 container as an image", () => {
    expect(imageExtension(Buffer.from([137, 0, 0, 0, 0, 0, 0, 0]))).toBe("");
    expect(imageExtension(Buffer.from([255, 0, 0]))).toBe("");
    expect(imageExtension(Buffer.from("0000ftypmp42"))).toBe("");
    expect(imageExtension(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(
      "png",
    );
    expect(imageExtension(Buffer.from("RIFF0000WEBP"))).toBe("webp");
  });
});
