// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const mocks=vi.hoisted(()=>({page:vi.fn(),publicSource:vi.fn(),image:vi.fn(),media:vi.fn(),discover:vi.fn(),runTool:vi.fn(),checkTool:vi.fn(),ytDlpMedia:vi.fn()}));
vi.mock('./page-source',()=>({sourcePage:mocks.page}));
vi.mock('./adapters/site-link',()=>({resolveSiteLink:mocks.publicSource}));
vi.mock('./adapters/network',()=>({readPublicImage:mocks.image,readPublicJson:vi.fn(),sourceRequestHeaders:vi.fn(async()=>({'User-Agent':'test'}))}));
vi.mock('./adapters/media-download',()=>({downloadPublicMedia:mocks.media,MediaCandidateUnavailable:class MediaCandidateUnavailable extends Error {}}));
vi.mock('./tools',()=>({discoverVideo:mocks.discover,checkTool:mocks.checkTool,runTool:mocks.runTool,downloadMediaWithYtDlp:mocks.ytDlpMedia,downloadYouTubeMedia:vi.fn()}));
vi.mock('./adapters/resolver-proxy',()=>({createResolverProxy:vi.fn(async()=>({url:'http://127.0.0.1:1',counts:()=>({connections:0,accepted:0,denied:0,bytes:0}),close:vi.fn(async()=>{})}))}));
import { collect, resolveSource, saveArticle, isHlsMediaUrl, uniqueMediaCandidates } from './collector';
import { normalizeSettings } from './config';
import type { TaskContext } from './companion-protocol';
import type { MaterialStore } from './storage';
const context:TaskContext={taskId:42,bindingScope:'a'.repeat(64),sourceUrl:'https://example.com/private',contentVersion:'1',notePath:'收藏/文章.md',daily:false};
let temporary='';
beforeEach(async()=>{
    vi.clearAllMocks();mocks.publicSource.mockReset();mocks.discover.mockReset();mocks.media.mockReset();mocks.runTool.mockReset();mocks.ytDlpMedia.mockReset();temporary=await fs.mkdtemp(path.join(os.tmpdir(),'clip2md-page-test-'));
    mocks.publicSource.mockResolvedValue({content:{title:'来源',markdown:''}});
    mocks.page.mockResolvedValue({url:context.sourceUrl,html:'<title>私有正文</title><main><p>这是登录后显示的正文内容。</p></main>',videos:[]});
});
afterEach(async()=>{await fs.rm(temporary,{recursive:true,force:true});});
function store(){return {text:vi.fn(async()=> '资料/正文.md'),cache:vi.fn(async()=>temporary),media:vi.fn(async()=> '资料/图片.png')} as unknown as MaterialStore;}
describe('local authenticated capture',()=>{
    it('keeps a valid decrypt key when duplicate media URLs are returned',()=>{
        expect(uniqueMediaCandidates(
            ['https://cdn.example/media', 'https://cdn.example/media', 'https://cdn.example/other'],
            [undefined, 'correct-key', 'other-key'],
        )).toEqual([
            ['https://cdn.example/media', 'correct-key'],
            ['https://cdn.example/other', 'other-key'],
        ]);
    });
    it('recognizes only HTTPS HLS playlists for FFmpeg assembly',()=>{
        expect(isHlsMediaUrl('https://video.twimg.com/ext_tw_video/1/pl/playlist.m3u8')).toBe(true);
        expect(isHlsMediaUrl('https://video.twimg.com/ext_tw_video/1/pu/playlist#clip2md-hls')).toBe(true);
        expect(isHlsMediaUrl('https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/segment.ts')).toBe(false);
        expect(isHlsMediaUrl('http://video.twimg.com/playlist.m3u8')).toBe(false);
    });
    it('uses the local signed-in page for generic sites instead of the anonymous resolver',async()=>{
        const result=await resolveSource(context,{} as never,new AbortController().signal);
        expect(mocks.page).toHaveBeenCalled();expect(mocks.publicSource).not.toHaveBeenCalled();expect(result.content.markdown).toContain('登录后显示');
    });
    it('falls back to article content without invoking video tools if no media is detected',async()=>{
        const result=await collect(context,'video',normalizeSettings({}),{} as never,store(),new AbortController().signal,()=>{});
        expect(result.body).toContain('未探测到可下载音视频');expect(result.body).toContain('登录后显示');expect(mocks.discover).not.toHaveBeenCalled();
    });
    it('treats a generic image post with a hidden video element as article-only',async()=>{
        mocks.page.mockResolvedValue({url:context.sourceUrl,html:'<title>微博图文</title><main><article><p>这是可见的微博正文</p><img src="https://wx1.sinaimg.cn/large/example.jpg"></article><video></video></main>',videos:[]});
        const material=store();
        const result=await collect(context,'video',normalizeSettings({}),{} as never,material,new AbortController().signal,()=>{});
        expect(result.body).toContain('未探测到可下载音视频');
        expect(result.body).toContain('这是可见的微博正文');
        expect(mocks.discover).not.toHaveBeenCalled();
        expect(mocks.ytDlpMedia).not.toHaveBeenCalled();
    });
    it('skips video and comments for Bilibili Opus articles instead of invoking video tools',async()=>{
        const opus={...context,sourceUrl:'https://www.bilibili.com/opus/1261621092485693461/'};
        await expect(collect(opus,'video',normalizeSettings({}),{} as never,store(),new AbortController().signal,()=>{})).resolves.toMatchObject({body:expect.stringContaining('Opus')});
        await expect(collect(opus,'comments',normalizeSettings({}),{} as never,store(),new AbortController().signal,()=>{})).resolves.toMatchObject({body:expect.stringContaining('评论')});
        expect(mocks.discover).not.toHaveBeenCalled();
    });
    it('treats an empty Xiaoyuzhou comments page as a normal zero-comment result',async()=>{
        const podcast={...context,sourceUrl:'https://www.xiaoyuzhoufm.com/episode/6a1f82727444b57222326f0a'};
        const material=store();
        await expect(collect(podcast,'comments',normalizeSettings({}),{} as never,material,new AbortController().signal,()=>{})).resolves.toMatchObject({body:expect.stringContaining('本地评论')});
        expect(material.text).toHaveBeenCalledWith(podcast,'comments',expect.stringContaining('采集数量：0'));
    });
    it('skips Zhihu comments when the authenticated page exposes no verifiable comment response',async()=>{
        const zhihu={...context,sourceUrl:'https://www.zhihu.com/pin/2054592374081377005?page=video_pin'};
        await expect(collect(zhihu,'comments',normalizeSettings({}),{} as never,store(),new AbortController().signal,()=>{})).resolves.toMatchObject({body:expect.stringContaining('正常跳过评论采集')});
    });
    it('does not extract a video cover from a local audio asset that uses an mp4 extension',async()=>{
        const podcast={...context,sourceUrl:'https://www.xiaoyuzhoufm.com/episode/6a1f82727444b57222326f0a'};
        mocks.publicSource.mockResolvedValue({content:{title:'小宇宙音频',markdown:'音频说明'}});
        const result=await collect(
            podcast,
            'images',
            normalizeSettings({platforms:{web:{images:true}}}),
            {} as never,
            store(),
            new AbortController().signal,
            ()=>{},
            ['aaa/_local/16135/16135-audio-4e3b721f6045cbfe.mp4'],
        );
        expect(result.body).toContain('原站未提供可下载图片');
        expect(mocks.checkTool).not.toHaveBeenCalled();
        expect(mocks.runTool).not.toHaveBeenCalled();
    });
    it('skips video for a Xiaohongshu gallery without treating it as an authorization failure',async()=>{
        const xhs={...context,sourceUrl:'https://xhslink.cn/o/AfVkFLznmO6'};
        mocks.publicSource.mockResolvedValue({content:{title:'小红书图集',markdown:'说明'}});
        await expect(collect(xhs,'video',normalizeSettings({}),{} as never,store(),new AbortController().signal,()=>{})).resolves.toMatchObject({body:expect.stringContaining('图集不含视频')});
        expect(mocks.discover).not.toHaveBeenCalled();
    });
    it('saves the detected audio directly as audio',async()=>{
        mocks.page.mockResolvedValue({url:context.sourceUrl,html:'<title>音频正文</title><main><p>音频说明正文</p></main>',videos:[],audios:[{src:'https://example.com/audio.mp3',visible:true,playing:false,area:0,identities:[]}]});
        mocks.media.mockResolvedValue({path:'/fixture/audio.mp3',extension:'mp3',bytes:100,sha256:'fixture'});
        const material=store();const result=await collect(context,'video',normalizeSettings({}),{} as never,material,new AbortController().signal,()=>{});
        expect(material.media).toHaveBeenCalledWith(context,'audio',expect.objectContaining({extension:'mp3'}),expect.any(AbortSignal));
        expect(result.assets).toHaveLength(1);expect(mocks.discover).not.toHaveBeenCalled();
    });
    it('saves selected article images and rewrites image links to local Vault paths',async()=>{
        const bytes=new Uint8Array([137,80,78,71,13,10,26,10]).buffer;
        mocks.image.mockResolvedValue({arrayBuffer:bytes,headers:{'content-type':'image/png'}});
        const material=store();
        const result=await saveArticle(context,{content:{title:'原文',markdown:'正文\n\n![原图](https://example.com/image.png)'}},normalizeSettings({platforms:{web:{images:true}}}),material,new AbortController().signal);
        expect(result.markdown).not.toContain('https://example.com/image.png');expect(result.markdown).toContain('/%E8%B5%84%E6%96%99/%E5%9B%BE%E7%89%87.png');expect(material.media).toHaveBeenCalled();
        expect(mocks.image).toHaveBeenCalledWith('https://example.com/image.png',expect.any(AbortSignal),context.sourceUrl);
        expect(material.text).toHaveBeenCalledWith(context,'article',expect.stringContaining('# 原文'));
    });
    it('keeps an article and its other images when one body image is blocked',async()=>{
        const bytes=new Uint8Array([137,80,78,71,13,10,26,10]).buffer;
        mocks.image.mockImplementation(async (url:string)=>url.includes('bad')
            ? Promise.reject(new Error('原站拒绝热链'))
            : {arrayBuffer:bytes,headers:{'content-type':'image/png'}});
        const material=store();
        const result=await saveArticle(context,{
            content:{title:'原文',markdown:'正文\n\n![好图](https://example.com/good.png)\n\n![坏图](https://example.com/bad.png)'},
        },normalizeSettings({platforms:{web:{images:true}}}),material,new AbortController().signal);
        expect(result.markdown).toContain('/%E8%B5%84%E6%96%99/%E5%9B%BE%E7%89%87.png');
        expect(result.markdown).toContain('https://example.com/bad.png');
        expect(result.markdown).toContain('1 张正文图片未能保存');
        expect(material.text).toHaveBeenCalledWith(context,'article',expect.stringContaining('正文'));
    });
    it('canonicalizes Douyin modal links before the local video resolver',async()=>{
        const douyin={...context,sourceUrl:'https://www.douyin.com/jingxuan?modal_id=7695240752057666854'};
        mocks.publicSource.mockResolvedValue({content:{title:'抖音视频',markdown:''}});
        mocks.discover.mockRejectedValue(new Error('resolver sentinel'));
        await expect(collect(douyin,'video',normalizeSettings({}),{targetFor:()=> 'douyin',authorizedCookies:vi.fn(async()=>[])} as never,store(),new AbortController().signal,()=>{})).rejects.toThrow('resolver sentinel');
        expect(mocks.discover).toHaveBeenCalledWith('https://www.douyin.com/video/7695240752057666854',expect.anything(),expect.anything(),expect.any(AbortSignal),expect.anything());
    });
    it('uses the authenticated Douyin detail media before browser and yt-dlp fallbacks',async()=>{
        const douyin={...context,sourceUrl:'https://www.douyin.com/jingxuan?modal_id=7695240752057666854'};
        mocks.publicSource.mockResolvedValue({content:{title:'抖音视频',markdown:''},media:{url:'https://v.douyinvod.com/video.mp4',alternatives:[]}});
        mocks.media.mockResolvedValue({path:'/fixture/video.mp4',extension:'mp4',bytes:100,sha256:'fixture'});
        const material=store();
        const result=await collect(douyin,'video',normalizeSettings({}),{targetFor:()=> 'douyin',authorizedCookies:vi.fn(async()=>[])} as never,material,new AbortController().signal,()=>{});
        expect(result.assets).toHaveLength(1);
        expect(mocks.publicSource).toHaveBeenCalledWith('https://www.douyin.com/video/7695240752057666854',expect.anything(),true);
        expect(mocks.discover).not.toHaveBeenCalled();
    });
    it('refreshes a Douyin page and retries media when the signed direct URL returns 403',async()=>{
        const douyin={...context,sourceUrl:'https://www.douyin.com/video/7698659081447329050'};
        mocks.publicSource
            .mockResolvedValueOnce({content:{title:'抖音视频',markdown:''},media:{url:'https://v.douyinvod.com/expired.mp4',alternatives:[]}})
            .mockResolvedValueOnce({content:{title:'抖音视频',markdown:''},media:{url:'https://v.douyinvod.com/fresh.mp4',alternatives:[]}});
        mocks.page.mockResolvedValue({url:douyin.sourceUrl,html:'<title>视频</title>',videos:[]});
        mocks.media
            .mockRejectedValueOnce(new Error('原站媒体返回 HTTP 403（video/mp4），未取得完整媒体'))
            .mockResolvedValueOnce({path:'/fixture/fresh.mp4',extension:'mp4',bytes:100,sha256:'fixture'});
        const material=store();
        const result=await collect(douyin,'video',normalizeSettings({}),{targetFor:()=> 'douyin',authorizedCookies:vi.fn(async()=>[])} as never,material,new AbortController().signal,()=>{});
        expect(result.assets).toHaveLength(1);
        expect(mocks.page).toHaveBeenCalledTimes(1);
        expect(mocks.media).toHaveBeenCalledTimes(2);
        expect(mocks.media.mock.calls[1][0]).toBe('https://v.douyinvod.com/fresh.mp4');
        expect(mocks.discover).not.toHaveBeenCalled();
    });
    it('uses yt-dlp after a refreshed Douyin media URL is also rejected',async()=>{
        const douyin={...context,sourceUrl:'https://www.douyin.com/video/7698659081447329050'};
        mocks.publicSource
            .mockResolvedValueOnce({content:{title:'抖音视频',markdown:''},media:{url:'https://v.douyinvod.com/expired.mp4',alternatives:[]}})
            .mockResolvedValueOnce({content:{title:'抖音视频',markdown:''},media:{url:'https://v.douyinvod.com/fresh.mp4',alternatives:[]}});
        mocks.page.mockResolvedValue({url:douyin.sourceUrl,html:'<title>视频</title>',videos:[]});
        mocks.media.mockRejectedValue(new Error('原站媒体返回 HTTP 403（video/mp4），未取得完整媒体'));
        const complete=path.join(temporary,'downloaded.mkv');
        await fs.writeFile(complete,'complete video');
        mocks.ytDlpMedia.mockResolvedValue(complete);
        const material=store();
        const result=await collect(douyin,'video',normalizeSettings({}),{targetFor:()=> 'douyin',authorizedCookies:vi.fn(async()=>[])} as never,material,new AbortController().signal,()=>{});
        expect(result.assets).toHaveLength(1);
        expect(mocks.ytDlpMedia).toHaveBeenCalledWith(
            'https://www.douyin.com/video/7698659081447329050',
            expect.anything(),
            expect.any(String),
            expect.any(AbortSignal),
            [],
            expect.objectContaining({url:expect.any(String)}),
        );
    });
    it('skips a Douyin gallery from a short link without resolving video media',async()=>{
        const douyin={...context,sourceUrl:'https://www.douyin.com/note/7698659081447329050'};
        await expect(collect(douyin,'video',normalizeSettings({}),{} as never,store(),new AbortController().signal,()=>{})).resolves.toMatchObject({body:expect.stringContaining('图文作品不含视频')});
        expect(mocks.publicSource).not.toHaveBeenCalled();
        expect(mocks.discover).not.toHaveBeenCalled();
        expect(mocks.ytDlpMedia).not.toHaveBeenCalled();
    });
    it('treats an image-only Douyin result as a gallery even if task metadata requested video',async()=>{
        const douyin={...context,sourceUrl:'https://www.douyin.com/video/7698659081447329050'};
        mocks.publicSource.mockResolvedValue({content:{title:'抖音图文',markdown:'',image_urls:['https://p.douyinpic.com/image.webp']}});
        await expect(collect(douyin,'video',normalizeSettings({}),{} as never,store(),new AbortController().signal,()=>{})).resolves.toMatchObject({body:expect.stringContaining('图文作品不含视频')});
        expect(mocks.discover).not.toHaveBeenCalled();
        expect(mocks.ytDlpMedia).not.toHaveBeenCalled();
    });
    it('recognizes a short-link Douyin gallery from completed image assets without invoking video tools',async()=>{
        const douyin={...context,sourceUrl:'https://v.douyin.com/F_BIRaeLwvQ/'};
        mocks.publicSource.mockResolvedValue({content:{title:'抖音图文',markdown:'正文',image_urls:['https://p.douyinpic.com/image.webp']}});
        await expect(collect(
            douyin,
            'video',
            normalizeSettings({}),
            {} as never,
            store(),
            new AbortController().signal,
            ()=>{},
            ['aa/_local/16137/16137-image-83d301c347b2019f.webp'],
        )).resolves.toMatchObject({body:expect.stringContaining('抖音图文作品不含视频')});
        expect(mocks.publicSource).not.toHaveBeenCalled();
        expect(mocks.discover).not.toHaveBeenCalled();
        expect(mocks.ytDlpMedia).not.toHaveBeenCalled();
    });
    it('downloads an authenticated X signed MP4 returned by yt-dlp',async()=>{
        const x={...context,sourceUrl:'https://x.com/OpenAIDevs/status/1790807033836707947'};
        const mediaUrl='https://video.twimg.com/tweet_video/example.mp4';
        mocks.page.mockResolvedValue({url:x.sourceUrl,html:'<title>X 视频</title><main><p>视频说明</p></main>',videos:[{src:mediaUrl,visible:true,playing:false,area:0,identities:[]}]});
        mocks.discover.mockResolvedValue({video:{url:mediaUrl,extension:'mp4'},audio:undefined});
        mocks.media.mockResolvedValue({path:'/fixture/video.mp4',extension:'mp4',bytes:100,sha256:'fixture'});
        mocks.runTool.mockResolvedValue('progress=end\nout_time_us=1000000');
        const material=store();
        const result=await collect(x,'video',normalizeSettings({ffmpeg:'/usr/bin/ffmpeg'}),{targetFor:()=> 'twitter',authorizedCookies:vi.fn(async()=>[])} as never,material,new AbortController().signal,()=>{});
        expect(material.media).toHaveBeenCalledWith(x,'video',expect.objectContaining({extension:'mp4'}),expect.any(AbortSignal));
        expect(result.assets).toHaveLength(1);
        expect(mocks.media).toHaveBeenCalledWith(mediaUrl,expect.any(AbortSignal),x.sourceUrl,expect.any(String),expect.any(Function),expect.any(Object));
    });
});
