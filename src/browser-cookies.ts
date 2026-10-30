import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { SiteCookie } from "./auth";
import { parseNetscapeCookies } from "./tools";

function terminate(child: ReturnType<typeof spawn>): void {
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

/** Export the user's explicitly authorized Chrome session into a private temp file. */
export async function readChromeCookies(ytdlp: string, signal: AbortSignal): Promise<SiteCookie[]> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `clipmd-browser-${process.pid}-`));
  await fs.chmod(directory, 0o700);
  const file = path.join(directory, "cookies.txt");
  try {
    const probe = new AbortController();
    const timer = window.setTimeout(() => probe.abort(new Error("browser cookie export probe timed out")), 30000);
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
      await new Promise(resolve => window.setTimeout(resolve, 250));
    }
    if (signal.aborted) stop();
    if (exported) {
      probe.abort(new Error("cookie export captured"));
      await pending;
    } else {
      await pending;
    }
    probe.signal.removeEventListener("abort", stop);
    window.clearTimeout(timer);
    signal.throwIfAborted();
    const raw = exported || await fs.readFile(file, "utf8");
    return parseNetscapeCookies(raw);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
