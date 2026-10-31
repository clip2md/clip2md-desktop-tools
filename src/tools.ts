import { withPrivateCookieFile } from "./cookie-file";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { DesktopSettings } from "./config";
import type { SiteCookie } from "./auth";
import { createResolverProxy, type ResolverProxy } from "./adapters/resolver-proxy";
export async function executablePath(value: string): Promise<string> {
  if (
    !value ||
    !path.isAbsolute(value) ||
    /[\r\n\0]/.test(value) ||
    /\.(?:cmd|bat|ps1)$/i.test(value)
  )
    throw new Error("请配置手动安装工具的可执行文件绝对路径");
  const resolved = await fs.realpath(value);
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error("工具路径不是文件");
  await fs.access(
    resolved,
    process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK,
  );
  return resolved;
}
function terminate(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const taskkill = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "taskkill.exe",
    );
    const killer = spawn(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("error", () => child.kill());
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}
export async function runTool(
  executable: string,
  args: string[],
  directory: string,
  signal: AbortSignal,
  timeoutMs = 90000,
  systemBuild = false,
  environment: Record<string, string | undefined> = {},
): Promise<string> {
  signal.throwIfAborted();
  const target = await executablePath(executable);
  signal.throwIfAborted();
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  return new Promise((resolve, reject) => {
    let output = "",
      errorOutput = "",
      length = 0,
      failure: Error | undefined;
    const child = spawn(target, args, {
      shell: false,
      cwd: directory,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: systemBuild ? [path.dirname(target), '/usr/bin', '/bin', '/usr/sbin'].join(path.delimiter) : path.dirname(target),
        LANG: "en_US.UTF-8",
        TMPDIR: directory,
        TMP: directory,
        TEMP: directory,
        ...(process.platform === "win32"
          ? { SystemRoot: process.env.SystemRoot }
          : {}),
        ...environment,
      },
    });
    const stop = () => {
      failure = new Error("本地工具任务已取消");
      terminate(child);
    };
    const timer = setTimeout(() => {
      failure = new Error("本地工具运行超时");
      terminate(child);
    }, timeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    const consume = (chunk: Buffer, stdout: boolean) => {
      length += chunk.length;
      if (length > 4 * 1024 * 1024) {
        failure = new Error("工具输出超过限制");
        terminate(child);
      } else if (stdout) output += chunk.toString("utf8");
      else errorOutput += chunk.toString("utf8");
    };
    child.stdout.on("data", (c: Buffer) => consume(c, true));
    child.stderr.on("data", (c: Buffer) => consume(c, false));
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    };
    child.on("error", () => {
      cleanup();
      reject(new Error("本地工具启动失败，请检查路径及系统权限"));
    });
    child.on("close", (code) => {
      cleanup();
      if (failure || signal.aborted) reject(failure || new Error("任务已取消"));
      else if (code !== 0) {
        const detail = errorOutput
          .replace(/https?:\/\/\S+/gi, "[url]")
          .replace(/(?:\/Users\/|[A-Za-z]:[\\/])\S+/g, "[path]")
          .replace(/cookie|authorization|bearer|token/gi, "[redacted]")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 240);
        reject(new Error(`本地工具未完成（退出码 ${code}），${detail || "请检查版本、来源权限或登录状态"}`));
      }
      else resolve(output);
    });
    if (signal.aborted) stop();
  });
}

/** Parse a private Netscape cookie export without exposing cookie values to logs. */
export function parseNetscapeCookies(raw: string): SiteCookie[] {
  const result: SiteCookie[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith("#") || line.split("\t").length < 7) continue;
    const [domain, includeSubdomains, cookiePath, secure, expiration, name, ...rest] = line.split("\t");
    const value = rest.join("\t");
    if (!domain || !cookiePath || !name || /[\r\n;]/.test(`${domain}${cookiePath}${name}${value}`)) continue;
    const expiry = Number(expiration);
    result.push({
      domain,
      path: cookiePath,
      name,
      value,
      secure: secure.toUpperCase() === "TRUE",
      ...(Number.isSafeInteger(expiry) && expiry > 0 ? { expirationDate: expiry } : {}),
      ...(includeSubdomains.toUpperCase() === "TRUE" && !domain.startsWith(".") ? { domain: `.${domain}` } : {}),
    });
  }
  return result;
}

