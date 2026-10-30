import { beforeEach, describe, expect, it, vi } from 'vitest';
const collectMock = vi.hoisted(() => vi.fn());
const profileMock = vi.hoisted(() => vi.fn());
vi.mock('./collector', () => ({ collect: collectMock }));
vi.mock('./account-profile', () => ({ readAccountProfile: profileMock }));
import DesktopTools from './main';
import { normalizeSettings } from './config';

const scope = 'a'.repeat(64);
const context = { bindingScope: scope, taskId: 42, sourceUrl: 'https://www.bilibili.com/video/BV1234567890', revision: '1:1' };
function fixture() {
    const p = new DesktopTools();
    Object.assign(p, { manuallyEnabled: true, bridge: { bindingScope: async () => scope },
        settings: normalizeSettings({ platforms: { bilibili: { metadata: true, images: true, video: true, comments: true } } }),
        readValues: vi.fn(async () => ({})), writeValues: vi.fn(async () => {}), updateStatus: vi.fn(),
        sessions: { cookieLoginProfile: vi.fn(async () => undefined) }, store: {} });
    return p;
}
beforeEach(() => {
    profileMock.mockReset().mockResolvedValue({state:'authenticated',nickname:'已登录'});
    collectMock.mockReset().mockImplementation(async (_context, feature) => ({ properties: {},
        assets: feature === 'images' ? ['素材/封面.png', '素材/原图.webp', '素材/封面.png'] : feature === 'video' ? ['素材/视频.mp4', '素材/音频.m4a'] : ['素材/评论.md'], body: '' }));
});

describe('body media template collection', () => {
    it.each(['https://blog.csdn.net/a/article/details/1','https://www.zhihu.com/question/1','https://www.douban.com/note/1','https://mp.weixin.qq.com/s/a','https://weibo.com/u/a','https://www.youtube.com/watch?v=a','https://x.com/u/status/1','https://www.kuaishou.com/short-video/1','https://www.toutiao.com/article/1'])('requires login before collecting any fields from %s',async sourceUrl=>{
        const p=fixture();profileMock.mockResolvedValue({state:'missing'});
        await expect(p['collectTemplateValues']({...context,sourceUrl},['local_author'],new AbortController().signal)).rejects.toThrow('完成原站登录');
        expect(collectMock).not.toHaveBeenCalled();
    });
    it('requires a configured generic domain before collecting its fields',async()=>{
        const p=fixture();
        await expect(p['collectTemplateValues']({...context,sourceUrl:'https://example.com/private'},['local_author'],new AbortController().signal)).rejects.toThrow('添加该域名');
        expect(collectMock).not.toHaveBeenCalled();
    });
    it('does not put an article fallback into the playable-media field',async()=>{
        const p=fixture();collectMock.mockResolvedValue({properties:{},assets:['资料/正文.md'],body:'正文图文'});
        const values=await p['collectTemplateValues'](context,['local_media'],new AbortController().signal);
        expect(values.local_media).toEqual([]);
    });
    it('refuses all template collection before login is verified',async()=>{
        const p=fixture();profileMock.mockResolvedValue({state:'missing'});
        await expect(p['collectTemplateValues'](context,['local_media'],new AbortController().signal)).rejects.toThrow('完成原站登录');
        expect(collectMock).not.toHaveBeenCalled();
        expect(p['writeValues']).not.toHaveBeenCalled();
    });
    it('passes the actual main-note folder to material storage, including before first sync',async()=>{
        const p=fixture();
        await p['collectTemplateValues']({...context,targetFolder:'剪藏/博主'},['local_media'],new AbortController().signal);
        expect(collectMock.mock.calls[0][0].notePath).toBe('剪藏/博主/42.md');
        Object.assign(p['bridge']!,{resolveTask:async()=>({...context,notePath:'移动目录/正文.md'})});
        await p['collectTemplateValues']({...context,targetFolder:'剪藏/博主'},['local_media'],new AbortController().signal);
        expect(collectMock.mock.calls[1][0].notePath).toBe('移动目录/正文.md');
    });
    it('collects images once for cover and gallery without unrelated downloads', async () => {
        const p = fixture();
        const values = await p['collectTemplateValues'](context, ['local_cover', 'local_gallery'], new AbortController().signal);
        expect(collectMock).toHaveBeenCalledOnce();
        expect(collectMock.mock.calls[0][1]).toBe('images');
        expect(values.local_cover).toBe('素材/封面.png');
        expect(values.local_gallery).toEqual(['素材/封面.png', '素材/原图.webp']);
        expect(p['writeValues']).toHaveBeenCalledWith(context, values);
    });
    it('collects only video/audio for the player field and retains cached text', async () => {
        const p = fixture();
        vi.mocked(p['readValues']).mockResolvedValue({ local_transcript: '已转写正文' });
        const values = await p['collectTemplateValues'](context, ['local_media'], new AbortController().signal);
        expect(collectMock).toHaveBeenCalledOnce();
        expect(collectMock.mock.calls[0][1]).toBe('video');
        expect(values.local_media).toEqual(['素材/视频.mp4', '素材/音频.m4a']);
        expect(values.local_transcript).toBe('已转写正文');
    });
    it('leaves media absent when the platform download option is disabled', async () => {
        const p = fixture(); p.settings.platforms.bilibili.video = false;
        const values = await p['collectTemplateValues'](context, ['local_media'], new AbortController().signal);
        expect(collectMock).not.toHaveBeenCalled();
        expect(values.local_media).toBeUndefined();
    });
});
