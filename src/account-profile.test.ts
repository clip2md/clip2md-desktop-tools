import {describe,expect,it,vi} from 'vitest';
import {profileFromResponse,readAccountProfile,selfEndpoint} from './account-profile';

describe('saved domain login inspection',()=>{
    it('accepts a Chrome-backed YouTube session without a saved plugin secret',async()=>{
        const sessions={hasStoredAuthorization:()=>false,hasLocalStorageAuthorization:()=>false,authorizedCookies:async()=>[{name:'SID',value:'browser-session',domain:'.youtube.com',path:'/'}]};
        expect(await readAccountProfile(sessions as unknown as SiteSessions,'youtube',new AbortController().signal)).toEqual({state:'authenticated',nickname:'www.youtube.com',sessionOnly:true});
    });
    it('requires both X authentication cookies and rejects guest-only Chrome state',async()=>{
        const guest={hasStoredAuthorization:()=>false,hasLocalStorageAuthorization:()=>false,authorizedCookies:async()=>[{name:'guest_id',value:'visitor',domain:'.x.com',path:'/'}]};
        expect(await readAccountProfile(guest as unknown as SiteSessions,'twitter',new AbortController().signal)).toEqual({state:'missing'});
        const loggedIn={...guest,authorizedCookies:async()=>[{name:'auth_token',value:'auth',domain:'.x.com',path:'/'},{name:'ct0',value:'csrf',domain:'.x.com',path:'/'}]};
        expect(await readAccountProfile(loggedIn as unknown as SiteSessions,'twitter',new AbortController().signal)).toEqual({state:'authenticated',nickname:'x.com',sessionOnly:true});
    });
    it('does not unlock a generic site merely because a visitor cookie exists',async()=>{
        const sessions={hasStoredAuthorization:()=>false,hasLocalStorageAuthorization:()=>false,authorizedCookies:async()=>[{name:'visitor',value:'anonymous'}]};
        expect(await readAccountProfile(sessions as unknown as SiteSessions,'web:example.com',new AbortController().signal)).toEqual({state:'missing'});
    });
    it('reports a manually saved localStorage session honestly without inventing an account nickname',async()=>{
        const sessions={hasStoredAuthorization:()=>true,hasLocalStorageAuthorization:()=>true,authorizedCookies:async()=>[]};
        expect(await readAccountProfile(sessions as unknown as SiteSessions,'web:example.com',new AbortController().signal)).toEqual({state:'authenticated',nickname:'example.com',sessionOnly:true});
    });
    it('does not trust stale Yuanbao local storage without current first-party identity',async()=>{
        const loggedIn={hasStoredAuthorization:()=>true,hasLocalStorageAuthorization:()=>true,authorizedCookies:async()=>[]};
        expect(await readAccountProfile(loggedIn as unknown as SiteSessions,'wechat-channel',new AbortController().signal)).toEqual({state:'unknown'});
        const guest={hasStoredAuthorization:()=>false,hasLocalStorageAuthorization:()=>false,authorizedCookies:async()=>[{name:'hy_user',value:'visitor'}]};
        expect(await readAccountProfile(guest as unknown as SiteSessions,'wechat-channel',new AbortController().signal)).toEqual({state:'missing'});
    });
});
import type {SiteSessions,SiteWindow} from './auth';
describe('current account identity',()=>{
    it('requires authenticated self data and preserves the actual nickname',()=>{
        expect(profileFromResponse('bilibili',{code:0,data:{isLogin:true,mid:42,uname:'当前昵称'}})).toEqual({state:'authenticated',nickname:'当前昵称'});
        expect(profileFromResponse('douyin',{status_code:0,user:{uid:'42',nickname:'抖音昵称'}})).toEqual({state:'authenticated',nickname:'抖音昵称'});
        expect(profileFromResponse('zhihu',{id:'66a9a4185b42b46575dfac91f450c097',url_token:'xiaoqiang',name:'Clip2MD'})).toEqual({state:'authenticated',nickname:'Clip2MD'});
        expect(profileFromResponse('xiaohongshu',{code:0,success:true,data:{guest:false,user_id:'abc123',nickname:'小红书昵称'}})).toEqual({state:'authenticated',nickname:'小红书昵称'});
    });
    it('does not report guests, expired logins, malformed JSON shapes or challenge responses as logged in',()=>{
        expect(profileFromResponse('bilibili',{code:-101,data:{uname:'旧昵称'}}).state).toBe('expired');
        expect(profileFromResponse('bilibili',{code:0,data:{mid:42,uname:'作者昵称'}}).state).toBe('unknown');
        expect(profileFromResponse('xiaohongshu',{code:0,success:true,data:{guest:true,user_id:'guest',nickname:'访客'}}).state).toBe('expired');
        expect(profileFromResponse('douyin',{status_code:0,user:null}).state).toBe('expired');
        expect(profileFromResponse('douyin',{status_code:500,user:{uid:'42',nickname:'旧昵称'}}).state).toBe('unknown');
    });
    it('uses Yuanbao first-party self data and rejects anonymous identities',()=>{
        expect(profileFromResponse('wechat-channel',{data:{id:42,userId:'1780000000000000001',userName:'当前昵称',userType:'wx'}})).toEqual({state:'authenticated',nickname:'当前昵称'});
        expect(profileFromResponse('wechat-channel',{data:{id:42,userId:'1780000000000000001',userName:'匿名',userType:'anon'}})).toEqual({state:'unknown'});
        expect(profileFromResponse('wechat-channel',{data:{id:null,userId:'',userName:'空'}})).toEqual({state:'unknown'});
        expect(selfEndpoint('wechat-channel','https://yuanbao.tencent.com/api/getuserinfo')).toBe(true);
        expect(selfEndpoint('wechat-channel','https://yuanbao.tencent.com.evil.test/api/getuserinfo')).toBe(false);
    });
    it('only accepts known HTTPS self endpoints, never someone else’s public profile',()=>{
        expect(selfEndpoint('douyin','https://www.douyin.com/aweme/v1/web/user/profile/self/')).toBe(true);
        expect(selfEndpoint('douyin','https://www.douyin.com/aweme/v1/web/user/profile/other/')).toBe(false);
        expect(selfEndpoint('zhihu','https://www.zhihu.com/api/v4/me')).toBe(true);
        expect(selfEndpoint('zhihu','https://www.zhihu.com/api/v4/people/other')).toBe(false);
        expect(selfEndpoint('bilibili','https://api.bilibili.com.evil.test/x/web-interface/nav')).toBe(false);
        expect(selfEndpoint('xiaohongshu','http://edith.xiaohongshu.com/api/sns/web/v1/user/selfinfo')).toBe(false);
    });
    it('does not open a window or make a profile request when no login is stored',async()=>{
        const sessions={hasStoredAuthorization:()=>false,authorizedCookies:vi.fn(async()=>[]),open:vi.fn()};
        expect(await readAccountProfile(sessions as unknown as SiteSessions,'bilibili',new AbortController().signal)).toEqual({state:'missing'});
        expect(sessions.open).not.toHaveBeenCalled();
    });
    it('asks for login again when a saved authorization has expired cookies',async()=>{
        const sessions={hasStoredAuthorization:()=>true,authorizedCookies:async()=>[],open:vi.fn()};
        expect(await readAccountProfile(sessions as unknown as SiteSessions,'bilibili',new AbortController().signal)).toEqual({state:'expired'});
        expect(sessions.open).not.toHaveBeenCalled();
    });
    it.each(['immediate','pending'])('starts navigation with %s Network.enable acknowledgement and releases the hidden window',async(ack)=>{
        let listener!:(event:unknown,method:string,params:unknown)=>void;
        const release=vi.fn();
        const window={isDestroyed:()=>false,loadURL:vi.fn(async()=>{
            listener(null,'Network.responseReceived',{requestId:'one',response:{url:'https://api.bilibili.com/x/web-interface/nav',status:200}});
            listener(null,'Network.loadingFinished',{requestId:'one'});
        }),webContents:{debugger:{attach:vi.fn(),detach:vi.fn(),on:(_name:string,fn:typeof listener)=>{listener=fn;},sendCommand:async(command:string)=>command==='Network.getResponseBody'?{body:JSON.stringify({code:0,data:{isLogin:true,mid:42,uname:'Self'}})}:ack==='pending'?new Promise(()=>{}):{}},executeJavaScript:vi.fn(async()=>{})}};
        const sessions={authorizedCookies:async()=>[{name:'SESSDATA',value:'synthetic',domain:'.bilibili.com',path:'/'}],open:async()=>window,release};
        expect(await readAccountProfile(sessions as unknown as SiteSessions,'bilibili',new AbortController().signal)).toEqual({state:'authenticated',nickname:'Self'});
        expect(release).toHaveBeenCalledWith(window);
        expect(window.loadURL).toHaveBeenCalledWith('https://www.bilibili.com/');
        expect(window.webContents.debugger.detach).toHaveBeenCalledOnce();
    });
    it('reads the real Zhihu nickname from /api/v4/me instead of a domain placeholder', async () => {
        let listener!:(event:unknown,method:string,params:unknown)=>void;
        const release=vi.fn();
        const window={isDestroyed:()=>false,loadURL:vi.fn(async()=>{
            listener(null,'Network.responseReceived',{requestId:'zhihu',response:{url:'https://www.zhihu.com/api/v4/me',status:200}});
            listener(null,'Network.loadingFinished',{requestId:'zhihu'});
        }),webContents:{debugger:{attach:vi.fn(),detach:vi.fn(),on:(_name:string,fn:typeof listener)=>{listener=fn;},sendCommand:async(command:string)=>command==='Network.getResponseBody'?{body:JSON.stringify({id:'66a9a4185b42b46575dfac91f450c097',name:'Clip2MD',url_token:'xiaoqiang'})}:{}},executeJavaScript:vi.fn(async()=>{})}};
        const sessions={authorizedCookies:async()=>[{name:'z_c0',value:'synthetic',domain:'.zhihu.com',path:'/'}],open:async()=>window,release};
        expect(await readAccountProfile(sessions as unknown as SiteSessions,'zhihu',new AbortController().signal)).toEqual({state:'authenticated',nickname:'Clip2MD'});
        expect(window.loadURL).toHaveBeenCalledWith('https://www.zhihu.com/');
        expect(release).toHaveBeenCalledWith(window);
    });
    it('checks the Yuanbao first-party identity endpoint when local storage is absent',async()=>{
        let listener!:(event:unknown,method:string,params:unknown)=>void;
        const release=vi.fn();
        const window={isDestroyed:()=>false,loadURL:vi.fn(async()=>{
            listener(null,'Network.responseReceived',{requestId:'yuanbao',response:{url:'https://yuanbao.tencent.com/api/getuserinfo',status:200}});
            listener(null,'Network.loadingFinished',{requestId:'yuanbao'});
        }),webContents:{debugger:{attach:vi.fn(),detach:vi.fn(),on:(_name:string,fn:typeof listener)=>{listener=fn;},sendCommand:async(command:string)=>command==='Network.getResponseBody'?{body:JSON.stringify({data:{id:42,userId:'1780000000000000001',userName:'元宝账号'}})}:{}},executeJavaScript:vi.fn(async()=>{})}};
        const sessions={hasStoredAuthorization:()=>false,hasLocalStorageAuthorization:()=>false,authorizedCookies:async()=>[],open:async()=>window,release};
        expect(await readAccountProfile(sessions as unknown as SiteSessions,'wechat-channel',new AbortController().signal)).toEqual({state:'authenticated',nickname:'元宝账号'});
        expect(window.loadURL).toHaveBeenCalledWith('https://yuanbao.tencent.com/');
        expect(release).toHaveBeenCalledWith(window);
    });
    it.each([
        [401, {}, 'expired'],
        [200, {data:{id:42,userId:'1780000000000000001',userName:'匿名',userType:'anon'}}, 'unknown'],
    ] as const)('does not accept a Yuanbao %s response as a signed-in account',async(status,payload,expected)=>{
        let listener!:(event:unknown,method:string,params:unknown)=>void;
        const release=vi.fn();
        const window={isDestroyed:()=>false,loadURL:vi.fn(async()=>{
            listener(null,'Network.responseReceived',{requestId:'yuanbao',response:{url:'https://yuanbao.tencent.com/api/getuserinfo',status}});
            if(status===200)listener(null,'Network.loadingFinished',{requestId:'yuanbao'});
        }),webContents:{debugger:{attach:vi.fn(),detach:vi.fn(),on:(_name:string,fn:typeof listener)=>{listener=fn;},sendCommand:async(command:string)=>command==='Network.getResponseBody'?{body:JSON.stringify(payload)}:{}},executeJavaScript:vi.fn(async()=>{})}};
        const sessions={hasStoredAuthorization:()=>true,hasLocalStorageAuthorization:()=>true,authorizedCookies:async()=>[],open:async()=>window,release};
        expect(await readAccountProfile(sessions as unknown as SiteSessions,'wechat-channel',new AbortController().signal)).toEqual({state:expected});
        expect(release).toHaveBeenCalledWith(window);
    });
    it('reads rendered nicknames for cookie-authenticated platforms', async () => {
        const release=vi.fn();
        const window={isDestroyed:()=>false,loadURL:vi.fn(async()=>{}),webContents:{executeJavaScript:vi.fn(async()=> '微博真实昵称') ,debugger:{attach:vi.fn(),detach:vi.fn(),on:vi.fn(),sendCommand:vi.fn()}}};
        const sessions={hasStoredAuthorization:()=>true,hasLocalStorageAuthorization:()=>false,authorizedCookies:async()=>[{name:'SUB',value:'session',domain:'.weibo.com',path:'/'}],open:async()=>window,release};
        expect(await readAccountProfile(sessions as unknown as SiteSessions,'weibo',new AbortController().signal)).toEqual({state:'authenticated',nickname:'微博真实昵称',sessionOnly:true});
        expect(window.loadURL).toHaveBeenCalledWith('https://weibo.com/');
        expect(release).toHaveBeenCalledWith(window);
    });
    it('closes a pending profile request on page cancellation',async()=>{
        const controller=new AbortController(),release=vi.fn();
        const window={isDestroyed:()=>false,loadURL:async()=>{controller.abort();},webContents:{debugger:{attach:vi.fn(),detach:vi.fn(),on:vi.fn(),sendCommand:async()=>({})}}} as unknown as SiteWindow;
        const sessions={authorizedCookies:async()=>[{name:'web_session',value:'synthetic',domain:'.xiaohongshu.com',path:'/'}],open:async()=>window,release};
        await readAccountProfile(sessions as unknown as SiteSessions,'xiaohongshu',controller.signal);
        expect(release).toHaveBeenCalledWith(window);
    });
});
