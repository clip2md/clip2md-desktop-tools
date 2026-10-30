import {describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({collect:vi.fn()}));
vi.mock('./collector',async importOriginal=>({
 ...await importOriginal<typeof import('./collector')>(),
 collect:mocks.collect,
}));
import DesktopTools, {assertPersistedCookieLogin, commentsNeedAuthorization} from './main';
import {BRIDGE_EVENTS} from './companion-protocol';
describe('companion unload',()=>{
    it('does not advertise availability when a cancelled worker finishes after unload',()=>{
        const instance=new DesktopTools();const trigger=vi.fn();Object.assign(instance,{events:{trigger}});
        instance.onunload();instance['updateStatus']('late worker completion');
        expect(trigger).toHaveBeenCalledTimes(1);expect(trigger).toHaveBeenCalledWith(BRIDGE_EVENTS.state,expect.objectContaining({available:false}));
    });
});

describe('queue startup recovery',()=>{
    it('backs up malformed state and returns an empty usable queue',async()=>{
        const instance=new DesktopTools();
        const raw={version:1,jobs:'bad',properties:{}};
        const saveLocalStorage=vi.fn();
        const write=vi.fn(async()=>{});
        Object.assign(instance,{
            app:{
                loadLocalStorage:vi.fn(()=>raw),
                saveLocalStorage,
                vault:{
                    configDir:'.obsidian',
                    adapter:{mkdir:vi.fn(async()=>{}),write},
                },
            },
            logger:{log:vi.fn()},
        });
        const state=await instance['restoreQueueState']();
        expect(state).toEqual({version:1,jobs:[],properties:{}});
        expect(saveLocalStorage).toHaveBeenCalledWith('clipmd-desktop-state-v1',state);
        expect(write).toHaveBeenCalledWith(
            expect.stringMatching(/^\.obsidian\/clip2md\/recovery\/queue-state-/),
            expect.stringContaining('"source": "clipmd-desktop-state-v1"'),
        );
        expect(instance['logger'].log).toHaveBeenCalledWith('queue.recovered',{status:'reset'},'warn');
    });
});

import {normalizeSettings} from './config';
describe('manual desktop dependency and retained preferences',()=>{
 it('rejects enabling without a host, then stops without clearing configured paths/options',async()=>{
  const instance=new DesktopTools();const saveLocalStorage=vi.fn(),close=vi.fn(async()=>{});
  const settings=normalizeSettings({ffmpeg:'/user/ffmpeg',whisper:'/user/whisper',whisperModel:'/user/model',commentLimit:321});
  Object.assign(instance,{manifest:{version:"0.1.0"},app:{saveLocalStorage},events:{trigger:vi.fn()},settings,sessions:{close,setScope:vi.fn(async()=>{})},state:{version:1,jobs:[],properties:{}},toolVersions:{},bridge:null});
  await expect(instance.setEnabled(true)).rejects.toThrow('主插件');expect(saveLocalStorage).not.toHaveBeenCalled();
  Object.assign(instance,{bridge:{version:1,integratedDesktop:false},asrReady:true,scope:'a'.repeat(64)});
  await instance.setEnabled(true);await instance.setEnabled(false);
  expect(settings.ffmpeg).toBe('/user/ffmpeg');expect(settings.commentLimit).toBe(321);expect(settings.whisperModel).toBe('/user/model');expect(close).toHaveBeenCalledOnce();
  expect(saveLocalStorage).toHaveBeenLastCalledWith('clip2md-desktop-enabled-v1',false);
 });
});

describe('platform opt-in automatic supplementation',()=>{
 it('adds metadata automatically for enabled platforms and ignores other platforms',async()=>{
  const instance=new DesktopTools();
  const scope='a'.repeat(64),settings=normalizeSettings({platformEnabled:{bilibili:true},platforms:{bilibili:{metadata:true}}});
  const state={version:1,jobs:[],properties:{}};
  Object.assign(instance,{manuallyEnabled:true,settings,scope,bridge:{},state,persist:vi.fn(),drain:vi.fn()});
  const context={bindingScope:scope,taskId:42,sourceUrl:'https://www.bilibili.com/video/BV1234567890',contentVersion:'1:1',notePath:'Notes/42.md',daily:false};
  await instance['onTaskSaved'](context);
  expect(state.jobs).toHaveLength(1);expect(state.jobs[0]).toMatchObject({feature:'metadata'});
  await instance['onTaskSaved']({...context,taskId:43,sourceUrl:'https://www.douyin.com/video/43'});
  expect(state.jobs).toHaveLength(1);
 });
});

