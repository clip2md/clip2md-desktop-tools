import { Notice, Setting } from 'obsidian';
import { LOCAL_PLATFORM_LABELS, type FavoritePlatform } from './companion-protocol';
import { FEATURES, PLATFORMS, platformFor, normalizeWebDomain, supportsFeature, type DesktopSettings, type LoginPlatform, type PlatformName } from './config';
import type { AccountProfile } from './account-profile';
const labels={metadata:'补充来源属性',article:'正文图文',video:'视频／音频',comments:'评论',subtitles:'字幕与本地转写',images:'封面／原图',files:'文件附件'};
interface Options {
    settings:DesktopSettings;
    available:()=>boolean;
    scope:()=>string;
    save:()=>Promise<void>;
    enableProperties?:()=>Promise<void>;
    platformChanged:(platform:PlatformName,enabled:boolean)=>void;
    login:(platform:LoginPlatform,targetUrl?:string)=>Promise<boolean | AccountProfile>;
    revoke:(platform:LoginPlatform)=>Promise<void>;
    profile:(platform:LoginPlatform,signal:AbortSignal)=>Promise<AccountProfile>;
    importFavorites?:(platform:FavoritePlatform)=>void;
}
/** One view owns its account requests; leaving the page destroys all nickname state. */
export class PlatformSettingsView {
    private alive=true;
    private controllers=new Map<LoginPlatform,AbortController>();
    private accountRows=new Map<LoginPlatform,HTMLElement>();
    private expanded=new Set<LoginPlatform>();
    private authenticated=new Set<LoginPlatform>();
    private featureUpdates=new Map<PlatformName,Array<()=>void>>();
    private loginAttempts=new Map<LoginPlatform,symbol>();
    constructor(private root:HTMLElement,private options:Options) {}
    private base(platform:LoginPlatform):PlatformName { return platform.startsWith('web:') ? 'web' : platform as PlatformName; }
    private setStatus(platform:LoginPlatform,text:string,state:'checking'|'authenticated'|'missing'|'expired'|'error'='error'):void {
        const row=this.accountRows.get(platform);
        if(!row)return;
        row.setText(text);
        row.dataset.state=state;
    }
    private canUse(platform:PlatformName):boolean {
        const authenticated = platform === 'web'
            ? true
            : this.authenticated.has(platform);
        return this.alive && this.options.available() && this.options.settings.platformEnabled[platform] && authenticated;
    }
    private updateFeatures(platform:LoginPlatform):void { for(const update of this.featureUpdates.get(this.base(platform))||[])update(); }
    private rerender():void {
        for(const controller of this.controllers.values())controller.abort();
        this.controllers.clear();this.accountRows.clear();this.featureUpdates.clear();this.expanded.clear();
        this.root.replaceChildren();this.render();
    }
    private domainEditor(panel:HTMLElement):void {
        panel.createEl('p',{text:'公开网页无需添加域名或登录。正文被登录拦截时会打开原站窗口；也可在此添加域名并保存本机登录态。',cls:'setting-item-description'});
        const editor=panel.createDiv({cls:'clip2md-local-domain-editor'});
        const input=editor.createEl('input',{attr:{type:'url',placeholder:'https://example.com','aria-label':'通用网页域名'}});
        const add=editor.createEl('button',{text:'添加并登录'});add.type='button';
        add.disabled=!this.options.available();
        add.addEventListener('click',()=>{void (async()=>{
            if(add.disabled)return;
            const domain=normalizeWebDomain(input.value);
            if(!domain){new Notice('请输入有效的 HTTPS 网址或域名');return;}
            if(platformFor(`https://${domain}/`)!=='web'){new Notice('该站点已有定制配置，请使用对应平台卡片登录');return;}
            const scope=this.options.scope();add.disabled=true;
            try {
                const target=new URL(input.value.includes('://')?input.value:`https://${input.value}`).href;
                const saved=await this.options.login(`web:${domain}`,target);
                if(!this.alive||scope!==this.options.scope())return;
                if(saved)this.rerender();
            } catch { if(this.alive)new Notice('登录态或域名保存失败，请重试'); }
            finally{if(this.alive)add.disabled=!this.options.available();}
        })();});
    }
    render():void {
        this.root.createEl('p',{text:'按平台配置新同步笔记的本地补充；已有笔记可在“保存与处理”中单独选择。', cls:'clip2md-local-guide'});
        for(const platform of PLATFORMS) {
            const enabled=this.options.settings.platformEnabled[platform];
            const card=this.root.createDiv({cls:'clip2md-local-platform clip2md-settings-card'});
            card.dataset.platform=platform;
            const optionsDetails=card.createEl('details',{cls:'clip2md-local-platform-details'});
            optionsDetails.createEl('summary',{text:'登录与采集能力'});
            optionsDetails.hidden=!enabled||!this.options.available();
            const panel=optionsDetails.createDiv({cls:'clip2md-local-platform-options'});
            panel.setAttribute('aria-live','polite');
            panel.hidden=!enabled||!this.options.available();
            if(enabled&&this.options.available())for(const key of platform==='web'?this.options.settings.webDomains.map(domain=>`web:${domain}` as const):[platform as LoginPlatform])this.expanded.add(key);
            const row=new Setting(card).setName(LOCAL_PLATFORM_LABELS[platform]);
            row.settingEl.classList.add('clip2md-local-platform-header');
            card.insertBefore(row.settingEl,optionsDetails);
            const platformStatus=card.createEl('p',{text:enabled?(platform==='web'?'公开页面可直接采集':'登录状态检查中…'):'未启用',cls:'clip2md-local-platform-status',attr:{'aria-live':'polite'}});
            card.insertBefore(platformStatus,optionsDetails);
            row.addToggle(toggle=>toggle.setValue(enabled).setDisabled(!this.options.available()).onChange(async value=>{
                const before=this.options.settings.platformEnabled[platform];
                const beforeFlags={...this.options.settings.platforms[platform]};
                this.options.settings.platformEnabled[platform]=value;
                if(platform==='web'&&value&&!Object.values(beforeFlags).some(Boolean))
                    Object.assign(this.options.settings.platforms.web,{metadata:true,article:true,images:true});
                try{if(platform==='web'&&value&&this.options.settings.platforms.web.metadata)await this.options.enableProperties?.();await this.options.save();}
                catch{this.options.settings.platformEnabled[platform]=before;Object.assign(this.options.settings.platforms[platform],beforeFlags);toggle.setValue(before);return;}
                panel.hidden=!value;
                const keys:LoginPlatform[]=platform==='web'?this.options.settings.webDomains.map(domain=>`web:${domain}` as const):[platform];
                for(const key of keys) {
                    if(value){this.expanded.add(key);void this.refresh(key,true);}
                    else {this.expanded.delete(key);this.controllers.get(key)?.abort();this.authenticated.delete(key);this.loginAttempts.delete(key);}
                }
                this.options.platformChanged(platform,value);
                optionsDetails.hidden=!value||!this.options.available();
                // Keep feature controls in sync with the default metadata selection.
                for(const update of featureUpdates)update();
            }));
            const featureUpdates:Array<()=>void>=[];
            this.featureUpdates.set(platform,featureUpdates);
            panel.createEl('p',{text:platform==='web'?'使用 Defuddle 保存正文图文及基础信息；公开页面无需登录。':'登录后才能启用采集能力；开启来源属性时会同步更新笔记属性模板。',cls:'setting-item-description clip2md-local-feature-guide'});
            for(const feature of FEATURES) {
                if(!supportsFeature(platform,feature))continue;
                const setting=new Setting(panel).setName(platform==='web'&&feature==='metadata'?'基础来源属性':platform==='web'&&feature==='images'?'正文图片':labels[feature]);
                if(feature==='article')setting.setDesc(platform==='taobao'?'保存商品价格、店铺、当前规格、参数和详情图文；价格以本次页面显示为准':'保存正文及其本地图片');
                if(feature==='video')setting.setDesc('保存页面中探测到的音视频');
                if(feature==='metadata')setting.setDesc(platform==='taobao'?'保存商品标题和来源；商品信息写入 Markdown 正文':platform==='web'?'保存 Defuddle 提取的标题、作者和发布时间':'补充标题、作者、发布时间和互动数据');
                if(feature==='subtitles')setting.setDesc('优先原站字幕，无字幕时本地转写');
                setting.addToggle(toggle=>{
                    featureUpdates.push(()=>{toggle.setValue(this.options.settings.platforms[platform][feature]).setDisabled(!this.canUse(platform)||!supportsFeature(platform,feature));});
                    toggle.setValue(this.options.settings.platforms[platform][feature]).setDisabled(!this.canUse(platform)||!supportsFeature(platform,feature)).onChange(async value=>{
                        if(!this.canUse(platform)||!supportsFeature(platform,feature)){toggle.setValue(this.options.settings.platforms[platform][feature]);return;}
                        const before=this.options.settings.platforms[platform][feature];
                        this.options.settings.platforms[platform][feature]=value;
                        try{if(value&&feature==='metadata')await this.options.enableProperties?.();await this.options.save();if(value&&feature==='metadata')new Notice('来源属性已添加到主插件的笔记属性模板，可修改字段名称和属性值；后续采集优先保留你的修改。');}
                        catch{this.options.settings.platforms[platform][feature]=before;toggle.setValue(before);}
                    });
                });
            }
            if(this.options.importFavorites && (platform==='bilibili'||platform==='xiaohongshu'||platform==='douyin'))
                new Setting(panel).setName('从平台收藏导入').setDesc('全量读取收藏，先检查额度再创建剪藏任务。')
                    .addButton(button=>{
                        const update=()=>{button.setDisabled(!this.canUse(platform));};
                        featureUpdates.push(update);update();
                        button.setButtonText('导入收藏').onClick(()=>{if(this.canUse(platform))this.options.importFavorites?.(platform);});
                    });
            if(platform==='web')this.domainEditor(panel);
            const targets:LoginPlatform[]=platform==='web'?this.options.settings.webDomains.map(domain=>`web:${domain}` as const):[platform];
            for(const p of targets) {
                const accountPanel=platform==='web'?panel.createDiv({cls:'clip2md-local-domain'}):panel;
                if(platform==='web')accountPanel.createEl('strong',{text:p.slice(4)});
                const accountStatus=platform==='web'
                    ? accountPanel.createEl('p',{text:'登录状态检查中…',cls:'clip2md-local-domain-status',attr:{'aria-live':'polite'}})
                    : platformStatus;
                this.accountRows.set(p,accountStatus);
                new Setting(accountPanel).setName('原站账号')
                    .addButton(button=>button.setButtonText('登录 / 重新登录').setDisabled(!this.options.available()).onClick(()=>{
                        button.setDisabled(true);
                        void this.login(p).finally(()=>{if(this.alive)button.setDisabled(!this.options.available());});
                    }))
                    .addButton(button=>button.setButtonText('刷新状态').setDisabled(!this.options.available()).onClick(()=>{void this.refresh(p);}))
                    .addButton(button=>button.setButtonText('撤销授权').setDisabled(!this.options.available()).onClick(()=>{
                        this.controllers.get(p)?.abort();
                        this.authenticated.delete(p);this.loginAttempts.delete(p);this.updateFeatures(p);
                        void this.options.revoke(p).then(()=>{if(this.alive)this.setStatus(p,p.startsWith('web:')?'未保存登录态；公开页面仍可直接剪藏。':'已撤销授权，请重新登录。功能已锁定。','expired');}).catch(()=>{if(this.alive)this.setStatus(p,'撤销失败，请重试。功能已锁定。','error');});
                    }));
            if(platform==='web')new Setting(accountPanel).addButton(button=>button.setButtonText('移除此域名').setDisabled(!this.options.available()).onClick(()=>{void (async()=>{
                    const before=[...this.options.settings.webDomains];
                    this.options.settings.webDomains=before.filter(domain=>`web:${domain}`!==p);
                    try{await this.options.save();await this.options.revoke(p);this.authenticated.delete(p);if(this.alive)this.rerender();}
                    catch{this.options.settings.webDomains=before;new Notice('移除失败，请重试');}
                })();}));
                if(enabled)void this.refresh(p,true);
            }
        }
    }
    private async unlock(platform:LoginPlatform,profile:Extract<AccountProfile,{state:'authenticated'}>):Promise<void> {
        const scope=this.options.scope();
        this.authenticated.add(platform);
        const flags=this.options.settings.platforms[this.base(platform)];
        const before={...flags};
        for(const feature of FEATURES)
            if(!['web','zsxq'].includes(this.base(platform))&&supportsFeature(this.base(platform),feature)) flags[feature]=true;
        const hasChanged=FEATURES.some(feature=>flags[feature]!==before[feature]);
        if(hasChanged) {
            try{await this.options.enableProperties?.();await this.options.save();}
            catch{Object.assign(flags,before);this.authenticated.delete(platform);this.updateFeatures(platform);this.setStatus(platform,'来源属性模板或采集配置保存失败，请重试。','error');return;}
        }
        this.options.platformChanged(this.base(platform),true);
        if(scope!==this.options.scope()){this.authenticated.delete(platform);this.updateFeatures(platform);return;}
        if(!this.canUse(this.base(platform)))return;
        const label=platform.startsWith('web:')?platform.slice(4):LOCAL_PLATFORM_LABELS[this.base(platform)];
        this.setStatus(platform,platform.startsWith('web:')?`${label} · 已保存本机登录态`:profile.sessionOnly?`${label} · 已登录：${profile.nickname}（本机登录态）`:`已登录：${profile.nickname}`,'authenticated');
        this.updateFeatures(platform);
    }
    private async login(platform:LoginPlatform):Promise<void> {
        if(!this.alive||!this.options.available()||!this.expanded.has(platform)||this.loginAttempts.has(platform))return;
        const attempt=Symbol(),scope=this.options.scope();
        this.loginAttempts.set(platform,attempt);this.controllers.get(platform)?.abort();
        this.authenticated.delete(platform);this.updateFeatures(platform);
        this.setStatus(platform,'等待完成原站登录…','checking');
        try{
            const saved=await this.options.login(platform);
            if(!this.alive||this.loginAttempts.get(platform)!==attempt||scope!==this.options.scope()||!this.options.available()||!this.expanded.has(platform))return;
            if(typeof saved==='object'&&saved.state==='authenticated')await this.unlock(platform,saved);
            else if(saved===true){this.loginAttempts.delete(platform);await this.refresh(platform);}
            else { this.setStatus(platform,platform.startsWith('web:')?'登录尚未完成；公开页面仍可直接剪藏。':'登录尚未完成，平台已关闭','missing'); await this.disablePlatform(platform); }
        }catch{if(this.alive&&scope===this.options.scope()&&this.loginAttempts.get(platform)===attempt){this.setStatus(platform,platform.startsWith('web:')?'登录态保存失败，请重试。':'登录尚未完成，平台已关闭','error');await this.disablePlatform(platform);}}
        finally{if(this.loginAttempts.get(platform)===attempt)this.loginAttempts.delete(platform);}
    }
    private async disablePlatform(platform:LoginPlatform):Promise<void> {
        const base=this.base(platform);
        if(base==='web')return;
        if(!this.options.settings.platformEnabled[base])return;
        this.options.settings.platformEnabled[base]=false;
        this.authenticated.delete(platform);this.expanded.delete(platform);this.controllers.get(platform)?.abort();
        try{await this.options.save();}catch{/* Keep the in-memory lock even if persistence is temporarily unavailable. */}
        this.options.platformChanged(base,false);
        if(this.alive){
            const panel=this.accountRows.get(platform)?.parentElement?.parentElement?.querySelector<HTMLElement>('.clip2md-local-platform-options');
            if(panel)panel.hidden=true;
        }
    }
    async refresh(platform:LoginPlatform,promptLogin=false):Promise<void> {
        if(!this.alive || !this.options.available() || !this.expanded.has(platform))return;
        if(this.loginAttempts.has(platform)&&!promptLogin)return;
        this.authenticated.delete(platform);this.updateFeatures(platform);
        this.controllers.get(platform)?.abort();
        const controller=new AbortController();this.controllers.set(platform,controller);
        const scope=this.options.scope(),row=this.accountRows.get(platform);
        this.setStatus(platform,'正在检查登录状态…','checking');
        const timeout=window.setTimeout(()=>{if(this.alive&&row?.isConnected&&this.controllers.get(platform)===controller)this.setStatus(platform,'检查超时，请刷新状态或重新登录','error');controller.abort();},15000);
        try {
            const profile=await this.options.profile(platform,controller.signal);
            if(!this.alive||!row?.isConnected||controller.signal.aborted||scope!==this.options.scope()||!this.options.available())return;
            if(profile.state==='authenticated'){
                if(platform.startsWith('web:')){this.authenticated.add(platform);this.setStatus(platform,'已保存本机登录态','authenticated');this.updateFeatures(platform);}
                else await this.unlock(platform,profile);
            }
            else {
                this.setStatus(platform,profile.state==='expired'?'需要重新登录':profile.state==='missing'?'未保存登录态':'登录状态暂不可用',profile.state==='expired'?'expired':profile.state==='missing'?'missing':'error');
                if(!platform.startsWith('web:')&&promptLogin&&(profile.state==='missing'||profile.state==='expired'))void this.login(platform);
            }
        } catch {if(this.alive&&!controller.signal.aborted&&row?.isConnected&&scope===this.options.scope())this.setStatus(platform,'登录状态暂不可用，请刷新或重新登录','error');}
        finally{window.clearTimeout(timeout);if(this.controllers.get(platform)===controller)this.controllers.delete(platform);}
    }
    expired(platform:LoginPlatform):void {
        this.controllers.get(platform)?.abort();this.authenticated.delete(platform);this.updateFeatures(platform);
        const base=this.base(platform);
        if(base==='web'){this.setStatus(platform,'需要重新登录；公开页面仍可直接剪藏。','expired');return;}
        if(this.options.settings.platformEnabled[base]){
            this.options.settings.platformEnabled[base]=false;
            void this.options.save().catch(()=>undefined);
            this.options.platformChanged(base,false);
        }
        this.setStatus(platform,'登录已失效，请重新登录；平台已自动关闭。','expired');
    }
    dispose():void {this.alive=false;this.authenticated.clear();this.loginAttempts.clear();for(const p of this.featureUpdates.keys())this.updateFeatures(p as LoginPlatform);for(const [platform] of this.accountRows)this.setStatus(platform,'登录状态待检查，请重新打开设置页。','checking');for(const controller of this.controllers.values())controller.abort();this.controllers.clear();this.accountRows.clear();}
}
