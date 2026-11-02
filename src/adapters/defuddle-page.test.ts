import { describe, expect, it } from 'vitest';
import { defuddlePage, webLoginRequired } from './defuddle-page';
import { ArticleAccessRequired, ArticleBodyUnavailable } from './extract';

const paragraph = '这是可以公开阅读的文章正文，包含完整的内容、示例和足够清楚的说明。'.repeat(12);
const page = (body: string, head = '<title>原文标题</title>') => `<html><head>${head}</head><body>${body}</body></html>`;
const snapshot = (html: string, extra = {}) => ({ url: 'https://example.com/articles/post', html, videos: [], ...extra });

describe('generic Defuddle extraction and login gates', () => {
    it('keeps article, basic metadata, relative images, code and tables without independent extras', () => {
        const result = defuddlePage(snapshot(page(`<nav>导航列表</nav><article><h1>原文标题</h1><p>${paragraph}</p><a href="../other">正文链接</a><img src="/photo.jpg" width="800" height="600"><pre><code class="language-js">const a = 1;</code></pre><table><tr><th>名称</th><th>值</th></tr><tr><td>正文项</td><td>42</td></tr></table></article><aside>侧栏内容</aside><section id="comments">无关评论</section><video src="/video.mp4"></video>`, '<title>原文标题</title><meta name="author" content="原作者"><meta property="article:published_time" content="2026-10-28T08:00:00Z"><meta property="og:image" content="https://example.com/cover.jpg">')));
        expect(result).toMatchObject({title:'原文标题',author:'原作者',source_date:'2026-10-28',image_urls:['https://example.com/photo.jpg']});
        expect(result.markdown).toContain(paragraph);expect(result.markdown).toContain('https://example.com/other');
        expect(result.markdown).toContain('```js');expect(result.markdown).toContain('正文项');
        for (const extra of ['cover.jpg','video.mp4','无关评论','侧栏内容','导航列表']) expect(result.markdown).not.toContain(extra);
        expect(result.metrics).toBeUndefined();expect(result.source_description).toBeUndefined();
    });
    it.each([
        '<header><button>登录</button></header>',
        '<aside><a href="/login">Sign in</a></aside>',
        '<div role="dialog">接受 Cookie <button>同意</button></div>',
        '<form hidden><input type="password"></form>',
        '<div style="display:none"><input type="password"></div>',
    ])('does not mistake an optional login or cookie prompt for an article gate: %s', prefix => {
        expect(defuddlePage(snapshot(page(`${prefix}<article><p>${paragraph}</p></article>`))).markdown).toContain(paragraph);
    });
    it.each([
        page('<form><input type="password"><button>登录</button></form>', '<title>用户登录</title>'),
        page('<main>请先登录后查看完整正文</main>'),
        page('<main>Sign in to continue</main>'),
        page(`<article><p>${paragraph}</p></article><div role="dialog" aria-modal="true">登录后继续阅读<input type="password"></div>`),
    ])('recognizes actual login gates: %s', html => {
        expect(() => defuddlePage(snapshot(html))).toThrow(ArticleAccessRequired);
    });
    it('recognizes a redirect to the login route', () => {
        expect(() => defuddlePage(snapshot(page('<main>扫码登录</main>'), {url:'https://example.com/login?next=/articles/post'}))).toThrow(ArticleAccessRequired);
    });
    it('uses the rendered overlay signal even with a full article behind it', () => {
        expect(() => defuddlePage(snapshot(page(`<article><p>${paragraph}</p></article>`), {webAccess:{loginForm:false,loginOverlay:true}}))).toThrow(ArticleAccessRequired);
    });
    it.each([403,401,500])('does not turn a bare HTTP %s or missing body into a login request', httpStatus => {
        const html = page('<main></main>');
        expect(webLoginRequired(new DOMParser().parseFromString(html,'text/html'), {...snapshot(html),httpStatus})).toBe(false);
        expect(() => defuddlePage(snapshot(html,{httpStatus}))).toThrow(ArticleBodyUnavailable);
    });
    it('ignores login text in scripts and hidden DOM', () => {
        const html = page(`<script>const text='请先登录后查看';</script><div hidden>请先登录后查看</div><article><p>${paragraph}</p></article>`);
        expect(defuddlePage(snapshot(html)).markdown).toContain(paragraph);
    });
    it('keeps readable content available with malformed, oversize or deeply nested JSON-LD',()=>{
        for (const metadata of [' '.repeat(1024*1024+1), 'not JSON', '['.repeat(40)+'{}'+']'.repeat(40), JSON.stringify({description:' '.repeat(16000)})]) {
            expect(defuddlePage(snapshot(page(`<script type="application/ld+json">${metadata}</script><article><p>${paragraph}</p></article>`))).markdown).toContain(paragraph);
        }
    });
});
