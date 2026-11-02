import { describe, expect, it } from 'vitest';
import { ArticleAccessRequired, ArticleBodyUnavailable } from './extract';
import { ZsxqArticleRequired, ZsxqPermissionDenied, parseZsxqResponse, zsxqArticleId, zsxqComments, zsxqPage, zsxqText, zsxqTopicEndpoint, zsxqTopicId } from './zsxq';
import type { RenderedSnapshot } from './rendered-sites';

const topicId='82811421582485540',groupId='51121244585524';
const url=`https://wx.zsxq.com/group/${groupId}/topic/${topicId}`;
const data=(extra:Record<string,unknown>={})=>({topic_id:topicId,type:'talk',title:'目标主题标题',create_time:'2026-11-01T08:12:00.000+0800',group:{group_id:groupId},talk:{owner:{user_id:'123456789123456789',name:'原作者'},text:'这是我自己编写的主题正文。\n第二段包括链接 <e type="web" href="https%3A%2F%2Fexample.com%2Farticle" title="%E5%8F%82%E8%80%83%E6%96%87%E7%AB%A0" />',images:[{original:{url:'https://images.zsxq.com/original.jpg'},large:{url:'https://images.zsxq.com/large.jpg'}}]},likes_count:0,comments_count:1,readers_count:20,show_comments:[{comment_id:'99988877766655544',owner:{name:'评论作者'},text:'这是原站返回的评论',create_time:'2026-11-01T08:20:00+0800'}],...extra});
const snapshot=(row=data(),extra:Partial<RenderedSnapshot>={}):RenderedSnapshot=>({url,html:'<title>知识星球</title><main>目标主题</main>',videos:[],zsxqTopics:[{topicId,status:200,payload:{succeeded:true,resp_data:{topic:row}}}],...extra});

