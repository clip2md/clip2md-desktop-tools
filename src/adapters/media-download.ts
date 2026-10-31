/** Stream public media into our job cache, with backpressure and atomic publication. */
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isPublicAddress, lookupWithSignal, mediaExtension } from "./network";
import { sourceRequestHeaders } from "./network";
import { decryptWechatChannelsMediaBuffer } from "./wechat-channels-decrypt";

export const MAX_SITE_MEDIA_BYTES = 1024 ** 3;
export interface DownloadedMedia {
  path: string;
  extension: string;
  bytes: number;
  sha256: string;
}
/** Only transport unavailability may select another source-advertised representation. */
export class MediaCandidateUnavailable extends Error {}
interface Options {
  maxBytes?: number;
  timeoutMs?: number;
  /** Task-owned HTTP CONNECT proxy, used for sources unavailable by direct egress. */
  proxy?: string;
  /** Legacy WeChat Channels media XOR-encrypt only their leading bytes. */
  decryptKey?: string;
}

async function proxyTlsSocket(
  proxyValue: string,
  target: URL,
  signal: AbortSignal,
): Promise<tls.TLSSocket> {
  const proxy = new URL(proxyValue);
  if (proxy.protocol !== "http:" || proxy.username === "" || proxy.password === "")
    throw new Error("媒体代理地址无效");
  const port = Number(proxy.port || 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("媒体代理端口无效");
  const socket = net.connect(port, proxy.hostname);
  const stop = () => socket.destroy();
  signal.addEventListener("abort", stop, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("媒体代理连接超时")), 30000);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    const auth = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64");
    socket.write(
      `CONNECT ${target.hostname}:${target.port || 443} HTTP/1.1\r\n` +
      `Host: ${target.hostname}:${target.port || 443}\r\n` +
      `Proxy-Authorization: Basic ${auth}\r\n\r\n`,
    );
    const header = await new Promise<string>((resolve, reject) => {
      let data = "";
      const timer = setTimeout(() => reject(new Error("媒体代理握手超时")), 30000);
      const read = (chunk: Buffer) => {
        data += chunk.toString("latin1");
        if (!data.includes("\r\n\r\n")) return;
        clearTimeout(timer);
        socket.removeListener("data", read);
        resolve(data);
      };
      socket.on("data", read);
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    if (!/^HTTP\/1\.\d\s+200\b/m.test(header)) {
      socket.destroy();
      throw new Error("媒体代理拒绝连接");
    }
    const secure = tls.connect({ socket, servername: target.hostname });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("媒体 TLS 握手超时")), 30000);
      secure.once("secureConnect", () => {
        clearTimeout(timer);
        resolve();
      });
      secure.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return secure;
  } finally {
    signal.removeEventListener("abort", stop);
  }
}
export async function downloadPublicMedia(
  value: string,
  signal: AbortSignal,
  referer: string,
  directory: string,
  progress: (bytes: number, total?: number) => void = () => undefined,
  options: Options = {},
): Promise<DownloadedMedia> {
  signal.throwIfAborted();
  const maxBytes = options.maxBytes ?? MAX_SITE_MEDIA_BYTES,
    timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 10 * MAX_SITE_MEDIA_BYTES ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120 * 60 * 1000
  )
    throw new Error("媒体下载预算无效");
  const source = new URL(referer);
  if (
    !["https:", "http:"].includes(source.protocol) ||
    source.username ||
    source.password
  )
    throw new Error("媒体来源页面无效");
  const controller = new AbortController(),
    stop = () => controller.abort(signal.reason);
  signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("站点媒体下载超过15分钟，请稍后重试")),
    timeoutMs,
  );
  const staged = path.join(directory, `.media-download-${randomUUID()}.tmp`);
  const decryptKey = options.decryptKey?.trim() || "";
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let activeResponse: IncomingMessage | undefined;
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    controller.signal.throwIfAborted();
    let response: IncomingMessage | undefined;
    let url = new URL(value);
    for (let redirects = 0; redirects <= 5; redirects++) {
      controller.signal.throwIfAborted();
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error("媒体链接或重定向无效");
      const host = url.hostname.replace(/^\[|\]$/g, "");
      const addresses = net.isIP(host)
        ? [{ address: host, family: net.isIP(host) }]
        : await lookupWithSignal(host, controller.signal);
      controller.signal.throwIfAborted();
      if (
        !addresses.length ||
        addresses.some((row) => !isPublicAddress(row.address))
      )
        throw new Error("站点媒体仅支持公网来源");
      const pinned = addresses[0];
      const headers = await sourceRequestHeaders(url.href, source.origin + "/");
      // Signed googlevideo URLs carry their own authorization. Forwarding a
      // stale browser cookie can make YouTube reject an otherwise valid URL.
      if (/(?:^|\.)googlevideo\.com$/i.test(url.hostname)) delete headers.Cookie;
      response = await new Promise<IncomingMessage>((resolve, reject) => {
        const start = async () => {
          let request: http.ClientRequest;
          if (options.proxy && url.protocol === "https:") {
            const secure = await proxyTlsSocket(options.proxy, url, controller.signal);
            request = https.get(url, {
              agent: false,
              createConnection: () => secure,
              signal: controller.signal,
              timeout: 30000,
              headers,
            }, (response) => {
              activeResponse = response;
              response.on("error", () => undefined);
              resolve(response);
            });
          } else {
            request = (url.protocol === "https:" ? https : http).get(
              url,
              {
                signal: controller.signal,
                timeout: 30000,
                headers,
                lookup: (_host, options, callback) => {
                  if (options.all)
                    (
                      callback as unknown as (
                        error: null,
                        rows: Array<{ address: string; family: number }>,
                      ) => void
                    )(null, [pinned]);
                  else callback(null, pinned.address, pinned.family);
                },
              },
              (response) => {
                activeResponse = response;
                response.on("error", () => undefined);
                resolve(response);
              },
            );
          }
          request.on("timeout", () =>
            request.destroy(
              Object.assign(new Error("站点媒体连接超时"), { code: "ETIMEDOUT" }),
            ),
          );
          request.on("error", reject);
        };
        void start().catch(reject);
      });
      controller.signal.throwIfAborted();
      const terminalResponse = response;
      const status = terminalResponse.statusCode || 0;
      if (status >= 300 && status < 400 && terminalResponse.headers.location) {
        const next = new URL(terminalResponse.headers.location, url);
        terminalResponse.destroy();
        response = undefined;
        if (redirects === 5) throw new Error("媒体重定向次数过多");
        url = next;
        continue;
      }
      if (status !== 200) {
        const contentType = String(terminalResponse.headers["content-type"] || "unknown");
        terminalResponse.destroy();
        const message = `原站媒体返回 HTTP ${status}（${contentType}），未取得完整媒体`;
        if (
          status === 404 ||
          status === 410 ||
          (status >= 500 && status <= 599 && status !== 511)
        )
          throw new MediaCandidateUnavailable(message);
        throw new Error(message);
      }
      break;
    }
    if (!response) throw new Error("未取得站点媒体");
    const mediaResponse: IncomingMessage = response;
    try {
      if (
        /text\/html|application\/(?:json|xhtml)/i.test(
          String(mediaResponse.headers["content-type"] || ""),
        )
      )
        throw new Error("原站媒体返回访问验证页");
      const encoding = String(
        mediaResponse.headers["content-encoding"] || "",
      ).toLowerCase();
      if (encoding && encoding !== "identity")
        throw new Error("原站未提供可直接下载的媒体字节");
      const length = mediaResponse.headers["content-length"];
      const total = length && /^\d+$/.test(length) ? Number(length) : undefined;
      if (
        total !== undefined &&
        (!Number.isSafeInteger(total) || total <= 0 || total > maxBytes)
      )
        throw new Error("站点媒体超过本次下载大小限制");
      handle = await fs.open(staged, "wx", 0o600);
      const hash = createHash("sha256");
      let bytes = 0,
        signature = Buffer.alloc(0),
        encryptedHead = Buffer.alloc(0),
        headPublished = false;
      for await (const value of mediaResponse) {
        controller.signal.throwIfAborted();
        const chunk = Buffer.from(value);
        bytes += chunk.length;
        if (bytes > maxBytes) throw new Error("站点媒体超过本次下载大小限制");
        if (signature.length < 64)
          signature = Buffer.concat([
            signature,
            chunk.subarray(0, 64 - signature.length),
          ]);
        let output = chunk;
        if (decryptKey && !headPublished) {
          const needed = 131072 - encryptedHead.length;
          encryptedHead = Buffer.concat([
            encryptedHead,
            output.subarray(0, needed),
          ]);
          output = output.subarray(needed);
          if (encryptedHead.length === 131072) {
            const head = decryptWechatChannelsMediaBuffer(
              encryptedHead,
              decryptKey,
            );
            hash.update(head);
            await handle.writeFile(head);
            headPublished = true;
          }
        }
        if (decryptKey && !headPublished)
          output = Buffer.alloc(0);
        if (output.length) {
          hash.update(output);
          await handle.writeFile(output);
        }
        progress(bytes, total);
      }
      if (decryptKey && !headPublished) {
        const head = decryptWechatChannelsMediaBuffer(
          encryptedHead,
          decryptKey,
        );
        hash.update(head);
        await handle.writeFile(head);
      }
      controller.signal.throwIfAborted();
      const extension = mediaExtension(
        decryptKey
          ? decryptWechatChannelsMediaBuffer(signature, decryptKey)
          : signature,
      );
      if (!extension || !bytes || (total !== undefined && bytes !== total))
        throw new Error("站点媒体格式或完整长度不正确");
      await handle.sync();
      await handle.close();
      handle = undefined;
      controller.signal.throwIfAborted();
      const target = path.join(directory, `site-input.${extension}`);
      await fs.rename(staged, target);
      return { path: target, extension, bytes, sha256: hash.digest("hex") };
    } finally {
      mediaResponse.destroy();
    }
  } catch (error) {
    controller.signal.throwIfAborted();
    if (
      [
        "ECONNRESET",
        "ECONNREFUSED",
        "ETIMEDOUT",
        "EPIPE",
        "ERR_STREAM_PREMATURE_CLOSE",
      ].includes((error as NodeJS.ErrnoException)?.code || "")
    ) {
      throw new MediaCandidateUnavailable("原站媒体连接中断或暂不可用");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    activeResponse?.destroy();
    if (handle) await handle.close();
    await fs.rm(staged, { force: true });
  }
}