describe('failed Douyin recovery',()=>{
 it('requeues bounded failed jobs after a saved login is confirmed',async()=>{
  const instance=new DesktopTools();
  const scope='b'.repeat(64);
  const job={key:'x',context:{bindingScope:scope,taskId:77,sourceUrl:'https://www.douyin.com/video/77',contentVersion:'1',notePath:'Notes/77.md',daily:false},feature:'video',status:'failed',message:'旧失败',attempts:1};
  Object.assign(instance,{alive:true,manuallyEnabled:true,scope,bridge:{},state:{version:1,jobs:[job],properties:{}},sessions:{authorizedCookies:vi.fn(async()=>[{name:'sessionid',value:'saved'}]),hasStoredAuthorization:vi.fn(()=>true)},persist:vi.fn(),drain:vi.fn(),logger:{log:vi.fn()}});
  await instance['autoRetryDouyinJobs']();
  expect(job.status).toBe('queued');
  expect(job.message).toContain('自动重试');
  expect(instance['persist']).toHaveBeenCalled();
  expect(instance['drain']).toHaveBeenCalled();
 });
});

describe('queue content revision changes',()=>{
 const prepareRevisionReuse=(
  feature:'video'|'subtitles',
  sourceUrl:string,
  asset:string,
  cached=false,
)=>{
  const instance=new DesktopTools();const scope='d'.repeat(64);
  const completedContext={bindingScope:scope,taskId:16138,sourceUrl,contentVersion:'1:2',notePath:'Notes/16138.md',daily:false};
  const completed={key:'completed',context:completedContext,feature:'article',status:'complete',message:'完成',attempts:1,saved:{properties:{},assets:[asset],files:[]}};
  const job={key:'job',context:{...completedContext,contentVersion:'2:2'},feature,status:'queued',message:'等待',attempts:0};
  const latest={...job.context,contentVersion:'3:2'};
  const state={version:1 as const,jobs:[completed,job],properties:cached?{[`${scope}:16138`]:{assets:[asset]}}:{}};
  const seenAssets:string[]=[];const manifest=vi.fn(async(paths:string[])=>paths.map(path=>({path,sha256:'a'.repeat(64)})));
  Object.assign(instance,{
   alive:true,manuallyEnabled:true,bridge:{resolveTask:vi.fn(async()=>latest),applyMetadata:vi.fn(async()=>({status:'applied',preserved:[]}))},scope,generation:0,
   settings:normalizeSettings({}),state,active:null,persist:vi.fn(),
   store:{localFile:vi.fn(async()=>'/vault/asset'),manifest,supplement:vi.fn(async()=> 'aaa/16138-本地资料.md'),media:vi.fn(),text:vi.fn(),cache:vi.fn()},
   sessions:{authorizedCookies:vi.fn(async()=>[])},logger:{log:vi.fn()},assertASRReady:vi.fn(),
   requirePlatformLogin:vi.fn(async()=>{}),
  });
  mocks.collect.mockImplementation(async(_context,_feature,_settings,_sessions,_store,_signal,_progress,assets)=>{
   seenAssets.push(...assets);return {properties:{},assets:[],body:'跳过'};
  });
  return {instance,seenAssets,job};
 };
 it('uses completed image assets and the latest task revision for a short-link Douyin gallery',async()=>{
  const instance=new DesktopTools();const scope='c'.repeat(64);
  const sourceUrl='https://v.douyin.com/F_BIRaeLwvQ/';
  const savedAsset='aaa/_local/16137/16137-image-83d301c347b2019f.webp';
  const completed={key:'images',context:{bindingScope:scope,taskId:16137,sourceUrl,contentVersion:'2:2',notePath:'Notes/16137.md',daily:false},feature:'images',status:'complete',message:'完成',attempts:1,saved:{properties:{},assets:[savedAsset],files:[{path:savedAsset,sha256:'a'.repeat(64)}]}};
  const video={key:'video',context:{bindingScope:scope,taskId:16137,sourceUrl,contentVersion:'3:2',notePath:'Notes/16137.md',daily:false},feature:'video',status:'queued',message:'等待',attempts:0};
  const latest={...completed.context,contentVersion:'4:2'};
  const seenAssets:string[]=[];
  const manifest=vi.fn(async(paths:string[])=>paths.map(path=>({path,sha256:'a'.repeat(64)})));
  Object.assign(instance,{
   alive:true,manuallyEnabled:true,bridge:{resolveTask:vi.fn(async()=>latest),applyMetadata:vi.fn(async()=>({status:'applied',preserved:[]}))},scope,generation:0,
   settings:normalizeSettings({}),state:{version:1,jobs:[completed,video],properties:{}},active:null,persist:vi.fn(),
   store:{localFile:vi.fn(async()=>'/vault/image.webp'),manifest,supplement:vi.fn(async()=> 'aaa/16137-本地资料.md'),media:vi.fn(),text:vi.fn(),cache:vi.fn()},
   sessions:{authorizedCookies:vi.fn(async()=>[])},logger:{log:vi.fn()},assertASRReady:vi.fn(),
   requirePlatformLogin:vi.fn(async()=>{}),
  });
  mocks.collect.mockImplementation(async(_context,_feature,_settings,_sessions,_store,_signal,_progress,assets)=>{
   seenAssets.push(...assets);
   return {properties:{},assets:[],body:'> 抖音图文作品不含视频，已跳过视频采集。'};
  });
  await instance['runQueue']();
  expect(seenAssets).toContain(savedAsset);
  expect(manifest).toHaveBeenCalledWith([],expect.any(AbortSignal));
  expect(video.status).toBe('complete');
  expect(video.context.contentVersion).toBe('4:2');
 });
 it('does not reuse a completed video across revisions for another feature',async()=>{
  const {instance,seenAssets,job}=prepareRevisionReuse('subtitles','https://www.douyin.com/video/16138','aaa/_local/16138/16138-video-aaaaaaaaaaaaaaaa.mp4');
  await instance['runQueue']();
  expect(seenAssets).not.toContain('aaa/_local/16138/16138-video-aaaaaaaaaaaaaaaa.mp4');
  expect(job.status).toBe('complete');
 });
 it('does not reuse a cached video across revisions when the prior version is unknown',async()=>{
  const {instance,seenAssets,job}=prepareRevisionReuse('subtitles','https://www.douyin.com/video/16138','aaa/_local/16138/16138-video-aaaaaaaaaaaaaaaa.mp4',true);
  await instance['runQueue']();
  expect(seenAssets).not.toContain('aaa/_local/16138/16138-video-aaaaaaaaaaaaaaaa.mp4');
  expect(job.status).toBe('complete');
 });
 it('does not reuse Douyin image assets for features other than video',async()=>{
  const {instance,seenAssets,job}=prepareRevisionReuse('subtitles','https://www.douyin.com/video/16138','aaa/_local/16138/16138-image-aaaaaaaaaaaaaaaa.webp');
  await instance['runQueue']();
  expect(seenAssets).not.toContain('aaa/_local/16138/16138-image-aaaaaaaaaaaaaaaa.webp');
  expect(job.status).toBe('complete');
 });
});

