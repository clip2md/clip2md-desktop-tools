// @vitest-environment jsdom
import {beforeEach,afterEach,describe,expect,it,vi} from 'vitest';
const controls=vi.hoisted(()=>({toggles:[] as Array<{name:string;value:boolean;disabled:boolean;change?:(value:boolean)=>Promise<void>}>}));
vi.mock('obsidian',()=>({Notice:vi.fn(),Setting:class {
    settingEl:HTMLElement;private name='';
    constructor(parent:HTMLElement){this.settingEl=document.createElement('div');parent.appendChild(this.settingEl);}
    setName(value:string){this.name=value;this.settingEl.textContent=value;return this;}
    setDesc(value:string){const el=document.createElement('small');el.textContent=value;this.settingEl.appendChild(el);return this;}
    addToggle(fn:(toggle:unknown)=>void){const row={name:this.name,value:false,disabled:false,change:undefined as ((v:boolean)=>Promise<void>)|undefined};controls.toggles.push(row);const toggle={setValue:(value:boolean)=>{row.value=value;return toggle;},setDisabled:(value:boolean)=>{row.disabled=value;return toggle;},onChange:(f:(v:boolean)=>Promise<void>)=>{row.change=f;return toggle;}};fn(toggle);return this;}
    addButton(fn:(button:unknown)=>void){const element=document.createElement('button');this.settingEl.appendChild(element);const button={setButtonText:(text:string)=>{element.textContent=text;return button;},setDisabled:(value:boolean)=>{element.disabled=value;return button;},onClick:(action:()=>void)=>{element.onclick=action;return button;}};fn(button);return this;}
}}));
import {PlatformSettingsView} from './platform-settings';
import {normalizeSettings,validPreferences,PLATFORMS,FEATURES,supportsFeature} from './config';
import type {AccountProfile} from './account-profile';
function dom(){
    Object.assign(HTMLElement.prototype,{
        createDiv(this:HTMLElement,options?:{cls?:string}){const el=document.createElement('div');el.className=options?.cls||'';this.appendChild(el);return el;},
        createEl(this:HTMLElement,tag:string,options?:{text?:string;attr?:Record<string,string>}){const el=document.createElement(tag);el.textContent=options?.text||'';for(const [key,value] of Object.entries(options?.attr||{}))el.setAttribute(key,value);this.appendChild(el);return el;},
        setText(this:HTMLElement,text:string){this.textContent=text;},
    });
}
function fixture(raw:unknown={},available=true){
    const root=document.createElement('div');document.body.appendChild(root);const settings=normalizeSettings(raw);let scope='original';
    const options={settings,available:()=>available,scope:()=>scope,save:vi.fn(async()=>{}),platformChanged:vi.fn(),login:vi.fn(async()=>true),revoke:vi.fn(async()=>{}),profile:vi.fn(async(_platform:string,_signal:AbortSignal):Promise<AccountProfile>=>({state:'authenticated',nickname:'我的昵称'}))};
    const view=new PlatformSettingsView(root,options);view.render();return {root,settings,options,view,scope:(value:string)=>{scope=value;}};
}
const flush=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
beforeEach(()=>{dom();controls.toggles=[];vi.useFakeTimers();});
afterEach(()=>{document.body.innerHTML='';vi.clearAllTimers();vi.useRealTimers();});
describe('local clipping platform settings',()=>{
    it('adds the main property template when enabling source properties and rolls back on failure',async()=>{
        const f=fixture();const add=vi.fn(async()=>{throw new Error('template save failed');});
        Object.assign(f.options,{enableProperties:add});
        await controls.toggles.find(toggle=>toggle.name==='B站')!.change!(true);await flush();
        expect(add).toHaveBeenCalled();expect(f.settings.platforms.bilibili.metadata).toBe(false);
        expect(f.root.textContent).toContain('属性模板或采集配置保存失败');
        expect(f.root.textContent).not.toContain('clip2md_local_');f.view.dispose();
    });
    it('shows the same six capability controls and login actions for every named site',()=>{
        const f=fixture();
        expect(f.root.querySelectorAll('[data-platform]').length).toBe(PLATFORMS.length);
        for(const platform of PLATFORMS.filter(p=>p!=='web')){
            const card=f.root.querySelector(`[data-platform="${platform}"]`)!;
            expect(card.textContent).toContain('登录 / 重新登录');
            expect(card.textContent).toContain('刷新状态');expect(card.textContent).toContain('撤销授权');
        }
        f.view.dispose();
    });
    it.each(['csdn','zhihu','douban','wechat','weibo','youtube','twitter','kuaishou','toutiao'] as const)('keeps %s features locked until login completes',async platform=>{
        const f=fixture();f.options.profile.mockResolvedValue({state:'missing'});f.options.login.mockResolvedValue(false);
        const card=f.root.querySelector(`[data-platform="${platform}"]`)!;
        const name=card.querySelector('.clip2md-local-platform-header')!.textContent!;
        const header=controls.toggles.findIndex(t=>name.startsWith(t.name));
        await controls.toggles[header].change!(true);await flush();
        expect(f.options.login).toHaveBeenCalledWith(platform);
        expect(controls.toggles.slice(header+1,header+1+FEATURES.filter(feature=>supportsFeature(platform,feature)).length).every(t=>t.disabled)).toBe(true);
        f.view.dispose();
    });
    it('allows public generic capture with no domain and never prompts on render',async()=>{
        const f=fixture({platformEnabled:{web:true}});await flush();
        const toggles=controls.toggles.filter(toggle=>['基础来源属性','正文图文','正文图片'].includes(toggle.name)).slice(-3);
        expect(toggles).toHaveLength(3);expect(toggles.every(toggle=>!toggle.disabled&&toggle.value)).toBe(true);
        expect(f.options.login).not.toHaveBeenCalled();expect(f.settings.webDomains).toEqual([]);
        f.view.dispose();
    });
    it('opens manual domain login without saving a cancelled domain or disabling public capture',async()=>{
        const f=fixture({platformEnabled:{web:true}});f.options.login.mockResolvedValue(false);
        const card=f.root.querySelector('[data-platform="web"]')!;
        card.querySelector<HTMLInputElement>('input')!.value='https://Example.com/private/article';
        [...card.querySelectorAll('button')].find(b=>b.textContent==='添加并登录')!.click();await flush();
        expect(f.options.login).toHaveBeenCalledWith('web:example.com','https://example.com/private/article');
        expect(f.settings.webDomains).toEqual([]);expect(f.settings.platformEnabled.web).toBe(true);
        f.view.dispose();
    });
    it('reopens an existing domain for manual login and keeps its record on cancellation',async()=>{
        const f=fixture({platformEnabled:{web:true},webDomains:['example.com']});await flush();
        f.options.login.mockResolvedValue(false);f.options.profile.mockResolvedValue({state:'missing'});
        const card=f.root.querySelector('[data-platform="web"]')!;
        card.querySelector<HTMLInputElement>('input')!.value='example.com';
        [...card.querySelectorAll('button')].find(b=>b.textContent==='添加并登录')!.click();await flush();
        expect(f.options.login).toHaveBeenCalledWith('web:example.com','https://example.com/');
        expect(f.settings.webDomains).toEqual(['example.com']);expect(f.settings.platformEnabled.web).toBe(true);
        f.view.expired('web:example.com');expect(f.settings.platformEnabled.web).toBe(true);
        expect(f.root.textContent).toContain('需要重新登录');f.view.dispose();
    });
    it('distinguishes missing and stored generic sessions without auto-login',async()=>{
        const f=fixture({platformEnabled:{web:true},webDomains:['example.com']});await flush();
        expect(f.root.textContent).toContain('已保存本机登录态');
        f.options.profile.mockResolvedValue({state:'missing'});await f.view.refresh('web:example.com');
        expect(f.root.textContent).toContain('未保存登录态');expect(f.options.login).not.toHaveBeenCalled();
        f.view.dispose();
    });
    it.each(['bilibili','douyin','xiaohongshu'] as const)('prompts login for %s and keeps every feature locked until authenticated',async platform=>{
        const f=fixture();
        f.options.profile.mockResolvedValue({state:'missing'});
        let finish!:(value:AccountProfile)=>void;
        f.options.login.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}) as never);
        const label={bilibili:'B站',douyin:'抖音',xiaohongshu:'小红书'}[platform];
        const index=controls.toggles.findIndex(t=>t.name===label);
        const features=controls.toggles.slice(index+1,index+6);
        await controls.toggles[index].change!(true);await flush();
        expect(f.options.login).toHaveBeenCalledWith(platform);
        expect(features.every(t=>t.disabled)).toBe(true);
        expect(f.settings.platforms[platform].metadata).toBe(false);
        await features[0].change!(true);
        expect(f.settings.platforms[platform].metadata).toBe(false);
        finish({state:'authenticated',nickname:'已登录账号'});await flush();
        expect(features.every(t=>!t.disabled)).toBe(true);
        expect(f.settings.platforms[platform].metadata).toBe(true);
        f.view.expired(platform);expect(features.every(t=>t.disabled)).toBe(true);
        f.view.dispose();
    });
    it('keeps features locked after login cancellation and discards late login after scope changes',async()=>{
        const f=fixture();f.options.profile.mockResolvedValue({state:'missing'});
        f.options.login.mockResolvedValue(false);
        await controls.toggles.find(t=>t.name==='B站')!.change!(true);await flush();
        expect(f.root.textContent).toContain('登录尚未完成');
        expect(controls.toggles.filter(t=>t.name==='补充来源属性').every(t=>t.disabled)).toBe(true);
        let finish!:(value:AccountProfile)=>void;
        f.options.login.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}) as never);
        await controls.toggles.find(t=>t.name==='B站')!.change!(true);await flush();
        [...f.root.querySelectorAll('button')].find(b=>b.textContent==='登录 / 重新登录')!.click();await flush();
        f.scope('other');finish({state:'authenticated',nickname:'旧账号'});await flush();
        expect(f.root.textContent).not.toContain('旧账号');
        expect(f.settings.platforms.bilibili.metadata).toBe(false);f.view.dispose();
    });
    it('explains that metadata is synchronized to main note properties',()=>{
        const f=fixture();expect(f.root.textContent).toContain('笔记属性模板');
        expect(f.root.textContent).toContain('属性模板');f.view.dispose();
    });
    it('always lists readable platform names, with inactive configuration collapsed and no profile traffic',()=>{
        const f=fixture({},false);expect(f.root.textContent).toContain('B站');expect(f.root.textContent).toContain('小红书');
        expect([...f.root.querySelectorAll<HTMLElement>('.clip2md-local-platform-options')].every(panel=>panel.hidden)).toBe(true);
        expect(f.options.profile).not.toHaveBeenCalled();expect(controls.toggles.every(toggle=>toggle.disabled)).toBe(true);f.view.dispose();
    });
    it('enables only the selected platform and defaults to automatic metadata supplementation',async()=>{
        const f=fixture();await controls.toggles.find(toggle=>toggle.name==='B站')!.change!(true);await flush();
        expect(f.settings.platformEnabled.bilibili).toBe(true);expect(f.settings.platforms.bilibili.metadata).toBe(true);expect(f.settings.platforms.bilibili.article).toBe(true);
        expect(f.settings.platformEnabled.douyin).toBe(false);expect(f.options.profile).toHaveBeenCalledOnce();
        expect(f.root.textContent).toContain('已登录：我的昵称');expect(JSON.stringify(f.settings)).not.toContain('我的昵称');f.view.dispose();
    });
    it('checks accounts once per page opening; login completion refreshes the current nickname',async()=>{
        const f=fixture({platforms:{bilibili:{metadata:true}}});await flush();expect(f.options.profile).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(60000);expect(f.options.profile).toHaveBeenCalledOnce();
        f.options.profile.mockResolvedValue({state:'authenticated',nickname:'新昵称'});
        [...f.root.querySelectorAll('button')].find(b=>b.textContent==='登录 / 重新登录')!.click();await flush();
        expect(f.root.textContent).toContain('已登录：新昵称');expect(f.options.profile).toHaveBeenCalledTimes(2);f.view.dispose();
    });
    it('shows expired authorization and cancels profile work when leaving the page',async()=>{
        const f=fixture({platforms:{bilibili:{metadata:true}}});await flush();f.view.expired('bilibili');expect(f.root.textContent).toContain('登录已失效，请重新登录');
        let finish!:(value:AccountProfile)=>void;f.options.profile.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
        const work=f.view.refresh('bilibili');const signal=f.options.profile.mock.calls.at(-1)![1];f.view.dispose();
        expect(signal.aborted).toBe(true);finish({state:'authenticated',nickname:'过期响应昵称'});await work;
        expect(f.root.textContent).not.toContain('过期响应昵称');expect(f.root.textContent).not.toContain('我的昵称');
    });
    it('fills the nickname from the observed login response without requesting the profile twice',async()=>{
        const f=fixture({platforms:{bilibili:{metadata:true}}});await flush();
        f.options.login.mockResolvedValue({state:'authenticated',nickname:'首页登录昵称'} as never);
        [...f.root.querySelectorAll('button')].find(b=>b.textContent==='登录 / 重新登录')!.click();await flush();
        expect(f.root.textContent).toContain('已登录：首页登录昵称');expect(f.options.profile).toHaveBeenCalledOnce();
        expect(JSON.stringify(f.settings)).not.toContain('首页登录昵称');f.view.dispose();
    });
    it('migrates configured platforms and preserves feature preferences on platform disable',async()=>{
        const f=fixture({platforms:{bilibili:{metadata:true,video:true}}});await controls.toggles.find(toggle=>toggle.name==='B站')!.change!(false);
        expect(f.settings.platformEnabled.bilibili).toBe(false);expect(f.settings.platforms.bilibili.video).toBe(true);
        expect(validPreferences({platformEnabled:{bilibili:'invalid'}})).toBe(false);f.view.dispose();
    });
});