async function findJavaScriptRuntime(signal: AbortSignal): Promise<string | undefined> {
  const configured = process.env.CLIP2MD_NODE_RUNTIME;
  const candidates = [
    configured,
    path.basename(process.execPath).toLowerCase() === "node" ? process.execPath : undefined,
    ...(process.env.PATH || "").split(path.delimiter).map((directory) => path.join(directory, process.platform === "win32" ? "node.exe" : "node")),
    ...(process.platform === "win32" ? [] : ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]),
  ];
  for (const candidate of [...new Set(candidates.filter((value): value is string => !!value))]) {
    signal.throwIfAborted();
    try {
      const stat = await fs.stat(candidate);
      if (!stat.isFile()) continue;
      await fs.access(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
      return candidate;
    } catch {
      /* Try the next system runtime. */
    }
  }
  return undefined;
}

function isYouTubeUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "youtu.be" || hostname === "youtube.com" || hostname.endsWith(".youtube.com");
  } catch {
    return false;
  }
}
function isTwitterUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "x.com" || hostname.endsWith(".x.com") || hostname === "twitter.com" || hostname.endsWith(".twitter.com");
  } catch {
    return false;
  }
}

/** Export the user's explicitly authorized Chrome session into a private temp file. */
export async function readChromeCookies(ytdlp: string, signal: AbortSignal): Promise<SiteCookie[]> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `clipmd-browser-${process.pid}-`));
  await fs.chmod(directory, 0o700);
  const file = path.join(directory, "cookies.txt");
  try {
    const probe = new AbortController();
    const timer = setTimeout(() => probe.abort(new Error("browser cookie export probe timed out")), 30000);
    let exported: string | undefined;
    const readExport = async (): Promise<string | undefined> => {
      try {
        const stat = await fs.stat(file);
        if (stat.size > 1024) return await fs.readFile(file, "utf8");
      } catch { /* The browser exporter has not created the file yet. */ }
      return;
    };
    const args = [
      "--ignore-config", "--force-generic-extractor", "--skip-download", "--dump-single-json",
      "--no-warnings", "--no-check-formats", "--cookies-from-browser", "chrome::Default", "--cookies", file,
      "--socket-timeout", "5", "--retries", "0", "https://www.youtube.com/robots.txt",
    ];
    const child = spawn(ytdlp, args, {
      cwd: directory,
      shell: false,
      detached: process.platform !== "win32",
      stdio: "ignore",
      env: {
        ...process.env,
        HOME: process.env.HOME || os.homedir(),
        PATH: [path.dirname(ytdlp), process.env.PATH, "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
          .filter(Boolean)
          .join(path.delimiter),
      },
    });
    const stop = () => terminate(child);
    probe.signal.addEventListener("abort", stop, { once: true });
    const pending = new Promise<void>(resolve => child.once("close", () => resolve()));
    for (let index = 0; index < 100; index++) {
      exported = await readExport();
      if (exported) break;
      if (signal.aborted) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (signal.aborted) stop();
    if (exported) {
      probe.abort(new Error("cookie export captured"));
      await pending;
    } else {
      await pending;
    }
    probe.signal.removeEventListener("abort", stop);
    clearTimeout(timer);
    signal.throwIfAborted();
    const raw = exported || await fs.readFile(file, "utf8");
    return parseNetscapeCookies(raw);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
export function assertFFmpegCapabilities(
  muxers: string,
  protocols: string,
): void {
  if (
    !/^\s*E\s+null\s/m.test(muxers) ||
    !/^\s*E\s+matroska(?:,webm)?\s/m.test(muxers) ||
    !/^\s*file\s*$/m.test(protocols) ||
    !/^\s*pipe\s*$/m.test(protocols)
  )
    throw new Error("FFmpeg 缺少本地合并或完整性校验能力，请手动配置完整版本");
}
export async function checkTool(
  kind: "ffmpeg" | "ytdlp",
  settings: DesktopSettings,
  directory: string,
  signal: AbortSignal,
): Promise<string> {
  const output = await runTool(
    settings[kind],
    kind === "ffmpeg" ? ["-version"] : ["--version"],
    directory,
    signal,
    10000,
  );
  if (
    kind === "ffmpeg"
      ? !/^ffmpeg version /m.test(output)
      : !/^\d{4}\.\d{2}\.\d{2}/m.test(output)
  )
    throw new Error("工具版本格式不匹配");
  if (kind === "ffmpeg") {
    const [muxers, protocols] = await Promise.all([
      runTool(
        settings.ffmpeg,
        ["-hide_banner", "-muxers"],
        directory,
        signal,
        10000,
      ),
      runTool(
        settings.ffmpeg,
        ["-hide_banner", "-protocols"],
        directory,
        signal,
        10000,
      ),
    ]);
    assertFFmpegCapabilities(muxers, protocols);
  }
  if (kind === "ytdlp") {
    const help = await runTool(
      settings.ytdlp,
      ["--ignore-config", "--help"],
      directory,
      signal,
      10000,
    );
    for (const flag of [
      "--no-plugin-dirs",
      "--no-js-runtimes",
      "--no-remote-components",
    ])
      if (!help.includes(flag))
        throw new Error("yt-dlp 版本缺少隔离能力，请手动更新工具");
  }
  return output.split("\n")[0].slice(0, 150);
}
export function netscapeCookies(cookies: SiteCookie[]): string {
  return (
    "# Netscape HTTP Cookie File\n" +
    cookies
      .filter(
        (c) =>
          ![c.domain, c.path, c.name, c.value].some((v) => /[\t\r\n]/.test(v)),
      )
      .map((c) =>
        [
          c.domain,
          c.domain.startsWith(".") ? "TRUE" : "FALSE",
          c.path || "/",
          c.secure ? "TRUE" : "FALSE",
          c.expirationDate ? Math.floor(c.expirationDate) : 0,
          c.name,
          c.value,
        ].join("\t"),
      )
      .join("\n") +
    "\n"
  );
}
export interface MediaTrack {
  url: string;
  extension: string;
  expectedBytes?: number;
}
export interface VideoPlan {
  video: MediaTrack;
  audio?: MediaTrack;
  duration?: number;
}
export function parseVideoPlan(raw: string, source: string): VideoPlan {
  if (Buffer.byteLength(raw) > 2 * 1024 * 1024)
    throw new Error("媒体描述超过限制");
  let info: any;
  try {
    info = JSON.parse(raw);
  } catch {
    throw new Error("解析器未返回有效媒体描述");
  }
  if (
    !info ||
    typeof info !== "object" ||
    info.entries ||
    info.has_drm === true ||
    info.is_live === true ||
    info.live_status === "is_live"
  )
    throw new Error("不支持合集、直播或受保护媒体");
  const requested = new URL(source),
    work = requested.pathname.match(
      /\/(?:video|explore|discovery\/item)\/([A-Za-z0-9]+)/,
    )?.[1];
  if (
    work &&
    String(info.id) !== work &&
    String(info.display_id) !== work &&
    !(
      typeof info.webpage_url === "string" &&
      new URL(info.webpage_url).pathname.split("/").includes(work)
    )
  )
    throw new Error("媒体描述与来源作品不一致");
  const formats: Array<any> = Array.isArray(info.requested_formats)
    ? info.requested_formats
    : [info];
  const safe = (row: any): MediaTrack => {
    let u: URL;
    try {
      u = new URL(row.url);
    } catch {
      throw new Error("原站未提供直接媒体地址");
    }
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      row.has_drm ||
      row.fragments ||
      row.manifest_url ||
      (row.protocol && !["http", "https"].includes(row.protocol)) ||
      !["mp4", "webm", "m4a"].includes(row.ext)
    )
      throw new Error("此媒体表示尚不支持，未下载分片或受保护内容");
    return {
      url: u.href,
      extension: row.ext,
      expectedBytes:
        Number.isSafeInteger(row.filesize) && row.filesize > 0
          ? row.filesize
          : undefined,
    };
  };
  const video = formats.find(
    (row) =>
      row.vcodec &&
      row.vcodec !== "none" &&
      Number.isFinite(row.height) &&
      row.height > 0 &&
      row.height <= 1080,
  );
  const fallbackVideo = video || formats.find((row) =>
    ["mp4", "webm"].includes(row?.ext) &&
    typeof row?.url === "string" &&
    row?.vcodec == null,
  );
  if (!fallbackVideo) throw new Error("未取得不高于1080p的完整视频表示");
  const audio = formats.find(
    (row) => row.vcodec === "none" && row.acodec && row.acodec !== "none",
  );
  if ((!fallbackVideo.acodec || fallbackVideo.acodec === "none") && !audio && fallbackVideo === video)
    throw new Error("媒体描述缺少可核验音轨");
  return {
    video: safe(fallbackVideo),
    audio: audio ? safe(audio) : undefined,
    duration:
      Number.isFinite(info.duration) && info.duration > 0
        ? info.duration
        : undefined,
  };
}
export async function discoverVideo(
  url: string,
  settings: DesktopSettings,
  directory: string,
  signal: AbortSignal,
  cookies: SiteCookie[] = [],
  resolver?: ResolverProxy,
): Promise<VideoPlan> {
  await checkTool("ytdlp", settings, directory, signal);
  const youtube = isYouTubeUrl(url);
  const twitter = isTwitterUrl(url);
  const javascriptRuntime = youtube ? await findJavaScriptRuntime(signal) : undefined;
  const proxy = twitter ? undefined : (resolver || await createResolverProxy(signal));
  const ownsProxy = !twitter && !resolver;
  try {
    return await withPrivateCookieFile(
      cookies.length ? netscapeCookies(cookies) : undefined,
      async (cookiePath) => {
        const args = [
          "--ignore-config",
          "--no-config-locations",
          "--no-plugin-dirs",
          "--no-js-runtimes",
          "--no-remote-components",
          ...(javascriptRuntime ? ["--js-runtimes", `node:${javascriptRuntime}`, "--remote-components", "ejs:github"] : []),
          "--no-update",
          "--no-cache-dir",
          "--no-playlist",
          "--no-write-comments",
          "--simulate",
          "--dump-single-json",
          "--no-warnings",
          "--no-check-formats",
          ...(youtube ? ["--extractor-args", "youtube:player_client=web_embedded"] : []),
          "--socket-timeout",
          "15",
          "--retries",
          "0",
          "--extractor-retries",
          "0",
          ...(proxy ? ["--proxy", proxy.url] : []),
          ...(cookiePath
            ? ["--cookies", cookiePath]
            : ["--no-cookies", "--no-cookies-from-browser"]),
          "-f",
          ...(twitter
            ? ["best"]
            : youtube
            // The authenticated YouTube stream can be very slow through the
            // task proxy. Prefer a bounded 360p representation so ordinary
            // 15-minute jobs finish, while retaining a higher-quality
            // fallback when the source exposes no low-resolution stream.
            ? ["bv*[height<=144]+ba[abr<=80]/b[height<=144]/bv*[height<=360]+ba/b[height<=360]/bv*[height<=1080]+ba/b[height<=1080]"]
            : ["bv*[height<=1080]+ba/b[height<=1080]"]),
          "--",
          url,
        ];
        return parseVideoPlan(
          await runTool(settings.ytdlp, args, directory, signal),
          url,
        );
      },
    );
  } finally {
    if (ownsProxy && proxy) await proxy.close();
  }
}

/** Last-resort YouTube download for hosts that reject a raw googlevideo GET. */
export async function downloadYouTubeMedia(
  url: string,
  settings: DesktopSettings,
  directory: string,
  signal: AbortSignal,
  cookies: SiteCookie[],
  proxy: ResolverProxy,
): Promise<string> {
  const runtime = await findJavaScriptRuntime(signal);
  if (!runtime) throw new Error("YouTube 下载需要可用的 Node JavaScript 运行时");
  const output = path.join(directory, "youtube-complete.%(ext)s");
  await withPrivateCookieFile(netscapeCookies(cookies), async (cookiePath) => {
    if (!cookiePath) throw new Error("YouTube 下载缺少授权 Cookie");
    const args = [
      "--ignore-config", "--no-config-locations", "--no-plugin-dirs", "--no-js-runtimes",
      "--no-remote-components", "--js-runtimes", `node:${runtime}`, "--remote-components", "ejs:github",
      "--no-update", "--no-cache-dir", "--no-playlist", "--no-write-comments", "--no-write-info-json",
      "--no-write-thumbnail", "--no-write-subs", "--no-warnings", "--no-check-formats",
      "--extractor-args", "youtube:player_client=web_embedded", "--socket-timeout", "15",
      "--retries", "2", "--fragment-retries", "2", "--proxy", proxy.url,
      "--ffmpeg-location", path.dirname(settings.ffmpeg), "--cookies", cookiePath,
      "-f", "bv*[height<=144]+ba[abr<=80]/b[height<=144]/bv*[height<=360]+ba/b[height<=360]/bv*[height<=1080]+ba/b[height<=1080]",
      "--merge-output-format", "mkv", "--no-part", "-o", output, "--", url,
    ];
    await runTool(settings.ytdlp, args, directory, signal, settings.timeoutMinutes * 60000);
  });
  const files = await fs.readdir(directory);
  const result = files.find((value) => /^youtube-complete\.(?:mkv|webm|mp4)$/i.test(value));
  if (!result) throw new Error("YouTube 工具未生成完整媒体");
  return path.join(directory, result);
}

/** Download one complete media file after the source rejects its direct CDN
 * URL. The caller keeps the task proxy and saved platform cookies in scope. */
export async function downloadMediaWithYtDlp(
  url: string,
  settings: DesktopSettings,
  directory: string,
  signal: AbortSignal,
  cookies: SiteCookie[],
  resolver: ResolverProxy,
): Promise<string> {
  const output = path.join(directory, "media-complete.%(ext)s");
  await withPrivateCookieFile(
    cookies.length ? netscapeCookies(cookies) : undefined,
    async (cookiePath) => {
      const args = [
        "--ignore-config",
        "--no-config-locations",
        "--no-plugin-dirs",
        "--no-js-runtimes",
        "--no-remote-components",
        "--no-update",
        "--no-cache-dir",
        "--no-playlist",
        "--no-write-comments",
        "--no-write-info-json",
        "--no-write-thumbnail",
        "--no-write-subs",
        "--no-warnings",
        "--no-check-formats",
        "--socket-timeout",
        "15",
        "--retries",
        "2",
        "--fragment-retries",
        "2",
        "--proxy",
        resolver.url,
        "--ffmpeg-location",
        path.dirname(settings.ffmpeg),
        ...(cookiePath
          ? ["--cookies", cookiePath]
          : ["--no-cookies", "--no-cookies-from-browser"]),
        "-f",
        "bv*[height<=1080]+ba/b[height<=1080]/b",
        "--merge-output-format",
        "mkv",
        "--no-part",
        "-o",
        output,
        "--",
        url,
      ];
      await runTool(
        settings.ytdlp,
        args,
        directory,
        signal,
        settings.timeoutMinutes * 60000,
      );
    },
  );
  const files = await fs.readdir(directory);
  const result = files.find((value) =>
    /^media-complete\.(?:mkv|webm|mp4)$/i.test(value),
  );
  if (!result) throw new Error("yt-dlp 未生成完整媒体");
  const stat = await fs.stat(path.join(directory, result));
  if (!stat.isFile() || stat.size <= 0 || stat.size > settings.maxBytes)
    throw new Error("yt-dlp 生成的文件为空或超过本地下载上限");
  return path.join(directory, result);
}
