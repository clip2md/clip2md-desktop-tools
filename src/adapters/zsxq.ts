/** Knowledge Planet: bind browser responses to one topic, never scrape the group feed. */
import { ArticleAccessRequired, ArticleBodyUnavailable, htmlToMarkdown, publicationDate } from './extract';
import { defuddlePage, webLoginRequired } from './defuddle-page';
import { publicUrl, sourceMetrics, type SiteResult, type SiteFile, type IndependentMedia } from './sites';
import type { RenderedSnapshot } from './rendered-sites';
import type { ExtractedContent } from './extract';
import type { SourceComment } from '../comments';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const id = (value: unknown): string | undefined => typeof value === 'string' && /^[1-9]\d{0,24}$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
function sourceUrl(value: string): URL | undefined {
    try {
        const url = new URL(value);
        if (url.protocol === 'https:' && !url.username && !url.password && !url.port && (url.hostname === 'zsxq.com' || url.hostname.endsWith('.zsxq.com'))) return url;
    } catch { /* Invalid or foreign URL. */ }
}
export function zsxqTopicId(value: string): string | undefined {
    const url = sourceUrl(value);
    if (!url) return;
    return id(url.searchParams.get('topic_id')) || id(url.pathname.match(/\/(?:topic|topic_detail)\/([1-9]\d{0,24})(?:\/|$)/)?.[1]);
}
export function zsxqArticleId(value: string): string | undefined {
    const url = sourceUrl(value);
    return url?.hostname === 'articles.zsxq.com' ? url.pathname.match(/^\/id_([a-zA-Z0-9_-]{1,128})\.html$/)?.[1] : undefined;
}
export function zsxqTopicEndpoint(value: string): string | undefined {
    const url = sourceUrl(value);
    return url?.hostname === 'api.zsxq.com' ? id(url.pathname.match(/^\/v2\/topics\/([1-9]\d{0,24})(?:\/info)?$/)?.[1]) : undefined;
}
export function zsxqCommentEndpoint(value: string): string | undefined {
    const url=sourceUrl(value);
    return url?.hostname==='api.zsxq.com'?id(url.pathname.match(/^\/v2\/topics\/([1-9]\d{0,24})\/comments$/)?.[1]):undefined;
}
export function parseZsxqResponse(raw: string): unknown {
    if (raw.length > 2 * 1024 * 1024) throw new Error('知识星球响应超过本地处理上限');
    // Topic/comment/user IDs exceed Number.MAX_SAFE_INTEGER on the web API.
    return JSON.parse(raw.replace(/([,{]\s*"(?:topic_id|comment_id|user_id|uid|group_id|image_id|file_id|audio_id|video_id|media_id)"\s*:\s*)(\d{16,})(?=\s*[,}])/g, '$1"$2"')) as unknown;
}
export class ZsxqPermissionDenied extends Error {
    constructor() { super('当前账号无权阅读完整内容，请先在知识星球中确认已加入该星球及阅读权限'); }
}
export class ZsxqArticleRequired extends Error {
    constructor(readonly articleUrl: string, readonly metadata: ExtractedContent, readonly related: Pick<SiteResult,'files'|'mediaItems'|'imageItems'> = {}) { super('知识星球主题引用长文章，需要读取原文正文'); }
}
function assertAccess(snapshot: RenderedSnapshot): void {
    const document = new DOMParser().parseFromString(snapshot.html, 'text/html');
    const visible = document.body.cloneNode(true) as HTMLElement;
    visible.querySelectorAll('script,style,[hidden],[aria-hidden="true"]').forEach(node => node.remove());
    const gate = /加入星球(?:后|即可|才能)|付费(?:后|即可|才能)(?:查看|阅读)|仅(?:可)?预览|无权(?:限)?(?:查看|阅读)|暂无(?:阅读|访问)权限/;
    const blockers=Array.from(visible.querySelectorAll('[role="alert"],[aria-modal="true"],[class*="paywall"],[class*="permission-mask"],[class*="preview-mask"]'));
    if (blockers.some(node=>gate.test(node.textContent||'')) || (!snapshot.zsxqTopics?.length && (visible.textContent||'').length<400 && gate.test(visible.textContent||''))) throw new ZsxqPermissionDenied();
    if (webLoginRequired(document,snapshot)) throw new ArticleAccessRequired('知识星球要求原站登录，请完成登录后继续');
}
function topic(snapshot: RenderedSnapshot, requested: string): Record<string, unknown> {
    const expected = zsxqTopicId(requested) || zsxqTopicId(snapshot.url);
    if (!expected) throw new ArticleBodyUnavailable('请提供知识星球具体主题链接，不能采集星球首页或其他主题');
    const responses = snapshot.zsxqTopics?.filter(row => row.topicId === expected) || [];
    const response = responses.filter(row=>row.detail!==false).at(-1) || responses.at(-1);
    if (!response) throw new ArticleBodyUnavailable('知识星球未返回目标主题详情，请确认原文可访问后重试');
    const payload = object(response.payload);
    if (response.status === 401 || [401,1009].includes(Number(payload.code))) throw new ArticleAccessRequired('知识星球登录已失效，请重新登录');
    if (response.status === 429 || payload.code === 1059) throw new ArticleBodyUnavailable('知识星球请求过于频繁，请稍后重试');
    if (response.status === 403 || [403,1005,1008,1030].includes(Number(payload.code))) throw new ZsxqPermissionDenied();
    if (response.status !== 200 || payload.succeeded !== true) throw new ArticleBodyUnavailable('知识星球未返回可读取的主题详情，内容可能已删除或暂不可用');
    if (zsxqTopicId(snapshot.url) !== expected) throw new ArticleBodyUnavailable('知识星球页面未进入目标主题，未保存首页或其他主题');
    const body=object(payload.resp_data);
    if ((typeof body.type==='string' && body.type!=='all') || body.preview)throw new ZsxqPermissionDenied();
    const result = object(body.topic);
    if (id(result.topic_id) !== expected) throw new ArticleBodyUnavailable('知识星球返回的主题身份不一致，未保存其他内容');
    const group = sourceUrl(requested)?.pathname.match(/\/group\/([1-9]\d{0,24})(?:\/|$)/)?.[1];
    if (group && id(object(result.group).group_id) && id(object(result.group).group_id) !== group) throw new ArticleBodyUnavailable('知识星球返回的星球身份不一致');
    if (result.is_preview === true || result.is_accessible === false) throw new ZsxqPermissionDenied();
    return result;
}
/** Convert the site's inline <e> tokens to inert Markdown, retaining source links and line breaks. */
export function zsxqText(value: unknown, base: string): string {
    const document = new DOMParser().parseFromString(text(value).replace(/<e\b([^>]*?)\s*\/>/gi,'<e$1></e>').replace(/\r?\n/g,'<br>'), 'text/html');
    const decoded = (value: string): string => { try { return decodeURIComponent(value); } catch { return value; } };
    for (const node of Array.from(document.querySelectorAll('e'))) {
        const title = decoded(node.getAttribute('title') || node.textContent || '');
        const type = node.getAttribute('type');
        const href = type === 'web' ? publicUrl(decoded(node.getAttribute('href') || ''),base) : undefined;
        const replacement = document.createElement(href?'a':type==='text_bold'?'strong':'span');
        replacement.textContent = title;
        if(href)replacement.setAttribute('href',href);
        node.replaceWith(replacement);
    }
    return htmlToMarkdown(document.body.innerHTML,base).trim();
}
/** File identities are read exclusively from the validated target topic blocks. */
export function zsxqResources(snapshot: RenderedSnapshot, requested: string): Pick<SiteResult,'files'|'mediaItems'|'imageItems'> {
    const row=topic(snapshot,requested),topicId=id(row.topic_id)!;
    const files=new Map<string,SiteFile>(), media=new Map<string,IndependentMedia>();
    const imageItems:NonNullable<SiteResult['imageItems']>=[];
    for(const block of zsxqBlocks(row)) {
        for(const value of Array.isArray(block.images)?block.images:[]) {
            const image=object(value),url=publicUrl(object(image.original).url||object(image.large).url,requested);
            if(url)imageItems.push({id:id(image.image_id)||url,topicId,url});
        }
        const video=object(block.video),videoId=id(video.video_id);
        const cover=publicUrl(object(video.cover).url,requested);
        if(cover && videoId)imageItems.push({id:`video-${videoId}-cover`,topicId,url:cover});
        if(videoId) {
            const captured=snapshot.zsxqVideoUrls?.find(item=>item.id===videoId);
            const url=publicUrl(captured?.url,requested)||'';
            media.set(`video-${videoId}`,{id:`video-${videoId}`,topicId,title:text(video.title)||text(video.name)||`主题视频 ${media.size+1}`,kind:'video',url,referer:requested,expectedDurationSeconds:typeof video.duration==='number' && video.duration>0?video.duration:undefined,error:url?undefined:'目标主题播放器未返回可下载的视频地址'});
        }
        for(const value of Array.isArray(block.files)?block.files:[]) {
            const file=object(value),fileId=id(file.file_id),name=text(file.name);
            if(!fileId || !name)continue;
            const resolved=snapshot.zsxqFiles?.find(item=>item.id===fileId);
            const bytes=typeof file.size==='number' && Number.isSafeInteger(file.size) && file.size>0?file.size:undefined;
            const kind=/\.(?:mp3|m4a|wav|ogg|oga|flac|opus|aac)$/i.test(name)?'audio':/\.(?:mp4|m4v|mkv|webm|mov|ogv|mpeg|mpg|3gp|ts|flv)$/i.test(name)?'video':undefined;
            if(kind)media.set(`file-${fileId}`,{id:`file-${fileId}`,fileId,topicId,title:name,kind,url:resolved?.url||'',referer:requested,bytes,error:resolved?.error});
            else files.set(fileId,{id:fileId,topicId,name,bytes,...resolved});
        }
    }
    for(const player of snapshot.zsxqPlayers||[])if(player.topicId===topicId) {
        const existing=[...media.values()].find(row=>row.id===player.id || (row.url && player.url && row.url===player.url));
        if(existing){const url=existing.url||publicUrl(player.url,requested)||'';media.set(existing.id,{...existing,url,error:url?undefined:existing.error,subtitles:player.subtitles});}
        else media.set(player.id,player);
    }
    return {files:[...files.values()],mediaItems:[...media.values()],imageItems};
}
function zsxqBlocks(row:Record<string,unknown>):Record<string,unknown>[] {
    return ['talk','question','answer','task','solution'].map(key=>object(row[key]))
        .concat(Array.isArray(row.answers)?row.answers.map(object):[]);
}
export function zsxqPage(snapshot: RenderedSnapshot, requested: string, metadata?: ExtractedContent): SiteResult {
    assertAccess(snapshot);
    const articleId = zsxqArticleId(requested);
    if (articleId) {
        if (zsxqArticleId(snapshot.url) !== articleId) throw new ArticleBodyUnavailable('知识星球长文章跳转到其他页面，未取得原文');
        const extracted=defuddlePage(snapshot);
        const images=[...new Set([...(extracted.image_urls||[]),...(metadata?.image_urls||[])])];
        const markdown=extracted.markdown+(metadata?.image_urls||[]).filter(url=>!extracted.markdown.includes(url)).map(url=>`\n\n![](${url})`).join('');
        return {content:{...metadata,...extracted,markdown,image_urls:images,source:'知识星球',author:metadata?.author || extracted.author,source_date:metadata?.source_date || extracted.source_date}};
    }
    const row = topic(snapshot,requested), blocks=zsxqBlocks(row), primary=blocks.find(block=>Object.keys(block).length)||row;
    const owner=object(primary.owner || row.owner);
    const article=object(primary.article || row.article);
    const title=text(row.title) || text(article.title);
    const markdown=blocks.map((block,index)=>{
        const body=zsxqText(block.text,snapshot.url);
        return body && row.type==='q&a' ? `## ${index===1?'问题':'回答'}\n\n${body}`:body;
    }).filter(Boolean).join('\n\n') || zsxqText(row.content,snapshot.url);
    const related=zsxqResources(snapshot,requested);
    const count = (value:unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    const counts=object(row.counts);
    const metrics=sourceMetrics({likes:count(row.likes_count ?? counts.likes),comments:count(row.comments_count ?? counts.comments),views:count(row.readers_count ?? counts.readers)});
    const content:ExtractedContent={title:title || zsxqText(primary.text || row.content,snapshot.url).split('\n')[0].slice(0,100) || '知识星球主题',markdown,source:'知识星球',author:text(owner.name)||undefined,source_date:publicationDate(text(row.create_time)),...(metrics?{metrics}: {})};
    content.source_title=content.title;
    const covers=blocks.flatMap(part=>{const url=publicUrl(object(object(part.video).cover).url,snapshot.url);return url?[url]:[];});
    const images=[...new Set([...covers,...blocks.flatMap(part=>Array.isArray(part.images)?part.images.flatMap(value=>{
        const image=object(value),url=publicUrl(object(image.original).url || object(image.large).url,snapshot.url);
        return url?[url]:[];
    }):[])])];
    if(images.length){content.image_urls=images;content.markdown += '\n\n'+images.map(url=>`![](${url})`).join('\n\n');}
    const articleUrl=publicUrl(article.article_url || article.inline_article_url,snapshot.url);
    if (Object.keys(article).length) {
        if(!articleUrl || !zsxqArticleId(articleUrl) || !article.article_id)throw new ArticleBodyUnavailable('知识星球长文章缺少可核验原文链接，未将摘要保存为正文');
        throw new ZsxqArticleRequired(articleUrl,content,related);
    }
    if(!content.markdown.trim() && !related.files?.length && !related.mediaItems?.length)throw new ArticleBodyUnavailable('知识星球主题未提供可读取正文、图片或关联资源');
    return {content,...related};
}
export function zsxqComments(snapshot:RenderedSnapshot,requested:string,limit:number):SourceComment[] {
    assertAccess(snapshot);
    const expected=zsxqTopicId(requested)||zsxqTopicId(snapshot.url);
    const batches=snapshot.zsxqComments?.filter(row=>row.topicId===expected)||[];
    let rows:unknown[]=[];
    if(batches.length) {
        if(!expected || zsxqTopicId(snapshot.url)!==expected)throw new Error('知识星球评论页面的主题身份不一致');
        for(const batch of batches) {
            const payload=object(batch.payload),body=object(payload.resp_data);
            if(batch.status===401 || payload.code===401)throw new ArticleAccessRequired('知识星球评论要求重新登录');
            if(batch.status===429 || payload.code===1059)throw new Error('知识星球评论请求受到限流，请稍后重试');
            if(batch.status===403 || [403,1005,1008,1030].includes(Number(payload.code)))throw new ZsxqPermissionDenied();
            if(batch.status!==200 || payload.succeeded!==true || !Array.isArray(body.comments))throw new Error('知识星球评论响应格式无效');
            rows.push(...(Array.isArray(body.sticky_comments)?body.sticky_comments:[]),...body.comments);
        }
    } else {
        const row=topic(snapshot,requested);
        if(!Array.isArray(row.show_comments)) {
            if(row.comments_count===0 || object(row.counts).comments===0)return [];
            throw new Error('知识星球未返回可核验的评论样本，请在原站展开评论后重试');
        }
        rows=row.show_comments;
    }
    const result=new Map<string,SourceComment>();
    for(const value of rows) {
        const row=object(value),commentId=id(row.comment_id),author=text(object(row.owner).name),body=zsxqText(row.text,snapshot.url);
        if(commentId && author && body)result.set(commentId,{id:commentId,author,text:body,publishedAt:text(row.create_time)||undefined,likes:typeof row.likes_count==='number'?row.likes_count:undefined});
        if(result.size>=limit)break;
    }
    return [...result.values()];
}
