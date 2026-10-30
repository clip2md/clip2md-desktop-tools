/** Task-owned HTTPS CONNECT route for a future pinned resolver, not a general local proxy. */
import http from "node:http";
import net from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { lookupWithSignal, isPublicAddress } from "./network";

export interface ResolverProxyRuntime {
  lookup: typeof lookupWithSignal;
  connect: (options: {
    host: string;
    port: number;
    family: number;
  }) => net.Socket;
}
export interface ResolverProxy {
  /** Ephemeral loopback credential: never persist, include in diagnostics or expose to a source. */
  url: string;
  counts(): {
    connections: number;
    accepted: number;
    denied: number;
    bytes: number;
  };
  close(): Promise<void>;
}
export interface ResolverProxyLimits {
  maxBytes?: number;
}
const runtime: ResolverProxyRuntime = {
  lookup: lookupWithSignal,
  connect: (options) => net.connect(options),
};
export async function createResolverProxy(
  signal: AbortSignal,
  io: ResolverProxyRuntime = runtime,
  limits: ResolverProxyLimits = {},
): Promise<ResolverProxy> {
  signal.throwIfAborted();
  const credential = Buffer.from(
    "Basic " +
      Buffer.from("clip2md:" + randomBytes(32).toString("hex")).toString(
        "base64",
      ),
  );
  const sockets = new Set<net.Socket>(),
    counters = { connections: 0, accepted: 0, denied: 0, bytes: 0 };
  const controller = new AbortController();
  let stopped = false,
    active = 0,
    closing: Promise<void> | undefined;
  const maxBytes = Number.isSafeInteger(limits.maxBytes) && limits.maxBytes! > 0
    ? limits.maxBytes!
    : 20 * 1024 * 1024;
  const deny = (socket: net.Socket, status = 403) => {
    counters.denied++;
    socket.end(
      `HTTP/1.1 ${status} Request refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  };
  const server = http.createServer(
    { maxHeaderSize: 8192 },
    (_request, response) => {
      counters.denied++;
      response.writeHead(403, { Connection: "close" });
      response.end();
    },
  );
  const close = (): Promise<void> => {
    if (closing) return closing;
    stopped = true;
    controller.abort(new Error("resolver proxy closed"));
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    for (const socket of sockets) socket.destroy();
    closing = new Promise((resolve) => {
      if (server.listening) server.close(() => resolve());
      else resolve();
    });
    return closing;
  };
  const abort = () => {
    void close();
  };
  const timer = setTimeout(abort, 90000);
  server.maxConnections = 48;
  signal.addEventListener("abort", abort, { once: true });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(30000, () => socket.destroy());
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("connect", (request, client, head) => {
    const incoming = client as net.Socket;
    counters.connections++;
    const authorization = Buffer.from(
      typeof request.headers["proxy-authorization"] === "string"
        ? request.headers["proxy-authorization"]
        : "",
    );
    if (
      stopped ||
      controller.signal.aborted ||
      authorization.length !== credential.length ||
      !timingSafeEqual(authorization, credential)
    )
      return deny(incoming, 407);
    if (
      counters.connections > 40 ||
      active >= 4 ||
      counters.bytes >= maxBytes
    )
      return deny(incoming, 429);
    let hostname: string;
    try {
      const target = new URL("https://" + request.url);
      hostname = target.hostname.toLowerCase();
      if (
        target.username ||
        target.password ||
        (target.port && target.port !== "443") ||
        target.pathname !== "/" ||
        target.search ||
        target.hash ||
        !/^[a-z0-9.-]+$/.test(hostname) ||
        net.isIP(hostname) ||
        ![
          "douyin.com",
          "iesdouyin.com",
          "bilibili.com",
          "b23.tv",
          "xiaohongshu.com",
          "xhslink.com",
          "weibo.com",
          "weibo.cn",
          "weibocdn.com",
          "sinaimg.cn",
          "sina.com.cn",
          "youtube.com",
          "googlevideo.com",
          "googleapis.com",
          "google.com",
          "github.com",
          "githubusercontent.com",
        ].some(
          (domain) => hostname === domain || hostname.endsWith("." + domain),
        )
      )
        throw new Error();
    } catch {
      return deny(incoming);
    }
    active++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        active--;
      }
    };
    incoming.once("close", release);
    void (async () => {
      const addresses = await io.lookup(hostname, controller.signal);
      if (stopped || incoming.destroyed || controller.signal.aborted) return;
      if (
        !addresses.length ||
        addresses.some((item) => !isPublicAddress(item.address))
      )
        return deny(incoming);
      // Connect to the inspected address, never re-resolve the hostname in the native resolver or socket dial.
      const selected = addresses[0],
        upstream = io.connect({
          host: selected.address,
          port: 443,
          family: selected.family,
        });
      sockets.add(upstream);
      upstream.setTimeout(30000, () => upstream.destroy());
      const account = (chunk: Buffer) => {
        if (stopped) return;
        counters.bytes += chunk.length;
        if (counters.bytes > maxBytes) void close();
      };
      upstream.once("connect", () => {
        if (stopped || incoming.destroyed) {
          upstream.destroy();
          return;
        }
        counters.accepted++;
        incoming.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) {
          account(head);
          if (!stopped) upstream.write(head);
        }
        incoming.on("data", account);
        upstream.on("data", account);
        incoming.pipe(upstream);
        upstream.pipe(incoming);
      });
      upstream.on("error", () => incoming.destroy());
      upstream.once("close", () => {
        sockets.delete(upstream);
        incoming.destroy();
        release();
      });
      incoming.once("close", () => upstream.destroy());
    })()
      .catch(() => {
        if (!stopped && !incoming.destroyed) deny(incoming);
      })
      .finally(() => {
        if (incoming.destroyed) release();
      });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    if (signal.aborted || stopped) {
      await close();
      if (server.listening)
        await new Promise<void>((resolve) => server.close(() => resolve()));
      signal.throwIfAborted();
      throw new Error("解析器代理已停止");
    }
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("解析器代理未取得本机端口");
    const encoded = credential.toString().slice(6),
      password = Buffer.from(encoded, "base64")
        .toString()
        .slice("clip2md:".length);
    return {
      url: `http://clip2md:${password}@127.0.0.1:${address.port}`,
      counts: () => ({ ...counters }),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
