import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire, isBuiltin } from "node:module";
import crypto from "node:crypto";
const root = path.resolve(import.meta.dirname, "..");
const out = path.resolve(
  process.env.OBSIDIAN_BUILD_OUTPUT_DIR || path.join(root, "dist"),
);
const manifest = JSON.parse(
  fs.readFileSync(path.join(out, "manifest.json"), "utf8"),
);
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
if (
  manifest.id !== "clipmd-desktop-tools" ||
  manifest.isDesktopOnly !== true ||
  manifest.version !== pkg.version ||
  manifest.minAppVersion !== "1.13.1"
)
  throw new Error("桌面插件身份、版本或平台声明不正确");
const source = fs.readFileSync(path.join(out, "main.js"), "utf8");
if (manifest.clip2mdChannel === 'market' && /codeload\.github\.com|Kitware\/CMake\/releases\/download|ffmpeg-static\/releases\/download/.test(source))
  throw new Error('市场构建不得包含网站依赖安装器');
const forbiddenPatterns = [
  /sourceMappingURL=/,
  /installComponent|performUpdate|autoUpdateEnabled|--update-to/,
  /eval\s*\(/,
  ...(manifest.clip2mdChannel === "market"
    ? [/cookies-from-browser["']\s*,\s*["'][a-z]/]
    : []),
];
for (const pattern of forbiddenPatterns)
  if (pattern.test(source))
    throw new Error("构建含禁止的安装、更新或动态代码行为");
const require = createRequire(import.meta.url);
class Stub {}
const obsidian = new Proxy(
  { Platform: { isDesktopApp: true } },
  { get: (target, key) => (key in target ? target[key] : Stub) },
);
const module = { exports: {} };
try {
  vm.runInNewContext(
    source,
    {
      module,
      exports: module.exports,
      require: (name) => {
        if (name === "obsidian") return obsidian;
        if (name === "electron")
          throw new Error("启动时不得加载原站窗口运行时");
        if (!isBuiltin(name)) throw new Error("未打包依赖：" + name);
        return require(name);
      },
      Buffer,
      URL,
      URLSearchParams,
      TextDecoder,
      TextEncoder,
      AbortController,
      AbortSignal,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      setImmediate,
      clearImmediate,
      console,
      process: { platform: process.platform, arch: process.arch, env: {} },
    },
    { timeout: 10000 },
  );
} catch (error) {
  throw new Error(
    "桌面插件模块启动失败：" +
      (error instanceof Error ? error.message : String(error)),
  );
}
if (typeof module.exports.default !== "function")
  throw new Error("未导出桌面插件入口");
console.log(
  JSON.stringify(
    {
      id: manifest.id,
      version: manifest.version,
      sha256: crypto.createHash("sha256").update(source).digest("hex"),
      bytes: Buffer.byteLength(source),
      moduleLoad: "passed",
    },
    null,
    2,
  ),
);