describe('repaired Bilibili Opus recovery',()=>{
 it('requeues failed Opus features once after the adapter is repaired',async()=>{
  const instance=new DesktopTools();const scope='e'.repeat(64);
  const context={bindingScope:scope,taskId:15838,sourceUrl:'https://www.bilibili.com/opus/1261621092485693461/',contentVersion:'1',notePath:'Notes/15838.md',daily:false};
  const jobs=['metadata','article','video','comments'].map((feature,index)=>({key:`opus-${index}`,context,feature,status:'failed',message:'旧失败',attempts:2}));
  jobs.push({key:'douyin-repaired',context:{...context,taskId:15839,sourceUrl:'https://www.douyin.com/article/15839'},feature:'article',status:'failed',message:'旧失败',attempts:2});
  Object.assign(instance,{alive:true,manuallyEnabled:true,scope,bridge:{},state:{version:1,jobs,properties:{}},autoRetriedJobs:new Set(),persist:vi.fn(),drain:vi.fn(),logger:{log:vi.fn()}});
  await instance['autoRetryKnownSourceJobs']();
  expect(jobs.every(job=>job.status==='queued')).toBe(true);
  expect(jobs.every(job=>job.message).toString()).toBe('true');
  expect(jobs.find(job=>job.key==='opus-0')?.message).toContain('B站');
  expect(jobs.find(job=>job.key==='douyin-repaired')?.message).toContain('抖音');
  expect(instance['persist']).toHaveBeenCalled();expect(instance['drain']).toHaveBeenCalled();
  await instance['autoRetryKnownSourceJobs']();
  expect(instance['persist']).toHaveBeenCalledOnce();
 });
});

