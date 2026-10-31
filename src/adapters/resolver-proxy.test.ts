// @vitest-environment node
import net from "node:net";
import { afterEach, it, expect, vi } from "vitest";
import {
  createResolverProxy,
  type ResolverProxy,
  type ResolverProxyRuntime,
} from "./resolver-proxy";
const proxies: ResolverProxy[] = [],
  clients: net.Socket[] = [],
  servers: net.Server[] = [];
async function setup(
  lookup: ResolverProxyRuntime["lookup"] = async () => [
    { address: "8.8.8.8", family: 4 },
  ],
  reply = (socket: net.Socket, data: Buffer) => {
    socket.write(data);
  },
) {
  const source = net.createServer((socket) => {
    clients.push(socket);
    socket.on("error", () => {});
    socket.on("data", (data) => reply(socket, data));
  });
  servers.push(source);
  await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve));
  const address = source.address();
  if (!address || typeof address === "string") throw new Error("fixture port");
  const controller = new AbortController(),
    io = {
      lookup: vi.fn(lookup),
      connect: vi.fn(
        (options: { host: string; port: number; family: number }) => {
          expect(options).toEqual({ host: "8.8.8.8", port: 443, family: 4 });
          return net.connect(address.port, "127.0.0.1");
        },
      ),
    };
  const proxy = await createResolverProxy(controller.signal, io);
  proxies.push(proxy);
  return { proxy, controller, io };
}
async function connect(
  proxy: ResolverProxy,
  target = "www.douyin.com:443",
  authenticated = true,
) {
  const url = new URL(proxy.url),
    client = net.connect(Number(url.port), "127.0.0.1");
  clients.push(client);
  client.on("error", () => {});
  let data = "";
  const headers = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("fixture headers timeout")),
      2000,
    );
    const read = (chunk: Buffer) => {
      data += chunk.toString();
      if (data.includes("\r\n\r\n")) {
        clearTimeout(timeout);
        client.removeListener("data", read);
        // Drain the tunnel without turning subsequent binary traffic into
        // an ever-growing handshake string. Peer close must stay observable.
        client.resume();
        resolve(data);
      }
    };
    client.on("data", read);
    client.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  const authorization = Buffer.from(`${url.username}:${url.password}`).toString(
    "base64",
  );
  client.write(
    `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${authenticated ? `Proxy-Authorization: Basic ${authorization}\r\n` : ""}\r\n`,
  );
  return { client, headers: await headers };
}
afterEach(async () => {
  for (const p of proxies.splice(0)) await p.close();
  for (const c of clients.splice(0)) c.destroy();
  await Promise.all(
    servers
      .splice(0)
      .map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
  vi.restoreAllMocks();
});
it("owns a loopback-only authenticated route and dials the vetted literal address without forwarding HTTP credentials", async () => {
  const { proxy, io } = await setup(),
    { client, headers } = await connect(proxy);
  expect(headers).toContain("200 Connection Established");
  expect(io.lookup).toHaveBeenCalledWith(
    "www.douyin.com",
    expect.any(AbortSignal),
  );
  expect(io.connect).toHaveBeenCalledTimes(1);
  const echoed = new Promise<string>((resolve) =>
    client.once("data", (chunk) => resolve(chunk.toString())),
  );
  client.write("owned-encrypted-stream");
  expect(await echoed).toBe("owned-encrypted-stream");
  expect(proxy.counts().accepted).toBe(1);
  expect(proxy.counts().bytes).toBe(44);
  expect(JSON.stringify(proxy.counts())).not.toContain(
    new URL(proxy.url).password,
  );
});
it("allows YouTube media and Google API hosts through the same vetted proxy", async () => {
  const { proxy, io } = await setup();
  expect((await connect(proxy, "www.youtube.com:443")).headers).toContain("200 Connection Established");
  expect((await connect(proxy, "rr.googlevideo.com:443")).headers).toContain("200 Connection Established");
  expect((await connect(proxy, "github.com:443")).headers).toContain("200 Connection Established");
  expect(io.lookup).toHaveBeenCalledWith("www.youtube.com", expect.any(AbortSignal));
  expect(io.lookup).toHaveBeenCalledWith("rr.googlevideo.com", expect.any(AbortSignal));
  expect(io.lookup).toHaveBeenCalledWith("github.com", expect.any(AbortSignal));
});
it("allows Weibo and its signed media CDN through the vetted proxy",async()=>{
  const { proxy, io } = await setup();
  expect((await connect(proxy, "weibo.com:443")).headers).toContain("200 Connection Established");
  expect((await connect(proxy, "f.video.weibocdn.com:443")).headers).toContain("200 Connection Established");
  expect(io.lookup).toHaveBeenCalledWith("weibo.com", expect.any(AbortSignal));
  expect(io.lookup).toHaveBeenCalledWith("f.video.weibocdn.com", expect.any(AbortSignal));
});
it("does not resolve or connect without the per-task proxy credential", async () => {
  const { proxy, io } = await setup();
  expect((await connect(proxy, "www.douyin.com:443", false)).headers).toContain(
    "407",
  );
  expect(io.lookup).not.toHaveBeenCalled();
  expect(io.connect).not.toHaveBeenCalled();
});
it.each([
  "www.douyin.com.evil.example:443",
  "127.0.0.1:443",
  "www.douyin.com:80",
  "user:secret@www.douyin.com:443",
  "www.douyin.com:443/path",
  "example.com:443",
])("rejects forbidden CONNECT destination%s before DNS", async (target) => {
  const { proxy, io } = await setup();
  expect((await connect(proxy, target)).headers).toContain("403");
  expect(io.lookup).not.toHaveBeenCalled();
  expect(io.connect).not.toHaveBeenCalled();
});
it("rejects a mixed public/private DNS answer rather than choosing only its public entry", async () => {
  const { proxy, io } = await setup(async () => [
    { address: "8.8.8.8", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ]);
  expect((await connect(proxy)).headers).toContain("403");
  expect(io.connect).not.toHaveBeenCalled();
});
it("shares a four-tunnel concurrency limit and closes its own active tunnels on cancellation", async () => {
  const { proxy, controller, io } = await setup();
  await connect(proxy);
  await connect(proxy, "www.iesdouyin.com:443");
  await connect(proxy);
  await connect(proxy);
  expect((await connect(proxy)).headers).toContain("429");
  expect(io.connect).toHaveBeenCalledTimes(4);
  controller.abort(new Error("stop owned proxy"));
  await proxy.close();
  await vi.waitFor(() =>
    expect(
      clients
        .filter((c) => c.remotePort === Number(new URL(proxy.url).port))
        .every((c) => c.destroyed || c.writableEnded),
    ).toBe(true),
  );
});
it("caps all CONNECT attempts at forty even when earlier targets were refused", async () => {
  const { proxy, io } = await setup();
  for (let index = 0; index < 40; index++)
    expect((await connect(proxy, "example.com:443")).headers).toContain("403");
  expect((await connect(proxy)).headers).toContain("429");
  expect(io.lookup).not.toHaveBeenCalled();
  expect(io.connect).not.toHaveBeenCalled();
});
it("ends the shared twenty-MiB transport budget and destroys both sides", async () => {
  const { proxy, io } = await setup(undefined, (socket) => {
      socket.write(Buffer.alloc(21 * 1024 * 1024, 1));
    }),
    { client } = await connect(proxy);
  // Send the large fixture from upstream. A client with a 21-MiB pending
  // upload can defer its own FIN while flushing after the proxy has closed;
  // that is not evidence that the proxy kept either tunnel socket alive.
  const closed = new Promise<void>((resolve) =>
    client.once("close", () => resolve()),
  );
  client.write("start-budget-fixture");
  await vi.waitFor(
    () => expect(proxy.counts().bytes).toBeGreaterThan(20 * 1024 * 1024),
    { timeout: 2000 },
  );
  await proxy.close();
  await closed;
  expect(client.destroyed).toBe(true);
  expect(io.connect.mock.results[0].value.destroyed).toBe(true);
});
it("closes admission when its ninety-second task deadline expires", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const { proxy, io } = await setup();
    await vi.advanceTimersByTimeAsync(90000);
    await proxy.close();
    expect(io.connect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
it("does not make a late dial after cancellation while DNS ignores abort", async () => {
  let finish!: (value: Array<{ address: string; family: number }>) => void;
  const { proxy, io, controller } = await setup(
    async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const url = new URL(proxy.url),
    client = net.connect(Number(url.port), "127.0.0.1");
  clients.push(client);
  client.on("error", () => {});
  client.write(
    `CONNECT www.douyin.com:443 HTTP/1.1\r\nProxy-Authorization: Basic ${Buffer.from(`${url.username}:${url.password}`).toString("base64")}\r\n\r\n`,
  );
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  controller.abort();
  await proxy.close();
  finish([{ address: "8.8.8.8", family: 4 }]);
  await Promise.resolve();
  expect(io.connect).not.toHaveBeenCalled();
});
