/** Normalize a signed-in rendered page. Generic pages intentionally omit site metrics and comments. */
import { Readability } from '@mozilla/readability';
import { htmlToMarkdown } from './extract';
import { platformFor, type PlatformName } from '../config';
import type { RenderedSnapshot } from './rendered-sites';
import { siteAccessRequired, sourceMetrics, type SiteResult } from './sites';
import { readArticleMetrics } from './article-metrics';
import type { SourceComment } from '../comments';
import {
    wechatChannelsFeedError,
    wechatChannelsMediaCandidates,
} from './wechat-channels';

const articleSelectors: Partial<Record<PlatformName,string>> = {
    csdn:'#content_views', zhihu:'.RichContent-inner .RichText, .Post-RichTextContainer',
    douban:'.note, .review-content, #link-report', wechat:'#js_content',
    weibo:'[class*="detail_wbtext"], [node-type="feed_list_content"], [data-testid="post-content"]',
    twitter:'[data-testid="tweetText"]', toutiao:'article, .article-content',
    lizhi:'article, main, .audio-info, .program-info', applepodcasts:'article, main, [data-testid="episode-detail"]',
    youtube:'#description-inline-expander, #description', kuaishou:'.video-info, .photo-info',
};
const authorSelectors: Partial<Record<PlatformName,string>> = {
    zhihu: '.AuthorInfo-name, .AuthorInfo-head .UserLink-link, [itemprop="author"] [itemprop="name"]',
};
const commentSelectors: Partial<Record<PlatformName,string>> = {
    csdn:'.comment-list-box .comment-list-item', zhihu:'.CommentItemV2, [data-id].CommentItem',
    douban:'.comment-item, .reply-item', wechat:'.discuss_item',
    weibo:'[data-comment-id], [comment_id]', youtube:'ytd-comment-thread-renderer',
    twitter:'[data-testid="tweet"]', kuaishou:'.comment-item', toutiao:'.comment-item', xiaoyuzhou:'.comment-item',
};
function meta(document:Document,name:string):string {
    return document.querySelector(`meta[property="${name}"],meta[name="${name}"]`)?.getAttribute('content')?.trim()||'';
}
function address(value:string|undefined,base:string):string|undefined {
    if(!value)return;
    try{const url=new URL(value,base);if(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password)return url.href;}catch{/* Invalid source. */}
}
function cleanAuthor(value:string|undefined, platform:PlatformName):string|undefined {
    if (!value) return;
    let result=value.replace(/\u200b|\u200c|\u200d|\ufeff/g,'').replace(/\s+/g,' ').trim();
    if (platform==='zhihu') result=result.replace(/\s*(?:关注|已认证(?:机构号|答主)?|认证机构号)\s*$/,'').trim();
    return result.slice(0,200)||undefined;
}
function sourceDay(value:string|undefined):string|undefined {
    if (!value) return;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const timestamp=Date.parse(value);
    if (!Number.isFinite(timestamp)) return value;
    return new Date(timestamp).toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});
}
function zhihuAnswerRoot(document:Document, requested:string):HTMLElement|undefined {
    let answerId:string|undefined;
    try { answerId = new URL(requested).pathname.match(/\/answer\/([1-9]\d{0,19})(?:\/|$)/)?.[1]; } catch { /* Invalid source URL. */ }
    if (!answerId) return;
    const rows=Array.from(document.querySelectorAll<HTMLElement>('.AnswerItem,[itemtype="http://schema.org/Answer"]'));
    return rows.find(row=>row.getAttribute('name')===answerId || row.getAttribute('data-zop')?.includes(`"itemId":"${answerId}"`));
}
function zhihuAnswerMetadata(document:Document, requested:string):{author?:string;sourceDate?:string;metrics?:ReturnType<typeof sourceMetrics>} {
    const root=zhihuAnswerRoot(document,requested);
    if (!root) return {};
    const value=(prop:string)=>root.querySelector(`meta[itemprop="${prop}"]`)?.getAttribute('content')?.trim()||undefined;
    let author=value('name');
    if (!author) {
        try {
            const zop=JSON.parse(root.getAttribute('data-zop')||'');
            if (typeof zop?.authorName==='string') author=zop.authorName.trim();
        } catch { /* data-zop is optional and may not be JSON. */ }
    }
    if (!author) author=root.querySelector<HTMLElement>('.AuthorInfo-name,.AuthorInfo-head .UserLink-link,[data-za-detail-view-element_name="User"]')?.textContent?.trim();
    const metrics=sourceMetrics({
        likes:value('upvoteCount'),
        comments:value('commentCount'),
        views:value('viewCount'),
    });
    return {author:cleanAuthor(author,'zhihu'),sourceDate:sourceDay(value('dateCreated')||value('dateModified')),metrics};
}
export function authenticatedPage(snapshot:RenderedSnapshot,requested:string):SiteResult {
    const document=new DOMParser().parseFromString(snapshot.html,'text/html');
    const text=document.body.textContent?.replace(/\s+/g,' ').trim()||'';
    if(siteAccessRequired(snapshot.html)||/\/(?:login|signin|passport|sso)(?:\/|$)/i.test(new URL(snapshot.url).pathname)
        || /^(?:登录|sign in|sign up)(?:\s*\/\s*注册)?$/i.test(document.title.trim())
        || /^(?:请登录|登录后查看|access denied|sign in to continue)[\s\S]{0,180}$/i.test(text))throw new Error('来源返回登录或验证页面，请重新登录');
    const platform=platformFor(requested);
    if (platform === 'wechat-channel') {
        const stateNode = document.querySelector('[data-clip2md-live-state="wechat-finder"]');
        if (stateNode?.textContent) {
            try {
                const state = JSON.parse(stateNode.textContent) as Record<string, any>;
                const payload = state.payload && typeof state.payload === 'object' ? state.payload : state;
                const feedError = state.payload
                    ? wechatChannelsFeedError(state)
                    : undefined;
                if (feedError) throw new Error(feedError);
                const feed = payload.data?.feedInfo || payload.data?.feed_info || payload.feedInfo || {};
                const authorInfo = payload.data?.authorInfo || payload.authorInfo || {};
                const title = String(feed.title || feed.description || '微信视频号').trim().slice(0, 200);
                const description = String(feed.description || '').trim();
                const mediaCandidates = wechatChannelsMediaCandidates(payload);
                const video = mediaCandidates[0]?.url;
                const cover = address(feed.coverUrl || feed.picUrl, snapshot.url);
                const pics = Array.isArray(feed.picInfo)
                    ? feed.picInfo.map((item: any) => address(item?.url || item?.picUrl, snapshot.url)).filter(Boolean)
                    : [];
                const metrics = sourceMetrics({
                    likes: feed.likeCountFmt,
                    collects: feed.favCountFmt,
                    comments: feed.commentCountFmt,
                    shares: feed.forwardCountFmt,
                });
                const markdown = [description, ...(cover ? [`![封面](${cover})`] : []), ...pics.map((url: string) => `![原图](${url})`)].filter(Boolean).join('\n\n');
                const content = {
                    title,
                    source_title: title,
                    source: '微信视频号',
                    markdown,
                    author: cleanAuthor(authorInfo.nickname, 'wechat-channel'),
                    source_date: sourceDay(typeof feed.createtime === 'number' ? new Date(feed.createtime * 1000).toISOString() : undefined),
                    ...(metrics ? { metrics } : {}),
                    ...(cover || pics.length ? { image_urls: [...new Set([...(cover ? [cover] : []), ...pics])] } : {}),
                };
                if (video) return {
                    content,
                    detectedMedia: 'video',
                    media: {
                        url: video,
                        referer: 'https://channels.weixin.qq.com/',
                        ...(mediaCandidates[0]?.decodeKey
                            ? { decryptKey: mediaCandidates[0].decodeKey }
                            : {}),
                        ...(mediaCandidates[0]?.durationSeconds
                            ? { expectedDurationSeconds: mediaCandidates[0].durationSeconds }
                            : {}),
                        ...(mediaCandidates.length > 1
                            ? {
                                alternatives: mediaCandidates.slice(1).map(item => item.url),
                                alternativeDecryptKeys: mediaCandidates.slice(1).map(item => item.decodeKey),
                            }
                            : {}),
                    },
                };
                return { content };
            } catch (error) {
                if (error instanceof Error && /视频号|授权|播放/.test(error.message))
                    throw error;
                /* Fall back to the rendered page below. */
            }
        }
    }
    const zhihu=platform==='zhihu'?zhihuAnswerMetadata(document,requested):{};
    const title=meta(document,'og:title')||document.querySelector('h1')?.textContent?.trim()||document.title.trim();
    if(!title)throw new Error('尚未取得原文标题，请确认登录后可以访问该页面');
    const author=zhihu.author||cleanAuthor(
        meta(document,'author')||meta(document,'article:author')||
        document.querySelector(authorSelectors[platform]||'[rel="author"], [itemprop="author"], #js_name, .user-name, .username')?.textContent,
        platform,
    );
    const date=zhihu.sourceDate||meta(document,'article:published_time')||document.querySelector('time[datetime]')?.getAttribute('datetime')||undefined;
    const source=(articleSelectors[platform]?document.querySelector(articleSelectors[platform]):null)||document.querySelector('article, main, [role="main"]');
    let html=source?.innerHTML||'';
    if(!html){
        const parsed=new Readability(document.cloneNode(true) as Document,{charThreshold:20}).parse();
        const fallback=document.body.cloneNode(true) as HTMLElement;
        fallback.querySelectorAll('script,style,nav,header,footer,aside,form,[role="dialog"]').forEach(node=>node.remove());
        html=parsed?.content||fallback.innerHTML;
    }
    let markdown=html?htmlToMarkdown(html,snapshot.url):'';
    const videos=snapshot.videos||[],audios=snapshot.audios||[];
    const videoMeta=address(meta(document,'og:video:url')||meta(document,'og:video'),snapshot.url);
    const audioMeta=address(meta(document,'og:audio'),snapshot.url);
    const declared=(tag:string)=>address(document.querySelector(`${tag}[src],${tag} source[src]`)?.getAttribute('src')||undefined,snapshot.url);
    const embedded=Array.from(document.querySelectorAll('iframe[src]')).some(node=>{
        try{const url=new URL(node.getAttribute('src')!,snapshot.url);return /(?:^|\.)(?:youtube\.com|youtube-nocookie\.com|bilibili\.com|vimeo\.com|v\.qq\.com)$/.test(url.hostname);}catch{return false;}
    });
    const video=[...videos].sort((a,b)=>Number(b.playing)-Number(a.playing)||Number(b.visible)-Number(a.visible)||b.area-a.area).map(item=>address(item.src,snapshot.url)).find(Boolean)||declared('video')||(videoMeta&&/\.(?:mp4|webm|mov)(?:[?#]|$)/i.test(videoMeta)?videoMeta:undefined);
    const audio=audios.map(item=>address(item.src,snapshot.url)).find(Boolean)||declared('audio')||audioMeta;
    const detectedMedia=videos.length||videoMeta||embedded||document.querySelector('video')?'video':audios.length||audioMeta||document.querySelector('audio')?'audio':undefined;
    const media=video||audio;
    const cover=address(meta(document,'og:image'),snapshot.url);
    if(cover&&!markdown.includes(cover))markdown+=`\n\n![封面](${cover})`;
    const imageUrls = platform === 'wechat' || platform === 'wechat-channel'
        ? [...new Set(Array.from(document.querySelectorAll('#js_content img'))
            .map(node => address(node.getAttribute('data-src') || node.getAttribute('data-original') || node.getAttribute('src') || undefined, snapshot.url))
            .filter((value): value is string => !!value))]
        : [];
    for (const image of imageUrls)
        if (!markdown.includes(image)) markdown += `\n\n![原图](${image})`;
    if((!markdown.trim()||markdown.replace(/^#+\s*/, '').trim()===title)&&!detectedMedia)throw new Error('未探测到有效正文、图片或音视频，请确认原文已加载');
    const metrics=zhihu.metrics||readArticleMetrics(document,snapshot.url,title);
    return {content:{title,source_title:title,markdown:markdown.trim(),author:author?.slice(0,200),source_date:date,source_description:meta(document,'description')||undefined,...(imageUrls.length?{image_urls:imageUrls}:{}),...(metrics?{metrics}: {})},
        detectedMedia,...(media?{media:{url:media,referer:snapshot.url}}:{})};
}
export function standardComments(snapshot:RenderedSnapshot,platform:PlatformName,limit:number):SourceComment[] {
    const selector=commentSelectors[platform];
    if(!selector)throw new Error('此来源没有定制评论采集器');
    const document=new DOMParser().parseFromString(snapshot.html,'text/html');
    const rows=new Map<string,SourceComment>();
    for(const node of Array.from(document.querySelectorAll(selector))) {
        // The source tweet is not one of its own replies.
        if(platform==='twitter'&&node.querySelector('a[href]')?.getAttribute('href')===new URL(snapshot.url).pathname)continue;
        const content=node.querySelector('.comment-content, .comment-text, .new-comment, [data-testid="tweetText"], #content-text, .reply-content, .text')?.textContent?.trim();
        const author=node.querySelector('[rel="author"], .user-name, .username, .author, .name, #author-text, [data-testid="User-Name"]')?.textContent?.trim();
        const link=node.querySelector('a[href*="lc="],a[href*="/status/"]')?.getAttribute('href');
        const commentUrl=link?new URL(link,snapshot.url):undefined;
        if(platform==='twitter'&&commentUrl?.pathname===new URL(snapshot.url).pathname)continue;
        const identified=node.closest<HTMLElement>('[data-comment-id],[data-commentid],[comment_id],[data-id]')||node.querySelector<HTMLElement>('[data-comment-id],[data-commentid],[comment_id],[data-id]');
        const id=commentUrl?.searchParams.get('lc')||commentUrl?.pathname.match(/\/status\/(\d+)/)?.[1]||node.getAttribute('data-comment-id')||node.getAttribute('comment_id')||node.getAttribute('data-id')||identified?.getAttribute('data-comment-id')||identified?.getAttribute('data-commentid')||identified?.getAttribute('comment_id')||identified?.getAttribute('data-id')||node.id;
        if(!content||!author||!id)continue;
        const dateNode=node.querySelector<HTMLElement>('.date[title], time[datetime], time');
        const publishedAt=dateNode?.getAttribute('title')||dateNode?.getAttribute('datetime')||dateNode?.textContent?.trim()||undefined;
        rows.set(id,{id,author:author.slice(0,200),text:content.slice(0,20000),...(publishedAt?{publishedAt}: {})});
        if(rows.size>=limit)break;
    }
    if (!rows.size) {
        const component = document.querySelector(
            '.comment-list-box, .comment-list, [class*="comment-container"], [class*="comment-list"], [data-e2e="comment-list"], [node-type="commentList"]',
        );
        if (!component) return [];
        const rawRows = component.querySelectorAll(selector).length;
        // A mounted component without rows is a verified zero-comment result.
        // Rows that cannot be normalized indicate a changed source structure.
        if (rawRows === 0) return [];
        throw new Error('评论区已加载但没有可核验的评论结构，请确认原帖评论可以正常显示');
    }
    return [...rows.values()];
}
