import https from "node:https";
import http from "node:http";
import dns from "node:dns/promises";
import net from "node:net";
import { gunzipSync, brotliDecompressSync, inflateSync } from "node:zlib";
import { publicSourceHeaders } from "./site-http";

const MAX_BYTES = 20 * 1024 * 1024;
const RESOURCE_DEADLINE_MS = 60000;
const MOBILE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Version/16.0 Mobile/15E148 Safari/604.1 Clip2MD/1.0";
export function isPublicAddress(address: string): boolean {
  if (address.includes(":")) {
    // Permit global unicast only; reject mapped IPv4, link-local and local ranges.
    return /^[23][a-f0-9]{3}:/i.test(address) && !/^2001:db8:/i.test(address);
  }
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  )
    return false;
  const [a, b] = parts;
  // System proxies may resolve public hosts into 198.18/15; TLS still verifies the original hostname.
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** DNS lookup itself is not cancelable; detach the task without starting a late request. */
export async function lookupWithSignal(
  hostname: string,
  signal: AbortSignal,
): Promise<Array<{ address: string; family: number }>> {
  signal.throwIfAborted();
  return new Promise<Array<{ address: string; family: number }>>(
    (resolve, reject) => {
      const cancel = () => {
        signal.removeEventListener("abort", cancel);
        reject(signal.reason);
      };
      signal.addEventListener("abort", cancel, { once: true });
      dns.lookup(hostname, { all: true }).then(
        (addresses) => {
          signal.removeEventListener("abort", cancel);
          resolve(addresses);
        },
        (error) => {
          signal.removeEventListener("abort", cancel);
          reject(error);
        },
      );
    },
  );
}

export let credentialProvider: (url: string) => Promise<string> = async () =>
  "";
export function setCredentialProvider(
  provider: typeof credentialProvider,
): void {
  credentialProvider = provider;
}
export async function sourceRequestHeaders(
  value: string,
  referer?: string,
  userAgent?: string,
): Promise<Record<string, string>> {
  const headers = publicSourceHeaders(value, referer, userAgent);
  const cookie = await credentialProvider(value);
  if (cookie) headers.Cookie = cookie;
  return headers;
}

async function readPublicResource(
  value: string,
  signal: AbortSignal,
  redirects = 0,
  maxBytes = MAX_BYTES,
  referer?: string,
  userAgent?: string,
  allowTerminalError = false,
): Promise<{ body: Buffer; type: string; url: string }> {
  signal.throwIfAborted();
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    redirects > 5
  )
    throw new Error("来源链接或重定向无效");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(hostname)
    ? [{ address: hostname, family: net.isIP(hostname) }]
    : await lookupWithSignal(hostname, signal);
  signal.throwIfAborted();
  if (
    !addresses.length ||
    addresses.some((item) => !isPublicAddress(item.address))
  )
    throw new Error("网页采集仅支持公网来源");
  const pinned = addresses[0];
  const headers = await sourceRequestHeaders(url.href, referer, userAgent);
  const result = await new Promise<{
    status: number;
    location?: string;
    body: Buffer;
    type: string;
    encoding: string;
  }>((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).get(
      url,
      {
        signal,
        timeout: 30000,
        headers,
        lookup: (_hostname, options, callback) => {
          if (options.all)
            (
              callback as unknown as (
                error: null,
                addresses: Array<{ address: string; family: number }>,
              ) => void
            )(null, [pinned]);
          else callback(null, pinned.address, pinned.family);
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > maxBytes) {
            response.destroy(
              new Error(`原站资源超过 ${maxBytes / 1024 / 1024} MB 限制`),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode || 0,
            location: response.headers.location,
            body: Buffer.concat(chunks),
            type: String(response.headers["content-type"] || ""),
            encoding: String(response.headers["content-encoding"] || ""),
          }),
        );
        response.on("error", reject);
      },
    );
    request.on("timeout", () => request.destroy(new Error("获取网页超时")));
    request.on("error", reject);
  });
  signal.throwIfAborted();
  if (result.status >= 300 && result.status < 400 && result.location)
    return readPublicResource(
      new URL(result.location, url).href,
      signal,
      redirects + 1,
      maxBytes,
      referer,
      userAgent,
      allowTerminalError,
    );
  if (!allowTerminalError && (result.status < 200 || result.status >= 300))
    throw new Error(`原站返回 HTTP ${result.status}，请确认登录和访问权限`);
  let bytes = result.body;
  const options = { maxOutputLength: maxBytes };
  if (result.encoding === "gzip") bytes = gunzipSync(bytes, options);
  else if (result.encoding === "br")
    bytes = brotliDecompressSync(bytes, options);
  else if (result.encoding === "deflate") bytes = inflateSync(bytes, options);
  return { body: bytes, type: result.type, url: url.href };
}

