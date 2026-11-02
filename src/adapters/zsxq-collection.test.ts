import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
const mocks=vi.hoisted(()=>({download:vi.fn(),transcribe:vi.fn(),run:vi.fn(),image:vi.fn()}));
vi.mock('./media-download',()=>({downloadPublicMedia:mocks.download}));
vi.mock('./network',()=>({readPublicImage:mocks.image}));
vi.mock('../transcription',()=>({transcribe:mocks.transcribe}));
vi.mock('../tools',()=>({checkTool:vi.fn(),runTool:mocks.run}));
import { collectZsxqResources } from './zsxq-collection';
import { normalizeSettings } from '../config';
import type { SiteResult } from './sites';
import type { MaterialStore } from '../storage';
const context={taskId:42,bindingScope:'a'.repeat(64),sourceUrl:'https://wx.zsxq.com/topic/123',contentVersion:'1',notePath:'收藏/主题.md',daily:false};
let temporary:string,store:MaterialStore;
const signal=()=>new AbortController().signal;
const settings=normalizeSettings({});
const deps={refresh:vi.fn(),hls:vi.fn()};
beforeEach(async()=>{
    vi.resetAllMocks();temporary=await fs.mkdtemp(path.join(os.tmpdir(),'zsxq-collection-'));await fs.mkdir(path.join(temporary,'checkpoint'));
    store={checkpoint:async()=>path.join(temporary,'checkpoint'),localFile:async(file:string)=>path.join(temporary,file),manifest:async(files:string[])=>Promise.all(files.map(async file=>({path:file,sha256:createHash('sha256').update(await fs.readFile(path.join(temporary,file))).digest('hex')}))),media:vi.fn(async(_c,kind,download)=>{const file=`${kind}-${download.sha256}.${download.extension}`;await fs.copyFile(download.path,path.join(temporary,file));return file;}),text:vi.fn(async(_c,kind,text)=>{const file=kind+'.md';await fs.writeFile(path.join(temporary,file),text);return file;})} as unknown as MaterialStore;
    mocks.download.mockImplementation(async(url:string,_s,_r,directory:string)=>{const bytes=Buffer.from(url),sha256=createHash('sha256').update(bytes).digest('hex'),file=path.join(directory,'input.mp3');await fs.writeFile(file,bytes);return {path:file,bytes:bytes.length,sha256,extension:'mp3'};});
    mocks.run.mockRejectedValue(new Error('no embedded subtitles'));mocks.transcribe.mockImplementation(async(file:string)=>'转写 '+path.basename(file));
});
afterEach(async()=>{await fs.rm(temporary,{recursive:true,force:true});});
const media=(id:string)=>({id,topicId:'123',title:`媒体 ${id}`,kind:'audio' as const,url:`https://files.zsxq.com/${id}.mp3`,referer:context.sourceUrl});
const source=(ids=['1','2']):SiteResult=>({content:{title:'主题',markdown:''},mediaItems:ids.map(media)});
describe('durable independent topic resources',()=>{
    it('preserves successful resources and downloads only failed items on retry and restart',async()=>{
        const original=mocks.download.getMockImplementation()!;
        mocks.download.mockImplementation(async(...args:any[])=>{if(args[0].includes('/2.'))throw new Error('HTTP 500');return original(...args);});
        const first=await collectZsxqResources(source(),context,'video',settings,store,signal(),()=>{},deps);
        expect(first.failures).toHaveLength(1);expect(first.assets).toHaveLength(1);expect(first.body).toContain('媒体 2：HTTP 500');
        mocks.download.mockImplementation(original);mocks.download.mockClear();
        const second=await collectZsxqResources(source(),context,'video',settings,store,signal(),()=>{},deps);
        expect(second.failures).toBeUndefined();expect(second.assets).toHaveLength(2);expect(mocks.download).toHaveBeenCalledTimes(1);expect(mocks.download.mock.calls[0][0]).toContain('/2.mp3');
    });
    it('transcribes every independent media with time zero and never combines parts',async()=>{
        const result=await collectZsxqResources(source(),context,'subtitles',settings,store,signal(),()=>{},deps);
        expect(result.failures).toBeUndefined();expect(mocks.transcribe).toHaveBeenCalledTimes(2);
        expect(mocks.transcribe.mock.calls.every(row=>row[5]===0)).toBe(true);expect(result.body).toContain('### 媒体 1');expect(result.body).toContain('### 媒体 2');
        await collectZsxqResources(source(),context,'subtitles',settings,store,signal(),()=>{},deps);
        expect(mocks.transcribe).toHaveBeenCalledTimes(2);
    });
    it('refreshes an expired download address once without triggering login',async()=>{
        mocks.download.mockImplementationOnce(async()=>{throw new Error('原站媒体返回 HTTP 403');});
        deps.refresh.mockResolvedValue(source(['1']));
        const result=await collectZsxqResources(source(['1']),context,'video',settings,store,signal(),()=>{},deps);
        expect(result.failures).toBeUndefined();expect(deps.refresh).toHaveBeenCalledTimes(1);expect(mocks.download).toHaveBeenCalledTimes(2);
    });
    it('prefers associated source subtitles without downloading or transcribing media',async()=>{
        const result=source(['1']);result.mediaItems![0].subtitles=[{url:'https://files.zsxq.com/1.vtt'}];
        mocks.image.mockResolvedValue({arrayBuffer:Buffer.from('WEBVTT\n\n00:00.000 --> 00:01.000\n原站字幕')});
        const captured=await collectZsxqResources(result,context,'subtitles',settings,store,signal(),()=>{},deps);
        expect(captured.body).toContain('原站字幕');expect(mocks.download).not.toHaveBeenCalled();expect(mocks.transcribe).not.toHaveBeenCalled();
    });
    it('does not mark an inaccessible player or missing file URL as successful',async()=>{
        const result=source(['1']);result.mediaItems![0].url='';result.mediaItems![0].error='播放器未暴露可下载原件';
        const captured=await collectZsxqResources(result,context,'video',settings,store,signal(),()=>{},deps);
        expect(captured.assets).toEqual([]);expect(captured.failures).toEqual(['媒体 1：播放器未暴露可下载原件']);
    });
    it('reuses a successful download after cancellation while preserving cancellation itself',async()=>{
        const controller=new AbortController(),original=mocks.download.getMockImplementation()!;
        mocks.download.mockImplementation(async(...args:any[])=>{if(args[0].includes('/2.')){controller.abort();controller.signal.throwIfAborted();}return original(...args);});
        await expect(collectZsxqResources(source(),context,'video',settings,store,controller.signal,()=>{},deps)).rejects.toBeDefined();
        mocks.download.mockImplementation(original);mocks.download.mockClear();
        await collectZsxqResources(source(),context,'video',settings,store,signal(),()=>{},deps);
        expect(mocks.download).toHaveBeenCalledTimes(1);
    });
});
it('reuses original images by source ID and digest across article/image retries',async()=>{
    const png=Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489','hex');
    mocks.image.mockResolvedValueOnce({arrayBuffer:png,headers:{'content-type':'image/png'}}).mockRejectedValueOnce(new Error('图片不可用'));
    const result:SiteResult={content:{title:'主题',markdown:'',image_urls:['https://images.zsxq.com/1.png','https://images.zsxq.com/2.png']},imageItems:[{topicId:'123',id:'1',url:'https://images.zsxq.com/1.png'},{topicId:'123',id:'2',url:'https://images.zsxq.com/2.png'}]};
    const first=await collectZsxqResources(result,context,'images',settings,store,signal(),()=>{},deps);
    expect(first.assets).toHaveLength(1);expect(first.failures).toHaveLength(1);
    mocks.image.mockResolvedValue({arrayBuffer:png,headers:{'content-type':'image/png'}});mocks.image.mockClear();
    const second=await collectZsxqResources(result,context,'images',settings,store,signal(),()=>{},deps);
    expect(second.failures).toBeUndefined();expect(mocks.image).toHaveBeenCalledTimes(1);expect(second.assets).toHaveLength(1);
});
it('deduplicates byte-identical independent media in the vault',async()=>{
    const original=mocks.download.getMockImplementation()!;
    mocks.download.mockImplementation(async(_url,...args:any[])=>original('https://files.zsxq.com/same.mp3',...args));
    const result=await collectZsxqResources(source(),context,'video',settings,store,signal(),()=>{},deps);
    expect(result.assets).toHaveLength(1);expect(store.media).toHaveBeenCalledTimes(1);expect(result.body).toContain('媒体 1');expect(result.body).toContain('媒体 2');
});
