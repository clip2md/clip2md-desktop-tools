/** Account inspection for settings and before capture. No polling or nickname persistence. */
import type { SiteSessions } from './auth';
import { loginOrigin, observedAccount, type LoginPlatform } from './config';
export type AccountProfile = { state:'authenticated'; nickname:string; sessionOnly?:boolean } | {state:'missing'|'expired'|'unknown'};
interface ProfileWebContents {
    debugger: {attach(version:string):void;detach():void;on(name:string,callback:(event:unknown,method:string,params:{requestId:string;response?:{url:string;status:number}})=>void):void;sendCommand(method:string,params?:Record<string,unknown>):Promise<unknown>};
    executeJavaScript(script:string,gesture:boolean):Promise<unknown>;
}
const object = (v:unknown):Record<string,unknown> => v && typeof v==='object' && !Array.isArray(v) ? v as Record<string,unknown> : {};
const nickname = (v:unknown):string => typeof v==='string' ? Array.from(v).filter(c=>c.charCodeAt(0)>=32&&c.charCodeAt(0)!==127).join('').trim().slice(0,100) : '';
const identity = (v:unknown):boolean => typeof v==='string' ? !!v.trim() && v!=='0' : typeof v==='number' && Number.isSafeInteger(v) && v>0;
function yuanbaoProfile(payload:unknown):AccountProfile {
    const root=object(payload),data=object(root.data);
    const user=Object.keys(data).length ? data : root;
    const id=user.userId ?? user.id;
    const name=nickname(user.userName ?? user.weixinName ?? user.nickname);
    const anonymous=typeof user.userType==='string' && /^anon$/i.test(user.userType)
        || typeof user.loginType==='string' && /^anon/i.test(user.loginType);
    return identity(id) && !anonymous
        ? {state:'authenticated',nickname:name||'yuanbao.tencent.com'}
        : {state:'unknown'};
}
/** Accept only explicitly authenticated responses from the platform's own self endpoint. */
export function profileFromResponse(platform:LoginPlatform,payload:unknown):AccountProfile {
    if(platform==='wechat-channel')return yuanbaoProfile(payload);
    const root=object(payload),data=object(root.data);
    if(platform==='bilibili') {
        if(root.code===-101 || data.isLogin===false)return {state:'expired'};
        const name=nickname(data.uname);
        return root.code===0 && data.isLogin===true && identity(data.mid) && name ? {state:'authenticated',nickname:name}:{state:'unknown'};
    }
    if(platform==='douyin') {
        const user=object(root.user),name=nickname(user.nickname);
        if(root.status_code===0 && root.user===null)return {state:'expired'};
        return root.status_code===0 && identity(user.uid) && name ? {state:'authenticated',nickname:name}:{state:'unknown'};
    }
    if(platform==='zhihu') {
        const id = root.id ?? root.uid;
        const name = nickname(root.name ?? root.nickname);
        return identity(id) && name ? {state:'authenticated',nickname:name}:{state:'unknown'};
    }
    if(platform!=='xiaohongshu')return {state:'unknown'};
    if(root.code===-100 || data.guest===true)return {state:'expired'};
    const name=nickname(data.nickname);
    return root.success===true && root.code===0 && identity(data.user_id) && data.guest!==true && name
        ? {state:'authenticated',nickname:name}:{state:'unknown'};
}
export function selfEndpoint(platform:LoginPlatform,value:string):boolean {
    try {
        const url=new URL(value);
        if(url.protocol!=='https:'||url.username||url.password)return false;
        if(platform==='wechat-channel')return url.hostname==='yuanbao.tencent.com' && url.pathname==='/api/getuserinfo';
        if(platform==='bilibili')return url.hostname==='api.bilibili.com' && url.pathname==='/x/web-interface/nav';
        if(platform==='douyin')return url.hostname==='www.douyin.com' && url.pathname==='/aweme/v1/web/user/profile/self/';
        if(platform==='zhihu')return url.hostname==='www.zhihu.com' && url.pathname==='/api/v4/me';
        if(platform!=='xiaohongshu')return false;
        return url.hostname==='edith.xiaohongshu.com' && ['/api/sns/web/v1/user/selfinfo','/api/sns/web/v2/user/me'].includes(url.pathname);
    }catch{return false;}
}
const loginCookies:Partial<Record<LoginPlatform,string[]>>={
    bilibili:['SESSDATA'],douyin:['sessionid','sessionid_ss'],xiaohongshu:['web_session'],zhihu:['z_c0'],
    youtube:['SID','HSID','SSID','APISID','SAPISID','LOGIN_INFO','__Secure-1PSID','__Secure-3PSID'],
    twitter:['auth_token','ct0'],
    csdn:['UserToken','UserName','UserInfo'],douban:['dbcl2'],weibo:['SUB','SUBP'],
    toutiao:['sessionid','sessionid_ss','sid_tt','uid_tt','uid_tt_ss'],
    kuaishou:['userId'], xiaoyuzhou:['x-jike-access-token'], lizhi:['lztacokefu'], applepodcasts:['media-user-token'],
};
const genericNicknameSelectors:Partial<Record<LoginPlatform,string>>={
    csdn:'.toolbar-btn-user .toolbar-btn-name, .toolbar-btn-user .user-name, .csdn-toolbar .user-name, [class*="user-name"]',
    douban:'.nav-user-account .nav-user-name, #db-nav-sns .nav-user-account, a[href^="/people/"]',
    weibo:'.gn_name, [node-type="screen_name"], [data-testid="UserName"]',
    youtube:'#avatar-btn[aria-label], ytd-topbar-menu-button-renderer #container[aria-label], [aria-label^="Google Account"]',
    twitter:'[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="UserName"]',
    toutiao:'.user-name, [class*="user-name"], [class*="nickname"]',
};
const genericProfilePage=(platform:LoginPlatform):string=>loginOrigin(platform);
function cookieNickname(platform:LoginPlatform,cookies:Awaited<ReturnType<SiteSessions['authorizedCookies']>>):string {
    if(platform!=='csdn')return '';
    const row=cookies.find(cookie=>cookie.name==='UserInfo' || cookie.name==='UserName');
    if(!row?.value)return '';
    let raw=row.value;
    try { raw=decodeURIComponent(row.value); } catch { /* Keep the raw cookie value. */ }
    try {
        const parsed=JSON.parse(raw) as Record<string,unknown>;
        for(const key of ['nickname','nickName','username','userName']) { const value=nickname(parsed[key]); if(value)return value; }
    } catch {/* UserName is commonly a plain cookie value. */}
    return nickname(raw);
}
async function renderedNickname(sessions:SiteSessions, platform:LoginPlatform, signal:AbortSignal):Promise<string> {
    const win=await sessions.open(platform,false);
    try {
        signal.throwIfAborted();
        await win.loadURL(genericProfilePage(platform));
        signal.throwIfAborted();
        const selector=genericNicknameSelectors[platform]||'';
        if (!selector) return '';
        const value=await (win.webContents as ProfileWebContents).executeJavaScript(`(() => {
            const selectors=${JSON.stringify(selector)};
            for (const el of document.querySelectorAll(selectors)) {
                const text=(el.getAttribute('aria-label')||el.textContent||'').replace(/\\s+/g,' ').trim();
                if (text && !/^登录(?:\\s|$)/.test(text)) return text;
            }
            return '';
        })()`,false);
        return nickname(value);
    } catch { return ''; }
    finally { sessions.release(win); }
}
export async function readAccountProfile(sessions:SiteSessions,platform:LoginPlatform,signal:AbortSignal):Promise<AccountProfile> {
    signal.throwIfAborted();
    const cookies=await sessions.authorizedCookies(platform, signal);
    signal.throwIfAborted();
    if(!observedAccount(platform)) {
        const stored = sessions.hasStoredAuthorization(platform);
        const validCookies = cookies.filter(c => !!c.value && (!c.expirationDate || c.expirationDate > Date.now()/1000));
        const valid = platform === 'wechat-channel'
            ? sessions.hasLocalStorageAuthorization(platform)
            : platform === 'twitter'
            ? validCookies.some(c => c.name === 'auth_token') && validCookies.some(c => c.name === 'ct0')
            : platform === 'csdn'
                ? validCookies.some(c => c.name === 'UserToken') && validCookies.some(c => c.name === 'UserName' || c.name === 'UserInfo')
                : loginCookies[platform]
                    ? validCookies.some(c => loginCookies[platform]!.includes(c.name)) || sessions.hasLocalStorageAuthorization(platform)
                    : validCookies.length > 0 || sessions.hasLocalStorageAuthorization(platform);
        if (!((stored || platform === 'youtube' || platform === 'twitter') && valid)) return {state:stored?'expired':'missing'};
        const name=cookieNickname(platform,validCookies)
            || (typeof (sessions as unknown as {open?:unknown}).open === 'function'
                ? await renderedNickname(sessions,platform,signal) : '');
        return {state:'authenticated',nickname:name||new URL(loginOrigin(platform)).hostname,sessionOnly:true};
    }
    if(platform!=='wechat-channel' && !cookies.some(c=>loginCookies[platform]?.includes(c.name) && c.value && (!c.expirationDate || c.expirationDate>Date.now()/1000)))return {state:sessions.hasStoredAuthorization(platform)?'expired':'missing'};
    const open = (sessions as unknown as {open?:SiteSessions['open']}).open;
    if(typeof open!=='function')return {state:sessions.hasStoredAuthorization(platform)?'unknown':'missing'};
    const win=await open.call(sessions,platform,false);
    const web=win.webContents as ProfileWebContents;
    let attached=false,done=false;
    const pending=new Set<string>();
    let complete!:(value:AccountProfile)=>void;
    const result=new Promise<AccountProfile>(resolve=>{complete=value=>{if(!done){done=true;resolve(value);}};});
    const stop=()=>{complete({state:'unknown'});sessions.release(win);};
    signal.addEventListener('abort',stop,{once:true});
    if(signal.aborted)stop();
    try {
        signal.throwIfAborted();
        web.debugger.attach('1.3');attached=true;
        web.debugger.on('message',(_event:unknown,method:string,params:{requestId:string;response?:{url:string;status:number}})=>{
            if(done||signal.aborted)return;
            if(method==='Network.responseReceived' && params.response && selfEndpoint(platform,params.response.url)) {
                if(params.response.status===401){complete({state:'expired'});return;}
                if(params.response.status===200 && pending.size<3)pending.add(params.requestId);
            }
            if(method==='Network.loadingFinished' && pending.delete(params.requestId)) {
                void (async()=>{
                    const body=await web.debugger.sendCommand('Network.getResponseBody',{requestId:params.requestId}) as {body?:string;base64Encoded?:boolean};
                    if(signal.aborted||done||typeof body.body!=='string'||body.body.length>256*1024||body.base64Encoded)return;
                    const profile=profileFromResponse(platform,JSON.parse(body.body));
                    if(profile.state!=='unknown')complete(profile);
                    else if(platform==='wechat-channel')complete(profile);
                })().catch(()=>undefined);
            }
        });
        // Do not wait for a renderer acknowledgement before starting navigation.
        void web.debugger.sendCommand('Network.enable').catch(()=>complete({state:'unknown'}));
        // The in-memory partition may outlive a plugin reload while the saved
        // SecretStorage was removed or never completed. Inspect that active
        // first-party session before deciding it is missing.
        if(platform==='wechat-channel') {
            await win.loadURL(loginOrigin(platform));
            if(signal.aborted||done) {
                if(!done){
                    const profilePage=await Promise.resolve(
                        web.executeJavaScript(`(() => {
                            const text=(document.body?.innerText||'').replace(/\\s+/g,' ').trim();
                            const account=Boolean(document.querySelector(
                                '[aria-label*="账户"], [aria-label*="个人中心"], [class*="avatar"], [class*="user-info"]'
                            ));
                            if (/未登录|微信登录|扫码登录/.test(text) && !account) return 'guest';
                            return '';
                        })()`,false),
                    ).catch(()=> '');
                    if(profilePage==='guest')complete({state:'expired'});
                }
                return await result;
            }
            void web.executeJavaScript("void fetch('/api/getuserinfo', {credentials:'include',cache:'no-store'}).catch(()=>{})",false);
            return await result;
        }
        // Sites perform their own signed self requests. Never synthesize signatures or scrape author nicknames.
        const profilePage=platform==='bilibili'?'https://www.bilibili.com/':platform==='xiaohongshu'?'https://www.xiaohongshu.com/explore':loginOrigin(platform);
        void win.loadURL(profilePage).then(async()=>{
            if(platform==='bilibili' && !done && !signal.aborted)
                await web.executeJavaScript("void fetch('https://api.bilibili.com/x/web-interface/nav', {credentials:'include'}).catch(()=>{})",false);
        }).catch(()=>complete({state:'unknown'}));
        return await result;
    } finally {
        signal.removeEventListener('abort',stop);
        if(attached&&!win.isDestroyed())try{web.debugger.detach();}catch{/* Closed host. */}
        sessions.release(win);
    }
}