/** One wall-clock budget includes DNS, redirects and a slowly streaming response. */
async function readWithDeadline(
  value: string,
  signal: AbortSignal,
  maxBytes = MAX_BYTES,
  referer?: string,
  userAgent?: string,
  allowTerminalError = false,
) {
  signal.throwIfAborted();
  const controller = new AbortController();
  const stop = () => controller.abort(signal.reason);
  signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("获取原站资源超过 60 秒，可稍后重试")),
    RESOURCE_DEADLINE_MS,
  );
  let rejectCanceled!: () => void;
  const canceled = new Promise<never>((_resolve, reject) => {
    rejectCanceled = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", rejectCanceled, { once: true });
  });
  try {
    return await Promise.race([
      readPublicResource(
        value,
        controller.signal,
        0,
        maxBytes,
        referer,
        userAgent,
        allowTerminalError,
      ),
      canceled,
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    controller.signal.removeEventListener("abort", rejectCanceled);
  }
}

export async function readWebPageResult(
  value: string,
  signal: AbortSignal,
  mobile = false,
): Promise<{ html: string; url: string }> {
  const result = await readWithDeadline(
    value,
    signal,
    MAX_BYTES,
    undefined,
    mobile ? MOBILE_USER_AGENT : undefined,
  );
  if (
    result.type &&
    !/text\/(html|plain)|application\/xhtml\+xml/i.test(result.type)
  )
    throw new Error("来源不是可解析网页");
  const bytes = result.body;
  const encoding =
    result.type.match(/charset=["']?([^;\s"']+)/i)?.[1] ||
    bytes
      .subarray(0, 1024)
      .toString("ascii")
      .match(/charset=["']?([^;\s"'>]+)/i)?.[1] ||
    "utf-8";
  return { html: new TextDecoder(encoding).decode(bytes), url: result.url };
}

/**
 * Resolve a public redirect without requiring the terminal response to be a
 * successful page.  Douyin short links commonly redirect through an
 * `iesdouyin.com` share URL and finish with a 404 shell, while the final URL
 * still contains the stable `/video/{aweme_id}` identity.
 */
export async function resolvePublicUrl(
  value: string,
  signal: AbortSignal,
): Promise<string> {
  const result = await readWithDeadline(
    value,
    signal,
    256 * 1024,
    undefined,
    undefined,
    true,
  );
  return result.url;
}

export async function readWebPage(
  value: string,
  signal: AbortSignal,
): Promise<string> {
  return (await readWebPageResult(value, signal)).html;
}

export async function readPublicImage(
  value: string,
  signal: AbortSignal,
  referer?: string,
) {
  const result = await readWithDeadline(value, signal, MAX_BYTES, referer);
  return {
    status: 200,
    headers: { "content-type": result.type },
    arrayBuffer: result.body.buffer.slice(
      result.body.byteOffset,
      result.body.byteOffset + result.body.byteLength,
    ) as ArrayBuffer,
  };
}

export async function readPublicJson(
  value: string,
  signal: AbortSignal,
  referer?: string,
): Promise<any> {
  const result = await readWithDeadline(value, signal, MAX_BYTES, referer);
  try {
    return JSON.parse(result.body.toString("utf8"));
  } catch {
    throw new Error("原站未返回有效结构化数据，可能需要登录或访问验证");
  }
}

/** Small public media only. The pinned FFmpeg has network inputs disabled. */
export async function readPublicMedia(
  value: string,
  signal: AbortSignal,
  referer: string,
): Promise<{ bytes: Buffer; extension: string }> {
  const source = new URL(referer);
  if (source.protocol !== "https:" || source.username || source.password)
    throw new Error("媒体来源页面无效");
  // Do not forward a source page's signed query or fragment to a media CDN.
  const result = await readWithDeadline(
    value,
    signal,
    50 * 1024 * 1024,
    source.origin + "/",
  );
  const bytes = result.body,
    extension = mediaExtension(bytes);
  if (!extension || /text\/html|application\/(?:json|xhtml)/i.test(result.type))
    throw new Error("原站媒体为空、格式未支持或返回访问验证页");
  return { bytes, extension };
}

export function mediaExtension(bytes: Buffer): string {
  const signature = bytes.subarray(0, 16);
  return signature.subarray(4, 8).toString() === "ftyp"
    ? "mp4"
    : signature.subarray(0, 4).toString() === "RIFF" &&
        signature.subarray(8, 12).toString() === "WAVE"
      ? "wav"
      : signature.subarray(0, 3).toString() === "ID3"
        ? "mp3"
        : bytes.length > 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0
          ? "aac"
          : bytes.length > 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0
            ? "mp3"
            : signature.subarray(0, 4).toString() === "OggS"
              ? "ogg"
              : signature.subarray(0, 4).toString() === "fLaC"
                ? "flac"
                : signature.subarray(0, 3).toString() === "FLV" &&
                    bytes[3] === 1
                  ? "flv"
                  : signature
                        .subarray(0, 4)
                        .equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
                    ? "webm"
                    : "";
}
