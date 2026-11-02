import { parse } from 'acorn';
import { describe, expect, it, vi } from 'vitest';
import { zsxqPage, ZsxqArticleRequired } from './zsxq';
import { zsxqRead } from './zsxq-browser';
import { attachmentExtension } from './media-download';
import type { RenderedSnapshot } from './rendered-sites';
const topicId='82811421582485540',url=`https://wx.zsxq.com/topic/${topicId}`;
function snapshot(block:string='talk',data:Record<string,unknown>={}):RenderedSnapshot {
    return {url,html:'<main>主题</main>',videos:[],zsxqTopics:[{topicId,status:200,payload:{succeeded:true,resp_data:{type:'all',topic:{topic_id:topicId,type:block,[block]:data}}}}]};
}
describe('topic resource contracts (authored, not live-account fixtures)',()=>{
    it.each(['talk','question','answer','task','solution'])('accepts a file-only %s without fabricating prose',block=>{
        const result=zsxqPage(snapshot(block,{files:[{file_id:'12345678912345678',name:'资料.pdf',size:100}]}),url);
        expect(result.files).toEqual([{id:'12345678912345678',topicId,name:'资料.pdf',bytes:100}]);
        expect(result.content.markdown).toBe('');
    });
    it('separates ordinary files, audio and video attachments and deduplicates source IDs',()=>{
        const state=snapshot('task',{files:[{file_id:'1',name:'资料.pdf'},{file_id:'2',name:'第一段.mp3'},{file_id:'3',name:'第二段.mp4'},{file_id:'2',name:'第一段.mp3'}]});
        state.zsxqFiles=[{id:'2',url:'https://files.zsxq.com/first.mp3'}];
        const result=zsxqPage(state,url);
        expect(result.files?.map(row=>row.id)).toEqual(['1']);
        expect(result.mediaItems?.map(row=>[row.id,row.kind,row.url])).toEqual([['file-2','audio','https://files.zsxq.com/first.mp3'],['file-3','video','']]);
        expect(result.media).toBeUndefined();
    });
    it('retains resources with long articles and rejects preview before reading files',()=>{
        const data={files:[{file_id:'2',name:'声音.mp3'}],article:{article_id:'long',article_url:'https://articles.zsxq.com/id_long.html'}};
        try {zsxqPage(snapshot('talk',data),url);throw new Error('expected article');}catch(error){expect(error).toBeInstanceOf(ZsxqArticleRequired);expect((error as ZsxqArticleRequired).related.mediaItems?.[0].fileId).toBe('2');}
        const state=snapshot('talk',data);(state.zsxqTopics![0].payload as any).resp_data.type='preview';
        expect(()=>zsxqPage(state,url)).toThrow('阅读权限');
    });
    it('binds captured video URLs to original IDs and merges only matching player tracks',()=>{
        const state=snapshot('solution',{video:{video_id:'9',duration:60}});
        state.zsxqVideoUrls=[{id:'9',url:'https://video.zsxq.com/9/master.m3u8'},{id:'8',url:'https://video.zsxq.com/other'}];
        state.zsxqPlayers=[{topicId,id:'video-9',title:'播放器',kind:'video',url:'https://video.zsxq.com/9/master.m3u8',referer:url,subtitles:[{url:'https://video.zsxq.com/9.vtt'}]}];
        const result=zsxqPage(state,url);
        expect(result.mediaItems).toHaveLength(1);expect(result.mediaItems![0]).toMatchObject({id:'video-9',expectedDurationSeconds:60,subtitles:[{url:'https://video.zsxq.com/9.vtt'}]});
    });
    it.each(['<!DOCTYPE html><html>登录</html>','<html>login</html>','<?xml version="1.0"?><Error>Expired</Error>','{"succeeded":false}'])('rejects disguised error bodies: %s',raw=>expect(()=>attachmentExtension(Buffer.from(raw),'资料.pdf')).toThrow('错误响应'));
    it('retains a safe original extension and accepts binary documents',()=>expect(attachmentExtension(Buffer.from('%PDF-1.7'),'资料.PDF')).toBe('pdf'));
});
describe('same-session bounded read-only requests',()=>{
    it('requests only validated attachment IDs and leaves errors as missing resources',async()=>{
        const state=snapshot('talk',{files:[{file_id:'2',name:'资料.pdf'},{file_id:'../bad',name:'bad'}]});
        const executeJavaScript=vi.fn(async(script:string)=>{expect(()=>parse(script,{ecmaVersion:'latest'})).not.toThrow();expect(script).toContain('https://api.zsxq.com/v2/files/2/download_url');expect(script).toContain("credentials:'include'");return {status:200,body:JSON.stringify({succeeded:true,resp_data:{download_url:'https://files.zsxq.com/signed.pdf'}})};});
        await zsxqRead({executeJavaScript},state,url,new AbortController().signal,{files:true});
        expect(executeJavaScript).toHaveBeenCalledTimes(1);expect(state.zsxqFiles).toEqual([{id:'2',url:'https://files.zsxq.com/signed.pdf'}]);
    });
    it('paginates, deduplicates sticky comments and stops a nonadvancing cursor',async()=>{
        const state=snapshot('talk',{text:'正文'});
        let index=0;
        const comment=(id:string)=>({comment_id:id,owner:{name:'作者'},text:id,create_time:'2026-11-01T12:00:00+0800'});
        const executeJavaScript=vi.fn(async(script:string)=>{
            if(index++)expect(script).toContain('begin_time=2026-11-01T12%3A00%3A00%2B0800');
            return {status:200,body:JSON.stringify({succeeded:true,resp_data:{sticky_comments:[comment('1')],comments:[comment('1'),comment(String(index+1))]}})};
        });
        await zsxqRead({executeJavaScript},state,url,new AbortController().signal,{commentLimit:100});
        expect(executeJavaScript).toHaveBeenCalledTimes(2);expect(state.zsxqCommentCoverage).toContain('未推进');
    });
    it('stops at configured comment limit and never requests another topic',async()=>{
        const state=snapshot();
        const executeJavaScript=vi.fn(async(script:string)=>{expect(script).toContain(`/topics/${topicId}/comments?`);return {status:200,body:JSON.stringify({succeeded:true,resp_data:{comments:[{comment_id:'1',owner:{name:'作者'},text:'评论',create_time:'time'}]}})};});
        await zsxqRead({executeJavaScript},state,url,new AbortController().signal,{commentLimit:1});
        expect(executeJavaScript).toHaveBeenCalledTimes(1);expect(state.zsxqCommentCoverage).toContain('上限 1');
    });
});

it('emits syntactically valid player loading code and excludes comment players',async()=>{
    const state=snapshot('talk',{text:'正文'});
    const executeJavaScript=vi.fn(async(script:string)=>{expect(()=>parse(script,{ecmaVersion:'latest'})).not.toThrow();expect(script).toContain('app-comment');expect(script).toContain('player.muted=true');return [];});
    await zsxqRead({executeJavaScript},state,url,new AbortController().signal,{players:true});
    expect(state.zsxqPlayers).toEqual([]);
});
