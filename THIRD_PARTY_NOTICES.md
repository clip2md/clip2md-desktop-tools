# Third-party notices

Source parsing and bounded network/file helpers originate from Clip2MD's
`codex/local-hybrid-site-adaptation` branch, commit `b2848ea1`. Only source
extraction, subtitle, networking and local file publication helpers are reused.
The former component installer, local cloud routing, membership, OCR and ASR
runtimes are excluded. Networking is adapted to explicitly authorized site sessions.

The production bundle includes these libraries and their license notices:

| Library | Version | License |
| --- | --- | --- |
| @mixmark-io/domino | 2.2.0 | BSD-2-Clause |
| @mozilla/readability | 0.6.0 | Apache-2.0 |
| turndown | 7.2.1 | MIT |
| acorn | 8.19.0 | MIT |
| yaml | 2.9.1 | ISC |

`main.js` includes the license texts taken from the installed packages during
build. Obsidian, Electron and Node.js APIs are supplied by the host; no Electron
runtime, FFmpeg or yt-dlp binary is bundled or downloaded.

FFmpeg and yt-dlp are optional user-installed programs, distributed under their
own licenses. The plugin invokes them only through configured executable paths.

## 视频号解析参考

`src/adapters/wechat-channels.ts` and
`src/adapters/wechat-channels-decrypt.ts` were adapted from the following
MIT-licensed projects:

- joeseesun/qiaomu-clipper, commit
  `cbd122c03f41ad46025a1050f33f9bd957260b0f`:
  https://github.com/joeseesun/qiaomu-clipper
- datawhalechina/video-devour, commit
  `472f75ab3045e2ea841ef6203e10de33910b0511`:
  https://github.com/datawhalechina/video-devour

The related implementation was rewritten in TypeScript for this plugin. It
uses Yuanbao's authenticated `get_parse_result` endpoint, the official Channels
`get_feed_info` playback response, supported H.264/H.265 media fields, and the
ISAAC64 leading-byte decryption described by video-devour. No remote parser
service is required.

MIT License

Copyright (c) 2024 Obsidian

Copyright (c) 2025 bald0wang

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

`ltaoo/wx_channels_download` (Commons Clause) and the local
`wechat-inbox-sync` reference were reviewed only for observable behavior and
cross-checking; no code from either project is vendored in this bundle.

## 网站版按需下载的工具

这些依赖不随插件 ZIP 分发，首次启用从 Clip2MD 自有 TOS 镜像按需下载并校验。发布人通过 `scripts/sync-obsidian-tools-to-tos.py` 按 `tool-assets.json` 的固定摘要同步上游文件；运行时不访问下列上游地址：

- FFmpeg-static b6.1.1（实际 FFmpeg 版本以各平台二进制检测为准）：https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1 ，FFmpeg GPL/LGPL 与各平台发行附件中的许可证及源码说明适用。
- whisper.cpp：macOS 1.9.5 / Windows CPU 1.8.2，MIT，https://github.com/ggml-org/whisper.cpp 。
- CMake 4.4.4：仅 macOS 安装 Whisper 的构建工具，BSD 3-Clause，https://github.com/Kitware/CMake/releases/tag/v4.4.4 。
- yt-dlp 2026.10.21：https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.21 ，二进制内各组件遵循上游发行许可证。
- Whisper 多语言 base 权重：https://huggingface.co/ggerganov/whisper.cpp ，原始 Whisper 模型 MIT，https://github.com/openai/whisper 。

不再由用户选择模型或配置模型文件路径。市场源码与构建只保留手动依赖检测及修复说明，不含依赖安装器。
