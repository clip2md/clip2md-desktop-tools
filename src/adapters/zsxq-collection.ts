/** Independent resource publication and durable per-resource retry state. */
import fs from 'node:fs/promises';
import { AuthorizationRequired } from '../auth';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { downloadPublicMedia, type DownloadedMedia } from './media-download';
import { readPublicImage } from './network';
import type { SiteResult, IndependentMedia } from './sites';
import type { DesktopSettings, Feature } from '../config';
import type { TaskContext } from '../companion-protocol';
import type { MaterialStore } from '../storage';
import type { CollectionResult } from '../collector';
import { checkTool, runTool } from '../tools';
import { imageExtension } from '../images';
import { transcribe } from '../transcription';
const key=(value:string)=>createHash('sha256').update(value).digest('hex').slice(0,20);
const label=(value:string)=>value.replace(/[\\[\]<>`\r\n]/g,'_');
const link=(file:string)=>`</${file.split('/').map(encodeURIComponent).join('/')}>`;
interface Saved { path:string; sha256:string }
interface Dependencies {
    refresh:()=>Promise<SiteResult>;
    hls:(url:string,referer:string,directory:string)=>Promise<DownloadedMedia>;
}
export async function collectZsxqResources(result:SiteResult,context:TaskContext,feature:Feature,settings:DesktopSettings,store:MaterialStore,signal:AbortSignal,progress:(message:string)=>void,deps:Dependencies):Promise<CollectionResult> {
    const checkpoint=await store.checkpoint(context),journalFile=path.join(checkpoint,'zsxq-resources.json');
    const assets:string[]=[],body:string[]=[],failures:string[]=[];
    const imageReplacements:Record<string,string>={};
    let journal:Record<string,Saved>={};
    let remaining=settings.maxBytes;
    let refreshed:Promise<SiteResult>|undefined;
    const refresh=()=>refreshed??=deps.refresh();
    try {
        try {
            journal=JSON.parse(await fs.readFile(journalFile,'utf8')) as Record<string,Saved>;
            if(!journal || typeof journal!=='object' || Array.isArray(journal))throw new Error('invalid journal');
        } catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('知识星球素材检查点损坏，未覆盖已保存资料');}
        const count=(result.files?.length||0)+(result.mediaItems?.length||0)+(result.content.image_urls?.length||0);
        if(count>1000)throw new Error('单条主题关联资源超过 1000 项本地上限，未截断为成功结果');
        const remember=async(id:string,file:string)=>{
            const [manifest]=await store.manifest([file],signal);
            journal[id]={path:file,sha256:manifest.sha256};
            const staged=journalFile+'.tmp';
            await fs.writeFile(staged,JSON.stringify(journal),{mode:0o600});await fs.rename(staged,journalFile);
            if(!assets.includes(file))assets.push(file);
        };
        const reuse=async(id:string):Promise<string|undefined>=>{
            const saved=journal[id];if(!saved)return;
            try {
                const [actual]=await store.manifest([saved.path],signal);
                if(actual.sha256!==saved.sha256)throw new Error('saved material changed');
                if(!assets.includes(saved.path))assets.push(saved.path);
                return saved.path;
            } catch {signal.throwIfAborted();throw new Error('已保存素材被修改或丢失，请保留或修复原文件后重试');}
        };
        const publish=async(id:string,kind:string,download:DownloadedMedia)=>{
            if(download.bytes>remaining)throw new Error('关联资源合计超过本次下载大小限制');
            remaining-=download.bytes;
            const duplicate=Object.values(journal).find(row=>row.sha256===download.sha256);
            if(duplicate){const [actual]=await store.manifest([duplicate.path],signal);if(actual.sha256!==download.sha256)throw new Error('已保存素材内容被修改，未复用');}
            const file=duplicate?duplicate.path:await store.media(context,`zsxq-${key(id)}-${kind}`,download,signal);
            await remember(id,file);await fs.rm(download.path,{force:true});return file;
        };
        const mediaFile=async(item:IndependentMedia):Promise<string>=>{
            const identity=`media:${item.id}`,saved=await reuse(identity);if(saved)return saved;
            const directory=path.join(checkpoint,key(identity));await fs.mkdir(directory,{recursive:true,mode:0o700});
            const download=async(source:IndependentMedia)=>{
                if(source.error || !source.url)throw new Error(source.error||'未取得媒体下载地址');
                return /\.m3u8(?:$|[?#])/i.test(source.url)||source.url.endsWith('#clip2md-hls')
                    ?deps.hls(source.url,source.referer,directory)
                    :downloadPublicMedia(source.url,signal,source.referer,directory,undefined,{maxBytes:Math.max(1,remaining),timeoutMs:settings.timeoutMinutes*60000,expectedBytes:source.bytes});
            };
            let downloaded:DownloadedMedia;
            try {downloaded=await download(item);} catch(error) {
                signal.throwIfAborted();
                if(!/HTTP (?:401|403|404|410)\b/.test(error instanceof Error?error.message:''))throw error;
                const source=(await refresh()).mediaItems?.find(row=>row.id===item.id);
                if(!source)throw error;downloaded=await download(source);
            }
            if(item.expectedDurationSeconds) {
                await checkTool('ffmpeg',settings,directory,signal);
                const output=await runTool(settings.ffmpeg,['-nostdin','-v','error','-protocol_whitelist','file,pipe','-i',downloaded.path,'-map','0:v:0?','-map','0:a:0?','-c','copy','-progress','pipe:1','-f','null','-'],directory,signal,settings.timeoutMinutes*60000);
                const times=[...output.matchAll(/out_time_us=(\d+)/g)].map(row=>Number(row[1])/1000000),duration=times.at(-1);
                if(!output.includes('progress=end') || !duration || Math.abs(duration-item.expectedDurationSeconds)>Math.max(2,Math.min(30,item.expectedDurationSeconds*.01)))throw new Error('媒体播放时长与原站不符，未保存不完整媒体');
            }
            return publish(identity,item.kind,downloaded);
        };
        if(feature==='images') {
            const urls=[...new Set([...(result.content.image_urls||[]),...[...result.content.markdown.matchAll(/!\[[^\]]*\]\(<?(https?:\/\/[^\s)>]+)>?\)/g)].map(row=>row[1])])];
            for(const [index,url] of urls.entries()) {
                signal.throwIfAborted();
                const item=result.imageItems?.find(item=>item.url===url),identity=`image:${item?.id||url}`;
                try {
                    let file=await reuse(identity);
                    if(!file) {
                        const response=await readPublicImage(url,signal,context.sourceUrl),bytes=Buffer.from(response.arrayBuffer),extension=imageExtension(bytes);
                        if(!extension || /html|json/i.test(response.headers['content-type']) || bytes.length>remaining)throw new Error('图片格式无效或超过下载上限');
                        const directory=path.join(checkpoint,key(identity));await fs.mkdir(directory,{recursive:true,mode:0o700});
                        const temporary=path.join(directory,`input.${extension}`);await fs.writeFile(temporary,bytes,{mode:0o600});
                        file=await publish(identity,'image',{path:temporary,extension,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
                    }
                    body.push(`![原图](${link(file)})`);imageReplacements[url]=file;
                }catch(error){signal.throwIfAborted();failures.push(`图片 ${index+1}：${error instanceof Error?error.message:'下载失败'}`);}
            }
        }
        else if(feature==='files')for(const item of result.files||[]) {
            signal.throwIfAborted();progress(`正在保存附件：${item.name}`);
            try {
                const identity=`file:${item.id}`;
                let file=await reuse(identity);
                if(!file) {
                    const directory=path.join(checkpoint,key(identity));await fs.mkdir(directory,{recursive:true,mode:0o700});
                    const download=async(source:typeof item)=>{
                        if(!source.url || source.error)throw new Error(source.error||'未取得附件下载地址');
                        return downloadPublicMedia(source.url,signal,context.sourceUrl,directory,undefined,{maxBytes:Math.max(1,remaining),timeoutMs:settings.timeoutMinutes*60000,fileName:source.name,expectedBytes:source.bytes});
                    };
                    let downloaded:DownloadedMedia;
                    try {downloaded=await download(item);}catch(error){
                        signal.throwIfAborted();
                        if(!/HTTP (?:401|403|404|410)\b/.test(error instanceof Error?error.message:''))throw error;
                        const source=(await refresh()).files?.find(row=>row.id===item.id);
                        if(!source)throw error;downloaded=await download(source);
                    }
                    file=await publish(identity,'file',downloaded);
                }
                body.push(`[${label(item.name)}](${link(file)})`);
            } catch(error){signal.throwIfAborted();if(error instanceof AuthorizationRequired)throw error;failures.push(`${label(item.name)}：${error instanceof Error?error.message:'下载失败'}`);}
        }
        else for(const item of result.mediaItems||[]) {
            signal.throwIfAborted();progress(`正在处理：${item.title}`);
            try {
                if(feature==='subtitles') {
                    const identity=`transcript:${item.id}`,cached=await reuse(identity);
                    if(cached){body.push(`### ${label(item.title)}\n\n[字幕／转写](${link(cached)})\n\n${await fs.readFile(await store.localFile(cached),'utf8')}`);continue;}
                    const directory=path.join(checkpoint,key(identity));await fs.mkdir(directory,{recursive:true,mode:0o700});
                    let text='',origin='原站字幕';
                    for(const track of item.subtitles||[])try {
                        const response=await readPublicImage(track.url,signal,item.referer),bytes=Buffer.from(response.arrayBuffer);
                        if(bytes.length>4*1024*1024)throw new Error('字幕超过上限');
                        const raw=bytes.toString('utf8');
                        if(!/\d{2}:\d{2}[.,]\d{3}\s*-->/.test(raw)||/<(?:html|body)\b/i.test(raw))throw new Error('原站字幕格式无效');
                        text=raw;break;
                    }catch{signal.throwIfAborted();}
                    if(!text) {
                        const file=await mediaFile(item),local=await store.localFile(file),embedded=path.join(directory,'embedded.srt');
                        try {
                            await checkTool('ffmpeg',settings,directory,signal);
                            await runTool(settings.ffmpeg,['-nostdin','-v','error','-protocol_whitelist','file,pipe','-i',local,'-map','0:s:0','-c:s','srt','-y',embedded],directory,signal);
                            text=await fs.readFile(embedded,'utf8');origin='媒体内嵌字幕';
                            if(!text.trim() || Buffer.byteLength(text)>4*1024*1024)throw new Error('内嵌字幕为空或超过上限');
                        }catch {
                            signal.throwIfAborted();origin='Whisper 本地转写';
                            await checkTool('ffmpeg',settings,directory,signal);
                            text=await transcribe(local,directory,settings,signal,item.expectedDurationSeconds,0);
                        }
                    }
                    if(!text.trim())throw new Error('字幕／转写为空');
                    const file=await store.text(context,`zsxq-${key(identity)}-transcript`,text);await remember(identity,file);
                    body.push(`### ${label(item.title)}\n\n[${origin}](${link(file)})\n\n${text}`);
                } else {
                    const file=await mediaFile(item);body.push(`### ${label(item.title)}\n\n![](${link(file)})`);
                }
            } catch(error){signal.throwIfAborted();if(error instanceof AuthorizationRequired)throw error;failures.push(`${label(item.title)}：${error instanceof Error?error.message:'处理失败'}`);}
        }
        if(failures.length)body.push('> 以下资源尚未取得，重试将保留成功项：\n'+failures.map(value=>'> '+value).join('\n'));
        return {properties:{},assets,imageReplacements,body:body.join('\n\n')||'> 原站未返回此类关联资源。',...(failures.length?{failures}:{})};
    } finally {await fs.rm(path.join(checkpoint,'active.json'),{force:true});}
}