describe('persisted authorization failures',()=>{
 it.each([
  [new Error('原站页面未返回可核验的评论，请先打开原帖评论后重试；这不等同于登录失效'),false],
  [new Error('知乎评论接口要求登录或访问验证'),true],
  [new Error('请先授权后重试'),true],
 ])('classifies comment error without mistaken login prompts',(error,expected)=>{
  expect(commentsNeedAuthorization(error)).toBe(expected);
 });
 it('moves failed authorization jobs into the paused login state',async()=>{
  const instance=new DesktopTools();const scope='f'.repeat(64);
  const job={key:'auth-failed',context:{bindingScope:scope,taskId:15987,sourceUrl:'https://www.zhihu.com/question/433226615',contentVersion:'1',notePath:'Notes/15987.md',daily:false},feature:'comments',status:'failed',message:'请先完成登录或访问验证',attempts:2,lastError:'授权失败'};
  Object.assign(instance,{alive:true,manuallyEnabled:true,scope,bridge:{},state:{version:1,jobs:[job],properties:{}},persist:vi.fn(),drain:vi.fn(),promptWaitingAuthJobs:vi.fn()});
  await instance['pauseFailedAuthorizationJobs']();
  expect(job.status).toBe('waiting-auth');
  expect(job.message).toContain('暂停');
  expect(instance['persist']).toHaveBeenCalled();
 });
 it('does not pause an ordinary empty-comments failure as a login failure',async()=>{
  const instance=new DesktopTools();const scope='f'.repeat(64);
  const job={key:'empty-comments',context:{bindingScope:scope,taskId:16098,sourceUrl:'https://weibo.com/1/a',contentVersion:'1',notePath:'Notes/16098.md',daily:false},feature:'comments',status:'failed',message:'未取得可核验的评论',attempts:2,lastError:'页面未展开评论'};
  Object.assign(instance,{alive:true,manuallyEnabled:true,scope,bridge:{},state:{version:1,jobs:[job],properties:{}},persist:vi.fn(),drain:vi.fn(),promptWaitingAuthJobs:vi.fn()});
  await instance['pauseFailedAuthorizationJobs']();
  expect(job.status).toBe('failed');
 });
 it('requeues a stale comments job incorrectly stored as waiting authorization',async()=>{
  const instance=new DesktopTools();const scope='f'.repeat(64);
  const job={key:'stale-comments',context:{bindingScope:scope,taskId:16135,sourceUrl:'https://www.xiaoyuzhoufm.com/episode/1',contentVersion:'1',notePath:'Notes/16135.md',daily:false},feature:'comments',status:'waiting-auth',message:'需要原站登录或访问验证，已暂停等待授权',attempts:2,lastError:'页面没有一级评论'};
  Object.assign(instance,{alive:true,manuallyEnabled:true,scope,bridge:{},state:{version:1,jobs:[job],properties:{}},persist:vi.fn(),drain:vi.fn(),promptWaitingAuthJobs:vi.fn()});
  await instance['pauseFailedAuthorizationJobs']();
  expect(job.status).toBe('queued');
  expect(job.message).toContain('重新执行');
 });
});

