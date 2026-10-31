// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { authenticatedPage, standardComments } from './authenticated-page';
import type { RenderedSnapshot } from './rendered-sites';
const snapshot=(html:string,extra:Partial<RenderedSnapshot>={}):RenderedSnapshot=>({url:'https://example.com/article',html,videos:[],...extra});
const page='<title>页面标题</title><meta name="author" content="作者"><main><h1>页面标题</h1><p>登录后才能阅读的正文。</p><img src="/photo.jpg"></main>';
describe('authenticated page extraction',()=>{
    it('extracts title, author and relative images without inventing site statistics',()=>{
        const result=authenticatedPage(snapshot(page),'https://example.com/article');
        expect(result.content).toMatchObject({title:'页面标题',author:'作者'});
        expect(result.content.markdown).toContain('登录后才能阅读的正文');
        expect(result.content.markdown).toContain('https://example.com/photo.jpg');
        expect(result.content.metrics).toBeUndefined();expect(result.media).toBeUndefined();expect(result.detectedMedia).toBeUndefined();
    });
    it('keeps short image-only content',()=>{
        expect(authenticatedPage(snapshot('<title>图片</title><main><img src="/one.jpg"></main>'),'https://example.com/article').content.markdown).toContain('https://example.com/one.jpg');
    });
    it.each(['audio','video'] as const)('detects %s with a directly downloadable source',kind=>{
        const result=authenticatedPage(snapshot(page,{[kind==='video'?'videos':'audios']:[{src:'https://cdn.example.com/media.mp4',visible:true,playing:false,area:100,identities:[]}]}),'https://example.com/article');
        expect(result.detectedMedia).toBe(kind);expect(result.media?.url).toBe('https://cdn.example.com/media.mp4');
    });
    it('detects MSE video but never treats blob URLs as downloadable files',()=>{
        const result=authenticatedPage(snapshot(page,{videos:[{src:'blob:https://example.com/id',visible:true,playing:true,area:100,identities:[]}]}),'https://example.com/article');
        expect(result.detectedMedia).toBe('video');expect(result.media).toBeUndefined();
    });
    it('detects a lazy audio source and an embedded video player',()=>{
        const audio=authenticatedPage(snapshot(page+'<audio preload="none"><source src="/track.mp3"></audio>'),'https://example.com/article');
        expect(audio.detectedMedia).toBe('audio');expect(audio.media?.url).toBe('https://example.com/track.mp3');
        const embedded=authenticatedPage(snapshot(page+'<iframe src="https://www.youtube.com/embed/test"></iframe>'),'https://example.com/article');
        expect(embedded.detectedMedia).toBe('video');expect(embedded.media).toBeUndefined();
    });
    it('keeps source JSON-LD counters for generic authenticated sites',()=>{
        const json=JSON.stringify({
            '@context':'https://schema.org','@type':'Article','@id':'https://example.com/article',
            url:'https://example.com/article',headline:'页面标题',interactionStatistic:[
                {'@type':'InteractionCounter',interactionType:{'@type':'LikeAction'},userInteractionCount:12},
                {'@type':'InteractionCounter',interactionType:{'@type':'CommentAction'},userInteractionCount:3},
            ],
        });
        const result=authenticatedPage(snapshot(`<title>页面标题</title><script type="application/ld+json">${json}</script><main><h1>页面标题</h1><p>正文</p></main>`),'https://example.com/article');
        expect(result.content.metrics).toMatchObject({likes:12,comments:3});
    });
    it.each([
        '<title>标题</title><main><h1>标题</h1></main>',
        '<title>登录</title><body>登录后查看</body>',
        '<title>登录</title><main><button>Sign in</button></main>',
    ])('rejects title-only or login pages',html=>{
        expect(()=>authenticatedPage(snapshot(html),'https://example.com/article')).toThrow();
    });
    it.each([
        ['csdn','https://blog.csdn.net/a/article/details/1','<div id="content_views">CSDN正文</div>'],
        ['zhihu','https://zhuanlan.zhihu.com/p/1','<div class="Post-RichTextContainer">知乎正文</div>'],
        ['douban','https://www.douban.com/note/1','<div class="note">豆瓣正文</div>'],
        ['wechat','https://mp.weixin.qq.com/s/a','<div id="js_content">公众号正文</div>'],
        ['weibo','https://weibo.com/1/a','<div node-type="feed_list_content">微博正文</div>'],
        ['twitter','https://x.com/u/status/1','<div data-testid="tweetText">推文正文</div>'],
        ['youtube','https://www.youtube.com/watch?v=a','<div id="description">YouTube正文</div>'],
        ['kuaishou','https://www.kuaishou.com/short-video/1','<div class="video-info">快手正文</div>'],
        ['toutiao','https://www.toutiao.com/article/1','<div class="article-content">头条正文</div>'],
        ['lizhi','https://www.lizhi.fm/123/456/','<article>荔枝正文</article>'],
        ['applepodcasts','https://podcasts.apple.com/us/podcast/test/id123?i=456','<main>苹果播客正文</main>'],
    ])('normalizes %s article bodies',(_platform,url,html)=>{
        const result=authenticatedPage(snapshot('<title>定制来源</title>'+html,{url}),url);
        expect(result.content.source_title).toBe('定制来源');expect(result.content.markdown).toContain('正文');
    });
    it('extracts a WeChat video-channel feed response with its playable media and cover',()=>{
        const url='https://channels.weixin.qq.com/finder-preview/pages/sph?id=AEnuRCNZHg';
        const mediaUrl='https://finder.video.qq.com/251/20302/stodownload?token=synthetic';
        const state={data:{authorInfo:{nickname:'爆笑西红柿哇'},feedInfo:{description:'勇气是人类的赞歌',createtime:1790843641,coverUrl:'https://finder.video.qq.com/cover.jpg',h264VideoInfo:{videoUrl:mediaUrl}}}};
        const result=authenticatedPage(snapshot(`<title>视频号</title><script type="application/json" data-clip2md-live-state="wechat-finder">${JSON.stringify(state)}</script>`,{url}),url);
        expect(result).toMatchObject({detectedMedia:'video',media:{url:mediaUrl},content:{author:'爆笑西红柿哇',source:'微信视频号'}});
        expect(result.content.markdown).toContain('https://finder.video.qq.com/cover.jpg');
    });
    it('extracts a video channel after its short share URL redirects to Channels',()=>{
        const requested='https://weixin.qq.com/sph/A8AXye2a21';
        const url='https://channels.weixin.qq.com/finder-preview/pages/sph?id=A8AXye2a21';
        const mediaUrl='https://finder.video.qq.com/251/20302/stodownload?token=synthetic';
        const state={data:{authorInfo:{nickname:'视频号作者'},feedInfo:{description:'视频号说明',h264VideoInfo:{videoUrl:mediaUrl}}}};
        const result=authenticatedPage(snapshot(`<title>视频号</title><script type="application/json" data-clip2md-live-state="wechat-finder">${JSON.stringify(state)}</script>`,{url}),requested);
        expect(result).toMatchObject({detectedMedia:'video',media:{url:mediaUrl},content:{source:'微信视频号'}});
    });
    it('retains every lazy WeChat article image for the local gallery job',()=>{
        const url='https://mp.weixin.qq.com/s/gallery';
        const result=authenticatedPage(snapshot('<title>图集文章</title><div id="js_content"><p>说明</p><img data-src="https://mmbiz.qpic.cn/a.jpg"><img data-src="https://mmbiz.qpic.cn/b.jpg"></div>',{url}),url);
        expect(result.content.image_urls).toEqual(['https://mmbiz.qpic.cn/a.jpg','https://mmbiz.qpic.cn/b.jpg']);
        expect(result.content.markdown).toContain('https://mmbiz.qpic.cn/b.jpg');
    });
    it('reads a clean Zhihu author name from answer chrome and preserves the rich body',()=>{
        const url='https://www.zhihu.com/question/1/answer/2';
        const result=authenticatedPage(snapshot(
            '<title>问题 - 作者 的回答</title><div class="AuthorInfo-name">知乎作者</div><div class="RichContent-inner"><div class="RichText"><p>知乎正文</p><img src="https://pic1.zhimg.com/a.jpg"></div></div>',
            {url},
        ),url);
        expect(result.content.author).toBe('知乎作者');
        expect(result.content.markdown).toContain('知乎正文');
        expect(result.content.markdown).toContain('https://pic1.zhimg.com/a.jpg');
    });
    it('reads Zhihu answer schema metadata when author chrome is rendered outside the usual selector',()=>{
        const url='https://www.zhihu.com/question/1/answer/1956385824699552759';
        const zop=JSON.stringify({authorName:'佛系一点',itemId:'1956385824699552759',type:'answer'}).replace(/"/g,'&quot;');
        const result=authenticatedPage(snapshot(
            `<title>问题 - 知乎</title><div class="AnswerItem" name="1956385824699552759" data-zop="${zop}" itemtype="http://schema.org/Answer"><meta itemprop="name" content="佛系一点"><meta itemprop="dateCreated" content="2025-09-30T07:52:08.000Z"><meta itemprop="upvoteCount" content="272"><meta itemprop="commentCount" content="119"><div class="RichContent-inner"><div class="RichText"><p>知乎正文</p></div></div></div>`,
            {url},
        ),url);
        expect(result.content).toMatchObject({author:'佛系一点',source_date:'2025-09-30'});
        expect(result.content.metrics).toMatchObject({likes:272,comments:119});
    });
    it.each([
        ['lizhi', 'https://www.lizhi.fm/123/456/', '荔枝节目'],
        ['applepodcasts', 'https://podcasts.apple.com/us/podcast/test/id123?i=456', '苹果播客节目'],
    ])('keeps podcast article and audio extraction for %s', (_platform, url, title) => {
        const result = authenticatedPage(
            snapshot(`<title>${title}</title><main><h1>${title}</h1><p>节目简介</p><audio src="https://cdn.example.com/episode.m4a"></audio>`, { url }),
            url,
        );
        expect(result.content.source_title).toBe(title);
        expect(result.detectedMedia).toBe('audio');
        expect(result.media?.url).toBe('https://cdn.example.com/episode.m4a');
    });
    it('normalizes source-identified comments and ignores unverified text',()=>{
        const result=standardComments(snapshot('<div class="comment-list-box"><div class="comment-list-item" data-id="42"><span class="username">读者</span><p class="comment-content">评论内容</p></div><div class="comment-list-item"><p>匿名无标识文本</p></div></div>'),'csdn',100);
        expect(result).toEqual([{id:'42',author:'读者',text:'评论内容'}]);
    });
    it('reads the lazy CSDN side-panel comment row shape',()=>{
        const result=standardComments(snapshot('<div class="comment-list-box"><div class="comment-list-item"><div class="comment-like" data-commentid="40290235"></div><a class="name-href"><span class="name">一个老程序袁</span></a><span class="date" title="2026-10-22 17:00:33">2026.10.22</span><div class="new-comment">在没开发这个测温工具之前就没发现在电脑卡顿么？</div></div></div>'),'csdn',100);
        expect(result).toEqual([{id:'40290235',author:'一个老程序袁',text:'在没开发这个测温工具之前就没发现在电脑卡顿么？',publishedAt:'2026-10-22 17:00:33'}]);
    });
    it('treats a missing comment component as a normal empty result',()=>{
        expect(standardComments(snapshot(page),'weibo',100)).toEqual([]);
        expect(()=>standardComments(snapshot(page),'web',100)).toThrow('没有定制');
    });
    it('treats a mounted empty comment list as a verified zero-comment result',()=>{
        expect(standardComments(snapshot('<div class="comment-list-box"></div>'),'weibo',100)).toEqual([]);
    });
    it('rejects mounted comment rows without a stable source identity',()=>{
        expect(()=>standardComments(snapshot('<div class="comment-list-box"><div data-comment-id="42"><p>文字</p></div></div>'),'weibo',100)).toThrow('没有可核验');
    });
});
