import { describe, expect, it } from 'vitest';
import { FEATURES, PLATFORMS, LOGIN_ORIGINS, loginDomains, loginFor, loginOrigin, normalizeSettings, normalizeWebDomain, platformFor, supportsFeature, validPreferences } from './config';

describe('platforms and domain-scoped authorization', () => {
    it.each([
        ['https://blog.csdn.net/a/article/details/1','csdn'], ['https://zhuanlan.zhihu.com/p/1','zhihu'],
        ['https://www.douban.com/note/1','douban'], ['https://weibo.cn/123/abc','weibo'],
        ['https://youtu.be/abc','youtube'], ['https://x.com/user/status/1','twitter'],
        ['https://www.kuaishou.com/short-video/1','kuaishou'], ['https://www.toutiao.com/article/1','toutiao'],
        ['https://mp.weixin.qq.com/s/abc','wechat'],['https://b23.tv/test','bilibili'],
        ['https://weixin.qq.com/sph/AEnuRCNZHg','wechat-channel'],['https://channels.weixin.qq.com/finder-preview/pages/sph?id=AEnuRCNZHg','wechat-channel'],
        ['https://v.douyin.com/abc','douyin'],['https://xhslink.cn/abc','xiaohongshu'],
        ['https://www.lizhi.fm/123/1','lizhi'], ['https://podcasts.apple.com/us/podcast/test/id123?i=456','applepodcasts'],
    ])('recognizes %s as %s', (url, platform) => expect(platformFor(url)).toBe(platform));
    it('provides the same feature fields and a login origin for every named platform', () => {
        const settings=normalizeSettings({platforms:{bilibili:{metadata:true}}});
        for(const platform of PLATFORMS){
            expect(Object.keys(settings.platforms[platform])).toEqual([...FEATURES]);
            if(platform!=='web')expect(new URL(LOGIN_ORIGINS[platform]).protocol).toBe('https:');
        }
        expect(settings.platforms.bilibili.metadata).toBe(true);
    });
    it('keeps podcast platforms audio-first and disables unsupported comment collection', () => {
        expect(supportsFeature('lizhi', 'video')).toBe(true);
        expect(supportsFeature('lizhi', 'comments')).toBe(false);
        expect(supportsFeature('wechat-channel', 'video')).toBe(true);
        expect(supportsFeature('wechat-channel', 'comments')).toBe(false);
        expect(supportsFeature('applepodcasts', 'subtitles')).toBe(true);
        expect(supportsFeature('applepodcasts', 'comments')).toBe(false);
    });
    it('uses the C-end WeChat article route for local capture login',()=>{
        expect(loginOrigin('wechat')).toBe('https://mp.weixin.qq.com/s/');
    });
    it('uses an independent WeChat Channels authorization origin',()=>{
        expect(loginFor('https://channels.weixin.qq.com/finder-preview/pages/sph?id=AEnuRCNZHg')).toBe('wechat-channel');
        expect(loginOrigin('wechat-channel')).toBe('https://yuanbao.tencent.com/');
        expect(loginDomains('wechat-channel')).toContain('yuanbao.tencent.com');
        expect(loginDomains('wechat-channel')).toContain('channels.weixin.qq.com');
    });
    it('uses the first-party login applications for Xiaoyuzhou and Lizhi',()=>{
        expect(loginOrigin('xiaoyuzhou')).toBe('https://accounts.xiaoyuzhoufm.com/login');
        expect(loginDomains('xiaoyuzhou')).toContain('accounts.xiaoyuzhoufm.com');
        expect(loginOrigin('lizhi')).toBe('https://nj.lizhi.fm/static/login/#/taco/redirect');
        expect(loginDomains('lizhi')).toContain('lizhifm.com');
    });
    it('allows the first-party login and token domains for Kuaishou and Apple Podcasts',()=>{
        expect(loginOrigin('kuaishou')).toBe('https://passport.kuaishou.com/pc/account/login');
        expect(loginDomains('kuaishou')).toContain('passport.kuaishou.com');
        expect(loginDomains('applepodcasts')).toContain('apple.com');
    });
    it('normalizes websites to domains and picks the most specific configured domain',()=>{
        expect(normalizeWebDomain('https://Example.com/article?id=1')).toBe('example.com');
        expect(loginFor('https://news.example.com/post',['example.com','news.example.com'])).toBe('web:news.example.com');
        expect(loginFor('https://sub.example.com/post',['example.com'])).toBe('web:example.com');
        expect(loginOrigin('web:example.com')).toBe('https://example.com/');
        expect(loginDomains('web:example.com')).toEqual(['example.com']);
        expect(normalizeSettings({webDomains:['example.com','https://example.com/path','bad']} ).webDomains).toEqual(['example.com']);
    });
    it.each(['http://example.com','https://user:pass@example.com','https://example.com:8080','127.0.0.1','localhost','file:///tmp'])('rejects invalid login domain %s',value=>expect(normalizeWebDomain(value)).toBe(''));
    it('rejects malformed domain preferences instead of erasing valid login configuration',()=>{
        expect(validPreferences({webDomains:['example.com']})).toBe(true);
        expect(validPreferences({webDomains:['http://example.com']})).toBe(false);
        expect(validPreferences({webDomains:'example.com'})).toBe(false);
    });
});
