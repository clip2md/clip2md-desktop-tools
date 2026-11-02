/** Bounded, read-only requests in the same first-party renderer as the topic. */
import type { RenderedSnapshot } from './rendered-sites';
import { parseZsxqResponse, zsxqComments, zsxqResources, zsxqTopicId } from './zsxq';
import { ArticleAccessRequired } from './extract';
import type { IndependentMedia } from './sites';
export interface ZsxqReadOptions { files?: boolean; players?: boolean; commentLimit?: number; topicId?: string }
interface Renderer { executeJavaScript(script:string):Promise<any> }
const record=(v:unknown):Record<string,any>=>v && typeof v==='object' && !Array.isArray(v)?v as Record<string,any>:{};
export async function zsxqRead(renderer:Renderer,snapshot:RenderedSnapshot,requested:string,signal:AbortSignal,options:ZsxqReadOptions):Promise<void> {
    const topicId=zsxqTopicId(requested)||options.topicId;
    if(!topicId || !/^[1-9]\d{0,24}$/.test(topicId))return;
    let lastRequest=0;
    // This transport never accepts a page-supplied endpoint or caller-supplied headers/signatures.
    const get=async(path:string):Promise<{status:number;payload:unknown}>=>{
        signal.throwIfAborted();
        const delay=1500-(Date.now()-lastRequest);
        if(delay>0)await new Promise<void>((resolve,reject)=>{
            const stop=()=>{clearTimeout(timer);reject(signal.reason);};
            const timer=setTimeout(()=>{signal.removeEventListener('abort',stop);resolve();},delay);
            signal.addEventListener('abort',stop,{once:true});
        });
        signal.throwIfAborted();lastRequest=Date.now();
        const endpoint=`https://api.zsxq.com${path}`;
        const response=await renderer.executeJavaScript(`(async()=>{const c=new AbortController();const t=setTimeout(()=>c.abort(),20000);try{const r=await fetch(${JSON.stringify(endpoint)},{credentials:'include',signal:c.signal,redirect:'error'});const reader=r.body.getReader();const chunks=[];let size=0;try{for(;;){const row=await reader.read();if(row.done)break;size+=row.value.byteLength;if(size>2097152)throw new Error('响应过大');chunks.push(row.value);}const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.byteLength;}return {status:r.status,body:new TextDecoder().decode(bytes)};}finally{await reader.cancel();}}finally{clearTimeout(t);}})()`);
        signal.throwIfAborted();
        if(typeof response?.body!=='string')throw new Error('知识星球只读响应格式无效');
        return {status:response.status,payload:parseZsxqResponse(response.body)};
    };
    if(options.files) {
        const resources=zsxqResources(snapshot,requested);
        const ids=[...(resources.files||[]).map(row=>row.id),...(resources.mediaItems||[]).flatMap(row=>row.fileId?[row.fileId]:[])];
        snapshot.zsxqFiles=[];
        for(const id of [...new Set(ids)]) {
            signal.throwIfAborted();
            try {
                const result=await get(`/v2/files/${id}/download_url`),body=record(result.payload);
                const candidate=record(body.resp_data).download_url;
                if(result.status===401 || [401,1009].includes(Number(body.code)))throw new ArticleAccessRequired('知识星球登录已失效，请重新登录');
                if(result.status===429 || body.code===1059)throw new Error('原站限流，请稍后重试');
                if(result.status!==200 || body.succeeded!==true || typeof candidate!=='string')throw new Error(`未取得附件下载地址（HTTP ${result.status}）`);
                const url=new URL(candidate);
                if(url.protocol!=='https:' || url.username || url.password)throw new Error('附件下载地址无效');
                snapshot.zsxqFiles.push({id,url:url.href});
            } catch(error) {signal.throwIfAborted();if(error instanceof ArticleAccessRequired)throw error;snapshot.zsxqFiles.push({id,error:error instanceof Error?error.message:'附件地址读取失败'});}
        }
    }
    if(options.players) {
        const players:IndependentMedia[]=await renderer.executeJavaScript(`(async()=>{
            const root=document.querySelector('app-topic-detail .topic-detail-panel,app-topic-detail,#topic-detail-container,article,main');if(!root)return [];
            const rows=[];let index=0;
            for(const player of root.querySelectorAll('video,audio')){
                if(!player.getClientRects().length || player.closest('app-comment,app-comment-item,[class*="comment-list"],[class*="reply-list"],[class*="referenced-topic"]'))continue;
                player.muted=true;
                if(!player.currentSrc){player.load();try{await Promise.race([player.play(),new Promise(resolve=>setTimeout(resolve,2000))]);player.pause();}catch{}}
                const src=player.getAttribute('data-src')||player.currentSrc||player.querySelector('source')?.src||player.src;
                const id=player.dataset.videoId||player.dataset.audioId||player.dataset.mediaId;
                const tracks=Array.from(player.querySelectorAll('track[kind="subtitles"],track[kind="captions"]')).map(t=>({url:t.src,language:t.srclang})).filter(t=>/^https:\\/\\//.test(t.url));
                rows.push({id:id||('player-'+(++index)+'-'+(src?new URL(src,location.href).pathname:'missing')),topicId:${JSON.stringify(topicId)},title:player.getAttribute('title')||player.getAttribute('aria-label')||('页面媒体 '+(rows.length+1)),kind:player.tagName==='VIDEO'?'video':'audio',url:src||'',referer:location.href,subtitles:tracks,error:/^https:\\/\\//.test(src||'')?undefined:'播放器未暴露可下载原件（可能使用加密或临时流）'});
            }return rows;
        })()`);
        signal.throwIfAborted();
        const known=zsxqTopicId(requested)?zsxqResources(snapshot,requested).mediaItems||[]:[];
        snapshot.zsxqPlayers=players.filter(row=>row.topicId===topicId).slice(0,100).map(row=>{
            const match=known.find(item=>item.url && item.url===row.url) || known.find(item=>item.id===row.id || item.id===`video-${row.id}` || item.id===`file-${row.id}`);
            return match?{...row,id:match.id,title:match.title}:row;
        });
    }
    if(options.commentLimit) {
        let cursor='',pages=0;
        const seen=new Set<string>();
        snapshot.zsxqComments=[];
        snapshot.zsxqCommentCoverage='评论分页结束；仅含原站返回的顶层评论，不含未返回的回复';
        while(pages++<100) {
            signal.throwIfAborted();
            const result=await get(`/v2/topics/${topicId}/comments?sort=asc&count=30&with_sticky=true${cursor?'&begin_time='+encodeURIComponent(cursor):''}`);
            snapshot.zsxqComments.push({topicId,...result});
            // Validate authentication, permissions and envelope before accepting a page.
            const comments=zsxqComments(snapshot,requested,options.commentLimit);
            const body=record(record(result.payload).resp_data),rows=body.comments as unknown[];
            if(comments.length>=options.commentLimit){snapshot.zsxqCommentCoverage=`已达到配置上限 ${options.commentLimit} 条；不代表全量评论或回复`;break;}
            const next=typeof record(rows.at(-1)).create_time==='string'?record(rows.at(-1)).create_time as string:'';
            if(!rows.length)break;
            if(!next || next===cursor || seen.has(next)){snapshot.zsxqCommentCoverage='评论游标未推进，已停止分页；不代表全量评论或回复';break;}
            seen.add(next);cursor=next;
        }
        if(pages>100)snapshot.zsxqCommentCoverage='已达到分页请求上限；不代表全量评论或回复';
    }
}