describe('Knowledge Planet identities and source extraction',()=>{
    it.each([
        url,
        `https://wx.zsxq.com/dweb2/index/topic_detail/${topicId}`,
        `https://wx.zsxq.com/mweb/views/topicdetail/topicdetail.html?topic_id=${topicId}&group_id=${groupId}`,
    ])('recognizes a concrete topic: %s',value=>expect(zsxqTopicId(value)).toBe(topicId));
    it('does not confuse a group, short link or lookalike host with a known topic',()=>{
        for(const value of [`https://wx.zsxq.com/group/${groupId}`,'https://t.zsxq.com/example',url.replace('zsxq.com','zsxq.com.evil.example')])expect(zsxqTopicId(value)).toBeUndefined();
        expect(zsxqArticleId('https://articles.zsxq.com/id_r86jg5rh1r17.html')).toBe('r86jg5rh1r17');
        expect(zsxqTopicEndpoint(`https://api.zsxq.com/v2/topics/${topicId}/info`)).toBe(topicId);
        expect(zsxqTopicEndpoint(`https://api.zsxq.com.evil.example/v2/topics/${topicId}/info`)).toBeUndefined();
        expect(zsxqTopicEndpoint(`https://api.zsxq.com/v2/groups/${groupId}/topics`)).toBeUndefined();
    });
    it('keeps 17-digit IDs lossless before JSON parsing',()=>{
        const parsed=parseZsxqResponse(`{"resp_data":{"topic":{"topic_id":${topicId},"group_id":${groupId},"likes_count":123}}}`) as {resp_data:{topic:{topic_id:string;likes_count:number}}};
        expect(parsed.resp_data.topic.topic_id).toBe(topicId);expect(parsed.resp_data.topic.likes_count).toBe(123);
        expect(()=>parseZsxqResponse(' '.repeat(2*1024*1024+1))).toThrow('上限');
    });
    it('uses only the selected topic body, original images, author/date and verified counters',()=>{
        const result=zsxqPage(snapshot(),url);
        expect(result.content).toMatchObject({title:'目标主题标题',author:'原作者',source_date:'2026-11-01',source:'知识星球',metrics:{likes:0,comments:1,views:20},image_urls:['https://images.zsxq.com/original.jpg']});
        expect(result.content.markdown).toContain('这是我自己编写的主题正文。  \n第二段');
        expect(result.content.markdown).toContain('[参考文章](https://example.com/article)');expect(result.content.markdown).not.toContain('large.jpg');
        expect(result.media).toBeUndefined();
    });
    it('does not treat unrelated feed data, forged page state, group pages or a rounded ID as the requested topic',()=>{
        expect(()=>zsxqPage(snapshot(data({topic_id:'82811421582485541'})),url)).toThrow('身份不一致');
        expect(()=>zsxqPage(snapshot(data({topic_id:Number(topicId)})),url)).toThrow('身份不一致');
        expect(()=>zsxqPage(snapshot(data(),{url:`https://wx.zsxq.com/group/${groupId}`}),url)).toThrow('未进入目标主题');
        expect(()=>zsxqPage(snapshot(data(),{zsxqTopics:[],html:`<article data-topic-id="${topicId}">伪造正文</article>`}),url)).toThrow('未返回目标主题');
        expect(()=>zsxqPage(snapshot(data(),{url:`https://wx.zsxq.com/group/${groupId}`}),`https://wx.zsxq.com/group/${groupId}`)).toThrow('具体主题');
    });
    it.each([401,403,404])('distinguishes HTTP %s from usable content',status=>{
        const state=snapshot(data(),{zsxqTopics:[{topicId,status,payload:{succeeded:false,code:status}}]});
        expect(()=>zsxqPage(state,url)).toThrow(status===401?ArticleAccessRequired:status===403?ZsxqPermissionDenied:ArticleBodyUnavailable);
    });
    it('rejects previews and access masks without inventing a full post',()=>{
        expect(()=>zsxqPage(snapshot(data({is_preview:true})),url)).toThrow(ZsxqPermissionDenied);
        expect(()=>zsxqPage(snapshot(data(),{html:'<div role="alert">加入星球后即可阅读完整内容</div>'}),url)).toThrow(ZsxqPermissionDenied);
        expect(()=>zsxqPage(snapshot(data(),{html:'<title>登录</title><form><input type="password"></form>'}),url)).toThrow(ArticleAccessRequired);
        expect(()=>zsxqPage(snapshot(data(),{zsxqTopics:[{topicId,status:200,detail:false,payload:{succeeded:true,resp_data:{type:'preview',preview:{text:'付费预览摘要'}}}}]}),url)).toThrow(ZsxqPermissionDenied);
    });
    it('keeps question and answer bodies in source order',()=>{
        const result=zsxqPage(snapshot(data({type:'q&a',question:{owner:{name:'提问者'},text:'这是原始问题'},answer:{owner:{name:'回答者'},text:'这是原始回答'},talk:undefined})),url);
        expect(result.content.markdown).toBe('## 问题\n\n这是原始问题\n\n## 回答\n\n这是原始回答');
        expect(result.content.author).toBe('提问者');
    });
    it('follows a verified long-article URL instead of saving its summary',()=>{
        const state=snapshot(data({talk:{owner:{name:'作者'},text:'摘要不得作为正文',article:{title:'长文章标题',article_id:'sample',article_url:'https://articles.zsxq.com/id_sample.html'}}}));
        let error:unknown;try{zsxqPage(state,url);}catch(caught){error=caught;}
        expect(error).toBeInstanceOf(ZsxqArticleRequired);expect((error as ZsxqArticleRequired).articleUrl).toBe('https://articles.zsxq.com/id_sample.html');
        expect(()=>zsxqPage(snapshot(data({talk:{text:'摘要',article:{article_id:'sample',article_url:'https://evil.example/article'}}})),url)).toThrow('可核验原文');
    });
    it('extracts a concrete long article and keeps the topic author/date',()=>{
        const article='https://articles.zsxq.com/id_sample.html';
        const result=zsxqPage(snapshot(data(),{url:article,html:`<title>长文章标题</title><article><p>${'完整长文章正文内容。'.repeat(20)}</p><img src="/photo.jpg"></article>`}),article,{title:'摘要标题',markdown:'摘要',author:'主题作者',source_date:'2026-10-31'});
        expect(result.content).toMatchObject({title:'长文章标题',author:'主题作者',source_date:'2026-10-31'});expect(result.content.markdown).not.toContain('摘要');
        expect(()=>zsxqPage(snapshot(data(),{url:article.replace('sample','other')}),article)).toThrow('跳转');
    });
    it('turns encoded tags and mentions into text and refuses executable links',()=>{
        const markdown=zsxqText('<e type="hashtag" title="%23%E6%A0%87%E7%AD%BE%23" /><e type="mention" title="%40%E4%BD%9C%E8%80%85" /><e type="text_bold" title="%E6%A0%87%E9%A2%98" /><e type="web" href="javascript%3Aalert(1)" title="%E6%81%B6%E6%84%8F%E9%93%BE%E6%8E%A5" />',url);
        expect(markdown).toContain('#标签#');expect(markdown).toContain('@作者');expect(markdown).toContain('**标题**');expect(markdown).not.toContain('javascript');
    });
    it('returns only stable comments from the target topic response and respects the configured limit',()=>{
        expect(zsxqComments(snapshot(),url,1)).toMatchObject([{id:'99988877766655544',author:'评论作者',text:'这是原站返回的评论'}]);
        expect(zsxqComments(snapshot(data({comments_count:0,show_comments:undefined})),url,10)).toEqual([]);
        expect(()=>zsxqComments(snapshot(data({show_comments:undefined})),url,10)).toThrow('评论样本');
    });
});
