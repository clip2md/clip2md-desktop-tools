import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import dns from "node:dns/promises";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const get = vi.hoisted(() => vi.fn());
vi.mock("node:https", () => ({ default: { get } }));
import {
  downloadPublicMedia,
  MediaCandidateUnavailable,
} from "./media-download";
import { generateWechatChannelsDecryptorBytes } from "./wechat-channels-decrypt";
const directories: string[] = [];
const header = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4),
  Buffer.from("WAVE"),
  Buffer.alloc(52),
]);
async function directory() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clip2md-stream-"));
  directories.push(dir);
  return dir;
}
function sources(
  rows: Array<{
    status?: number;
    headers?: Record<string, string>;
    chunks: AsyncIterable<Buffer> | Buffer[];
  }>,
) {
  get.mockImplementation((_url: any, options: any, callback: any) => {
    const row = rows.shift();
    if (!row) throw new Error("unexpected request");
    const response = Object.assign(
      Readable.from(row.chunks, { signal: options.signal }),
      {
        statusCode: row.status ?? 200,
        headers: row.headers ?? { "content-type": "audio/wav" },
      },
    );
    const request = Object.assign(new EventEmitter(), {
      destroy: (error: Error) => {
        response.destroy(error);
      },
    });
    queueMicrotask(() => callback(response));
    return request;
  });
}
beforeEach(() => {
  get.mockReset();
  vi.spyOn(dns, "lookup").mockImplementation(
    async () => [{ address: "8.8.8.8", family: 4 }] as never,
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0))
    await fs.rm(dir, { recursive: true, force: true });
});
it("streams a media file larger than 50 MiB to disk, reports real byte progress and verifies its exact digest", async () => {
  const dir = await directory(),
    chunk = Buffer.alloc(64 * 1024, 17),
    expected = createHash("sha256").update(header);
  async function* chunks() {
    yield header;
    for (let i = 0; i < 832; i++) {
      expected.update(chunk);
      yield chunk;
    }
  }
  sources([{ chunks: chunks() }]);
  const progress = vi.fn();
  const result = await downloadPublicMedia(
    "https://media.example/file",
    new AbortController().signal,
    "https://source.example/post?secret=no",
    dir,
    progress,
  );
  expect(result.bytes).toBe(header.length + 832 * chunk.length);
  expect(result.bytes).toBeGreaterThan(50 * 1024 ** 2);
  expect(result.sha256).toBe(expected.digest("hex"));
  expect((await fs.stat(result.path)).size).toBe(result.bytes);
  expect(progress.mock.calls.at(-1)?.[0]).toBe(result.bytes);
  expect(await fs.readdir(dir)).toEqual(["site-input.wav"]);
  expect(get.mock.calls[0][1].headers.Referer).toBe("https://source.example/");
});
it("uses the YouTube browser profile when downloading googlevideo media", async () => {
  const dir = await directory();
  sources([{ chunks: [header] }]);
  await downloadPublicMedia(
    "https://rr3---sn.googlevideo.com/videoplayback?mime=video%2Fmp4",
    new AbortController().signal,
    "https://www.youtube.com/watch?v=video",
    dir,
  );
  expect(get.mock.calls[0][1].headers).toMatchObject({
    Referer: "https://www.youtube.com/",
    "User-Agent": expect.stringContaining("Chrome/150.0.7871.250"),
  });
});
it("decrypts the leading bytes of a WeChat Channels media stream", async () => {
  const dir = await directory();
  const plain = Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from("ftypisom"),
    Buffer.alloc(131_072 - 12, 0x2a),
    Buffer.alloc(64, 0x7f),
  ]);
  const key = "987654321";
  const encrypted = Buffer.from(plain);
  const stream = generateWechatChannelsDecryptorBytes(key, 131_072);
  for (let index = 0; index < stream.length; index++)
    encrypted[index] ^= stream[index];
  sources([
    {
      headers: { "content-type": "video/mp4" },
      chunks: [
        encrypted.subarray(0, 17),
        encrypted.subarray(17, 65_537),
        encrypted.subarray(65_537),
      ],
    },
  ]);
  const result = await downloadPublicMedia(
    "https://finder.video.qq.com/251/20302/stodownload?token=signed",
    new AbortController().signal,
    "https://channels.weixin.qq.com/",
    dir,
    undefined,
    { decryptKey: key },
  );
  expect(result.extension).toBe("mp4");
  expect(result.bytes).toBe(plain.length);
  expect(result.sha256).toBe(createHash("sha256").update(plain).digest("hex"));
  expect(await fs.readFile(result.path)).toEqual(plain);
});
it.each(["length", "overflow", "html", "partial", "truncated"])(
  "does not replace an existing cache or publish partial media on %s",
  async (mode) => {
    const dir = await directory(),
      prior = path.join(dir, "site-input.wav");
    await fs.writeFile(prior, "previous cache");
    sources([
      {
        status: mode === "partial" ? 206 : 200,
        headers: {
          "content-type": mode === "html" ? "text/html" : "audio/wav",
          ...(mode === "length"
            ? { "content-length": "9999" }
            : mode === "truncated"
              ? { "content-length": "100" }
              : {}),
        },
        chunks: [header],
      },
    ]);
    await expect(
      downloadPublicMedia(
        "https://media.example/file",
        new AbortController().signal,
        "https://source.example/",
        dir,
        () => undefined,
        { maxBytes: mode === "overflow" ? 32 : 1024 },
      ),
    ).rejects.toThrow();
    expect(await fs.readFile(prior, "utf8")).toBe("previous cache");
    expect(await fs.readdir(dir)).toEqual(["site-input.wav"]);
  },
);
it("stops a download after progress without publishing its partial bytes", async () => {
  const dir = await directory(),
    controller = new AbortController();
  sources([{ chunks: [header, Buffer.alloc(4096)] }]);
  await expect(
    downloadPublicMedia(
      "https://media.example/file",
      controller.signal,
      "https://source.example/",
      dir,
      () => controller.abort(new Error("停止下载")),
    ),
  ).rejects.toThrow();
  expect(await fs.readdir(dir)).toEqual([]);
});
it("validates every redirect and refuses a private target before connecting to it", async () => {
  const dir = await directory();
  vi.mocked(dns.lookup).mockImplementation(
    async (host: any) =>
      [
        {
          address: host === "private.example" ? "127.0.0.1" : "8.8.8.8",
          family: 4,
        },
      ] as never,
  );
  sources([
    {
      status: 302,
      headers: { location: "https://private.example/file" },
      chunks: [],
    },
  ]);
  await expect(
    downloadPublicMedia(
      "https://media.example/file",
      new AbortController().signal,
      "https://source.example/",
      dir,
    ),
  ).rejects.toThrow("公网");
  expect(get).toHaveBeenCalledTimes(1);
});
it("bounds DNS waiting and never opens a late request after the deadline", async () => {
  const dir = await directory();
  let finish!: (rows: any) => void;
  vi.mocked(dns.lookup).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }) as never,
  );
  await expect(
    downloadPublicMedia(
      "https://media.example/file",
      new AbortController().signal,
      "https://source.example/",
      dir,
      () => undefined,
      { timeoutMs: 30 },
    ),
  ).rejects.toThrow("超过");
  finish([{ address: "8.8.8.8", family: 4 }]);
  await Promise.resolve();
  expect(get).not.toHaveBeenCalled();
  expect(await fs.readdir(dir)).toEqual([]);
});
it.each([404, 410, 500, 502, 503, 504])(
  "classifies HTTP %s as unavailable and removes only its own staging file",
  async (status) => {
    const dir = await directory();
    await fs.writeFile(
      path.join(dir, "site-input.wav"),
      "prior verified cache",
    );
    sources([{ status, chunks: [] }]);
    await expect(
      downloadPublicMedia(
        "https://media.example/file",
        new AbortController().signal,
        "https://source.example/",
        dir,
      ),
    ).rejects.toBeInstanceOf(MediaCandidateUnavailable);
    expect(await fs.readdir(dir)).toEqual(["site-input.wav"]);
    expect(await fs.readFile(path.join(dir, "site-input.wav"), "utf8")).toBe(
      "prior verified cache",
    );
  },
);
it.each([401, 403, 412, 429, 451, 511, 206])(
  "keeps HTTP %s as a hard failure rather than a mirror-retry signal",
  async (status) => {
    const dir = await directory();
    sources([{ status, chunks: [] }]);
    try {
      await downloadPublicMedia(
        "https://media.example/file",
        new AbortController().signal,
        "https://source.example/",
        dir,
      );
      throw new Error("expected status failure");
    } catch (error) {
      expect(error).not.toBeInstanceOf(MediaCandidateUnavailable);
      expect((error as Error).message).toContain(`HTTP ${status}`);
    }
  },
);
it("does not classify an HTTP 200 verification page as a transient mirror failure", async () => {
  const dir = await directory();
  sources([
    {
      headers: { "content-type": "text/html" },
      chunks: [Buffer.from("请完成验证")],
    },
  ]);
  try {
    await downloadPublicMedia(
      "https://media.example/file",
      new AbortController().signal,
      "https://source.example/",
      dir,
    );
    throw new Error("expected validation failure");
  } catch (error) {
    expect(error).not.toBeInstanceOf(MediaCandidateUnavailable);
    expect((error as Error).message).toContain("访问验证");
  }
});
it("classifies a connection reset without exposing the underlying signed URL", async () => {
  const dir = await directory();
  get.mockImplementation(() => {
    const request = new EventEmitter();
    queueMicrotask(() =>
      request.emit(
        "error",
        Object.assign(new Error("https://cdn.example/?token=private"), {
          code: "ECONNRESET",
        }),
      ),
    );
    return request;
  });
  await expect(
    downloadPublicMedia(
      "https://media.example/file",
      new AbortController().signal,
      "https://source.example/",
      dir,
    ),
  ).rejects.toThrow("连接中断");
  expect(await fs.readdir(dir)).toEqual([]);
});