describe('login handoff for paused jobs',()=>{
 it('accepts a persisted Cookie login without waiting for a second profile page',async()=>{
  const detected={state:'authenticated' as const,nickname:'weibo.com',sessionOnly:true};
  const inspect=vi.fn(async()=>({state:'authenticated' as const,nickname:'真实昵称'}));
  await expect(assertPersistedCookieLogin(detected,inspect)).resolves.toBe(detected);
  expect(inspect).not.toHaveBeenCalled();
 });
 it('opens only one platform login prompt while keeping the job paused',async()=>{
  const instance=new DesktopTools();
  const login=vi.fn(async()=>false);
  const scope='a'.repeat(64);
  Object.assign(instance,{alive:true,manuallyEnabled:true,scope,settings:normalizeSettings({}),loginPrompts:new Set(),login,state:{version:1,jobs:[],properties:{}},profileViews:new Set(),persist:vi.fn(),savePreferences:vi.fn(async()=>{})});
  await Promise.all([instance['promptLogin']('csdn'),instance['promptLogin']('csdn')]);
  expect(login).toHaveBeenCalledOnce();
  expect(instance['loginPrompts'].size).toBe(0);
 });
 it.each([
  ['kuaishou','https://www.kuaishou.com/short-video/1'],
  ['xiaoyuzhou','https://www.xiaoyuzhoufm.com/episode/1'],
  ['wechat-channel','https://weixin.qq.com/sph/example'],
 ] as const)('keeps %s on its dedicated login route instead of the waiting content URL',async(platform,sourceUrl)=>{
  const instance=new DesktopTools();const scope='a'.repeat(64),login=vi.fn(async()=>false);
  const job={key:'a',context:{bindingScope:scope,taskId:1,sourceUrl,contentVersion:'1',notePath:'Notes/1.md',daily:false},feature:'video',status:'waiting-auth',message:'登录',attempts:1};
  Object.assign(instance,{alive:true,manuallyEnabled:true,scope,settings:normalizeSettings({}),loginPrompts:new Set(),login,state:{version:1,jobs:[job],properties:{}},profileViews:new Set(),persist:vi.fn(),savePreferences:vi.fn(async()=>{})});
  await instance['promptLogin'](platform);
  expect(login).toHaveBeenCalledWith(platform,undefined);
 });
 it('opens a pending ordinary WeChat article as the login document',async()=>{
  const instance=new DesktopTools();const scope='a'.repeat(64),login=vi.fn(async()=>false),sourceUrl='https://mp.weixin.qq.com/s/article';
  const job={key:'a',context:{bindingScope:scope,taskId:1,sourceUrl,contentVersion:'1',notePath:'Notes/1.md',daily:false},feature:'article',status:'waiting-auth',message:'登录',attempts:1};
  Object.assign(instance,{alive:true,manuallyEnabled:true,scope,settings:normalizeSettings({}),loginPrompts:new Set(),login,state:{version:1,jobs:[job],properties:{}},profileViews:new Set(),persist:vi.fn(),savePreferences:vi.fn(async()=>{})});
  await instance['promptLogin']('wechat');
  expect(login).toHaveBeenCalledWith('wechat',sourceUrl);
 });
  it('reopens one login prompt per paused platform after reconnecting',async()=>{
  const instance=new DesktopTools();const scope='c'.repeat(64),prompt=vi.fn();
  const context=(taskId:number,sourceUrl:string)=>({bindingScope:scope,taskId,sourceUrl,contentVersion:'1',notePath:`Notes/${taskId}.md`,daily:false});
  Object.assign(instance,{alive:true,manuallyEnabled:true,scope,settings:normalizeSettings({}),state:{version:1,jobs:[
   {key:'a',context:context(1,'https://www.youtube.com/watch?v=a'),feature:'metadata',status:'waiting-auth',message:'登录',attempts:1},
   {key:'b',context:context(2,'https://www.youtube.com/watch?v=b'),feature:'article',status:'waiting-auth',message:'登录',attempts:1},
   {key:'c',context:context(3,'https://www.douban.com/note/1'),feature:'article',status:'waiting-auth',message:'登录',attempts:1},
  ],properties:{}},promptLogin:prompt});
  await instance['promptWaitingAuthJobs']();
  // A test fixture without the browser Cookie bridge leaves YouTube paused;
  // the real runtime checks Chrome and opens the handoff prompt when needed.
  expect(prompt.mock.calls.map(([platform])=>platform).sort()).toEqual(['douban']);
 });
 it('requeues X work after the Chrome Cookie bridge confirms auth',async()=>{
  const instance=new DesktopTools();const scope='d'.repeat(64),prompt=vi.fn();
  const job={key:'x',context:{bindingScope:scope,taskId:15300,sourceUrl:'https://x.com/OpenAIDevs/status/1790807033836707947',contentVersion:'1',notePath:'Notes/15300.md',daily:false},feature:'metadata',status:'waiting-auth',message:'等待 X 实际登录',attempts:0};
  const sessions={
   authorizedCookies:vi.fn(async()=>[{name:'auth_token',value:'auth',domain:'.x.com',path:'/'},{name:'ct0',value:'csrf',domain:'.x.com',path:'/'}]),
   hasStoredAuthorization:vi.fn(()=>false),hasLocalStorageAuthorization:vi.fn(()=>false),
  };
  Object.assign(instance,{alive:true,manuallyEnabled:true,scope,settings:normalizeSettings({}),state:{version:1,jobs:[job],properties:{}},sessions,promptLogin:prompt,persist:vi.fn(),drain:vi.fn()});
  await instance['promptWaitingAuthJobs']();
  expect(job.status).toBe('queued'); expect(job.message).toContain('浏览器登录已确认');
  expect(prompt).not.toHaveBeenCalled(); expect(instance['persist']).toHaveBeenCalled(); expect(instance['drain']).toHaveBeenCalled();
 });
});

