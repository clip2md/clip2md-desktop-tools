/** Local-only ASR with checked tools and the fixed managed transcription resource. */
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runTool } from './tools';
import type { DesktopSettings } from './config';
async function fileHash(file: string, signal: AbortSignal): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) {
        signal.throwIfAborted();
        hash.update(chunk as Buffer);
    }
    return hash.digest('hex');
}
function pcmData(wav: Buffer): Buffer {
    if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE')
        throw new Error('音频分段不是 WAV');
    let offset = 12;
    while (offset + 8 <= wav.length) {
        const size = wav.readUInt32LE(offset + 4);
        if (wav.toString('ascii', offset, offset + 4) === 'data') {
            if (size > 600 * 32000 + 32000 || size < 2 || offset + 8 + size > wav.length)
                throw new Error('音频分段损坏或截断');
            return wav.subarray(offset + 8, offset + 8 + size);
        }
        offset += 8 + size + (size % 2);
    }
    throw new Error('音频分段缺少 PCM 数据');
}
export function parseTranscript(raw: string, offset = 0, maxDurationMs = 600000, durationToleranceMs = 0): string {
    const data = JSON.parse(raw) as {
        transcription?: Array<{
            text: string;
            offsets: {
                from: number;
                to: number;
            };
        }>;
    };
    if (!Array.isArray(data.transcription))
        throw new Error('Whisper JSON 输出格式不兼容');
    let previous = 0;
    return data.transcription.map(row => {
        if (!row.offsets || !Number.isFinite(row.offsets.from) || !Number.isFinite(row.offsets.to) || row.offsets.from < previous || row.offsets.to < row.offsets.from || row.offsets.to > maxDurationMs + 1000 + durationToleranceMs || typeof row.text !== 'string')
            throw new Error('转写时间轴无效');
        previous = row.offsets.to;
        const seconds = Math.floor((offset + row.offsets.from) / 1000);
        return row.text.trim() ? `[${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}] ${row.text.trim()}` : '';
    }).filter(Boolean).join('\n\n');
}
export function decodedDuration(progress: string, pcmSeconds: number[], expectedDuration?: number): number {
    const times = [...progress.matchAll(/out_time_us=(\d+)/g)].map(m => Number(m[1]) / 1000000);
    const reported = times[times.length - 1];
    const duration = pcmSeconds.reduce((total, n) => total + n, 0);
    // FFmpeg 6 reports the START of the final PCM packet; newer builds may
    // report its end. The fixed 1600-sample filter bounds this gap to 100 ms.
    if (!progress.includes('progress=end') || !Number.isFinite(reported) || !duration || pcmSeconds.some(n => !Number.isFinite(n) || n <= 0) || Math.abs(reported - duration) > .1001 || (expectedDuration && Math.abs(duration - expectedDuration) > Math.max(2, Math.min(30, expectedDuration * .01))))
        throw new Error('媒体解码不完整，未发布转写');
    return duration;
}
export async function transcribe(file: string, directory: string, settings: DesktopSettings, signal: AbortSignal, expectedDuration?: number, offsetMs = 0): Promise<string> {
    const identity = createHash('sha256').update([await fileHash(file, signal), await fileHash(settings.whisperModel, signal), await fileHash(settings.whisper, signal), await fileHash(settings.ffmpeg, signal), settings.language, 'asr-v2'].join(':')).digest('hex');
    const work = path.join(directory, identity);
    await fs.mkdir(work, { recursive: true, mode: 0o700 });
    const segments = path.join(work, 'segment-%05d.wav');
    const entries = (await fs.readdir(work)).filter(f => /^segment-\d{5}\.wav$/.test(f)).sort();
    // Decode into complete segments before trusting or publishing any transcript.
    if (!entries.length || !(await fs.stat(path.join(work, 'decoded.json')).catch(() => null))) {
        for (const file of entries)
            await fs.rm(path.join(work, file));
        const progressFile = path.join(work, 'decode.progress');
        await runTool(settings.ffmpeg, ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-af', 'asetnsamples=n=1600:p=0', '-c:a', 'pcm_s16le', '-f', 'segment', '-segment_time', '600', '-progress', progressFile, '-y', segments], work, signal, settings.asrTimeoutMinutes * 60000);
        const progress = await fs.readFile(progressFile, 'utf8');
        const samples: number[] = [];
        for (const name of (await fs.readdir(work)).filter(f => /^segment-\d{5}\.wav$/.test(f)).sort()) {
            signal.throwIfAborted();
            samples.push(pcmData(await fs.readFile(path.join(work, name))).length / 32000);
        }
        const duration = decodedDuration(progress, samples, expectedDuration);
        await fs.writeFile(path.join(work, 'decoded.json'), JSON.stringify({ duration }));
    }
    const files = (await fs.readdir(work)).filter(f => /^segment-\d{5}\.wav$/.test(f)).sort();
    if (!files.length)
        throw new Error('没有有效音频');
    const manifest = JSON.parse(await fs.readFile(path.join(work, 'decoded.json'), 'utf8')) as {
        duration: number;
    };
    if (files.length !== Math.ceil(manifest.duration / 600))
        throw new Error('音频分段数量与完整来源不符');
    let decodedSeconds = 0;
    const result: string[] = [];
    for (const [index, name] of files.entries()) {
        signal.throwIfAborted();
        if (name !== `segment-${String(index).padStart(5, '0')}.wav`)
            throw new Error('音频分段不连续');
        const input = path.join(work, name), fingerprint = await fileHash(input, signal), output = path.join(work, `${name}-${fingerprint}.out`);
        const pcm = pcmData(await fs.readFile(input));
        decodedSeconds += pcm.length / 32000;
        if (index < files.length - 1 && Math.abs(pcm.length / 32000 - 600) > .1)
            throw new Error('音频分段被截断');
        if (pcm.every(byte => byte === 0))
            continue;
        let reusable = false;
        try {
            const prior = JSON.parse(await fs.readFile(output + '.done', 'utf8')) as {
                sha256: string;
            };
            reusable = prior.sha256 === await fileHash(output + '.json', signal);
        }
        catch { /* Interrupted output is not a checkpoint. */ }
        if (!reusable) {
            await runTool(settings.whisper, ['-m', settings.whisperModel, '-f', input, '-l', settings.language, '-oj', '-of', output, '-np'], work, signal, settings.asrTimeoutMinutes * 60000);
        }
        const raw = await fs.readFile(output + '.json', 'utf8');
        if (Buffer.byteLength(raw) > 4 * 1024 * 1024)
            throw new Error('转写输出超过限制');
        result.push(parseTranscript(raw, offsetMs + index * 600000, pcm.length / 32, 2000));
        await fs.writeFile(output + '.done', JSON.stringify({ sha256: await fileHash(output + '.json', signal) }), { mode: 0o600 });
    }
    if (Math.abs(decodedSeconds - manifest.duration) > Math.max(.1, Math.min(2, manifest.duration * .001)))
        throw new Error('音频分段未覆盖完整输入');
    const text = result.filter(Boolean).join('\n\n');
    if (!text.trim())
        throw new Error('没有识别到语音');
    return text;
}
export async function checkTranscription(settings: DesktopSettings, directory: string, signal: AbortSignal): Promise<string> {
    const ffmpegVersion = await runTool(settings.ffmpeg, ['-version'], directory, signal, 10000);
    if (!ffmpegVersion.startsWith('ffmpeg version '))
        throw new Error('FFmpeg 版本格式不匹配');
    if (!path.isAbsolute(settings.whisperModel) || !(await fs.stat(settings.whisperModel)).isFile())
        throw new Error('内置转写资源缺失，请返回扩展设置重试准备工具');
    const version = await runTool(settings.whisper, ['--version'], directory, signal, 10000);
    const wav = path.join(directory, 'selftest.wav');
    // A real PCM input checks decoding/model loading/JSON without network access.
    const samples = Buffer.alloc(16000 * 2), header = Buffer.alloc(44);
    header.write('RIFF');
    header.writeUInt32LE(36 + samples.length, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16000, 24);
    header.writeUInt32LE(32000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(samples.length, 40);
    await fs.writeFile(wav, Buffer.concat([header, samples]));
    const converted = path.join(directory, 'selftest-segment-00000.wav');
    await fs.rm(converted, { force: true });
    await runTool(settings.ffmpeg, ['-nostdin', '-v', 'error', '-i', wav, '-ac', '1', '-ar', '16000', '-af', 'asetnsamples=n=1600:p=0', '-c:a', 'pcm_s16le', '-f', 'segment', '-segment_time', '600', '-n', path.join(directory,'selftest-segment-%05d.wav')], directory, signal);
    const output = path.join(directory, 'selftest');
    await runTool(settings.whisper, ['-m', settings.whisperModel, '-f', converted, '-l', settings.language, '-oj', '-of', output, '-np'], directory, signal, settings.asrTimeoutMinutes * 60000);
    parseTranscript(await fs.readFile(output + '.json', 'utf8'));
    return version.split('\n')[0].slice(0, 100);
}
