import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
const channel = process.env.CLIP2MD_BUILD_CHANNEL || 'market';
if (!['website', 'market'].includes(channel)) throw new Error('Invalid distribution channel');
const out = path.resolve(process.env.OBSIDIAN_BUILD_OUTPUT_DIR || "dist");
await fs.promises.mkdir(out, { recursive: true });
const plugins = channel === 'market' ? [{ name: 'market-dependency-discovery', setup(build) {
  build.onResolve({filter: /^\.\/tool-installer$/}, () => ({ path: path.resolve('src/tool-installer-market.ts') }));
  build.onResolve({filter: /^\.\/browser-cookies$/}, () => ({ path: path.resolve('src/browser-cookies-market.ts') }));
} }] : [];
const result = await esbuild.build({
  entryPoints: ["src/main.ts"],
  plugins,
  bundle: true,
  define: { CLIP2MD_CHANNEL: JSON.stringify(channel) },
  format: "cjs",
  platform: "node",
  target: "es2022",
  external: ["obsidian", "electron", "node:*"],
  minify: true,
  legalComments: "eof",
  metafile: true,
  outfile: path.join(out, "main.js"),
});
for (const name of ["manifest.json", "styles.css"]) {
  if (name === 'manifest.json') {
    const manifest = JSON.parse(fs.readFileSync(name, 'utf8'));
    manifest.clip2mdChannel = channel;
    fs.writeFileSync(path.join(out, name), JSON.stringify(manifest, null, 2) + '\n');
  } else fs.copyFileSync(name, path.join(out, name));
}
const notices = [fs.readFileSync("LICENSE", "utf8")];
const packageRoots = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const absolute = path.resolve(input);
  const matches = [
    ...absolute.matchAll(/[/\\]node_modules[/\\]((?:@[^/\\]+[/\\])?[^/\\]+)/g),
  ];
  const match = matches.at(-1);
  if (match) packageRoots.add(absolute.slice(0, match.index + match[0].length));
}
for (const root of [...packageRoots].sort()) {
  const metadata = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  for (const file of fs
    .readdirSync(root)
    .filter((name) => /^(license|copying|notice)([.-].*)?$/i.test(name)))
    notices.push(
      `${metadata.name} ${metadata.version}\n${fs.readFileSync(path.join(root, file), "utf8")}`,
    );
}
fs.appendFileSync(
  path.join(out, "main.js"),
  "\n/* Third-party notices\n" +
    notices.join("\n\n").replace(/\*\//g, "* /") +
    "\n*/\n",
);
fs.writeFileSync(
  path.join(out, "build-inputs.json"),
  JSON.stringify(Object.keys(result.metafile.inputs), null, 2),
);