it('offers only product metadata, Markdown and images for Taobao/Tmall',async()=>{
    const f=fixture({platformEnabled:{taobao:true}});await flush();
    const card=f.root.querySelector('[data-platform="taobao"]')!;
    expect(card.textContent).toContain('淘宝/天猫');
    expect(card.textContent).toContain('Markdown');
    expect(card.textContent).not.toContain('字幕');
    expect(card.textContent).not.toContain('视频／音频');
    expect(f.settings.platforms.taobao).toMatchObject({metadata:true,article:true,images:true,video:false,comments:false,subtitles:false});
    f.view.dispose();
});

it('keeps upgraded Knowledge Planet media, files and subtitles opt-in after account refresh',async()=>{
    dom();const root=document.createElement('div'),settings=normalizeSettings({platformEnabled:{zsxq:true},platforms:{zsxq:{article:true,metadata:true,images:true,comments:true}}});
    const options={settings,available:()=>true,scope:()=> 'binding',save:vi.fn(async()=>{}),platformChanged:vi.fn(),login:vi.fn(async()=>({state:'authenticated' as const,nickname:'作者'})),revoke:vi.fn(async()=>{}),profile:vi.fn(async()=>({state:'authenticated' as const,nickname:'作者'}))};
    const view=new PlatformSettingsView(root,options);view.render();await flush();
    expect(settings.platforms.zsxq).toMatchObject({article:true,files:false,video:false,subtitles:false});view.dispose();
});