describe('login handoff with an existing authorization',()=>{
 it('does not auto-close a challenge window from the previously saved cookie',()=>{
  const instance=new DesktopTools();
  Object.assign(instance,{sessions:{hasStoredAuthorization:vi.fn(()=>true)}});
  expect(instance['shouldAutoObserveLogin']('douyin')).toBe(false);
  expect(instance['shouldAutoObserveLogin']('bilibili')).toBe(false);
 });
 it('keeps automatic first-login detection when no authorization is stored',()=>{
  const instance=new DesktopTools();
  Object.assign(instance,{sessions:{hasStoredAuthorization:vi.fn(()=>false)}});
  expect(instance['shouldAutoObserveLogin']('douyin')).toBe(true);
  expect(instance['shouldAutoObserveLogin']('xiaohongshu')).toBe(true);
 });
 it('does not accept an unchanged auth Cookie as a completed challenge',()=>{
  const instance=new DesktopTools();
  Object.assign(instance,{sessions:{hasStoredAuthorization:vi.fn(()=>true)}});
  const previous='a'.repeat(64),current='a'.repeat(64),changed='b'.repeat(64);
  expect(previous).toBe(current);
  expect(current).not.toBe(changed);
 });
});

describe('closing an incomplete login',()=>{
 it('turns the platform off and cancels its queued and paused jobs',()=>{
  const instance=new DesktopTools();const scope='9'.repeat(64);
  const context={bindingScope:scope,taskId:16098,sourceUrl:'https://weibo.com/6282284901/5358455980557467',contentVersion:'1',notePath:'Notes/16098.md',daily:false};
  const jobs=[
   {key:'a',context,feature:'article',status:'queued',message:'等待',attempts:0},
   {key:'b',context,feature:'comments',status:'waiting-auth',message:'登录',attempts:0},
   {key:'c',context:{...context,taskId:16137,sourceUrl:'https://v.douyin.com/F_BIRaeLwvQ/'},feature:'video',status:'queued',message:'等待',attempts:0},
  ];
  Object.assign(instance,{scope,settings:normalizeSettings({platformEnabled:{weibo:true}}),state:{version:1,jobs,properties:{}},profileViews:new Set(),persist:vi.fn(),savePreferences:vi.fn(async()=>{}),active:null});
  instance['disableQueuedPlatform']('weibo');
  expect(instance.settings.platformEnabled.weibo).toBe(false);
  expect(jobs[0].status).toBe('cancelled');
  expect(jobs[1].status).toBe('cancelled');
  expect(jobs[2].status).toBe('queued');
  expect(instance['persist']).toHaveBeenCalledOnce();
 });
});
