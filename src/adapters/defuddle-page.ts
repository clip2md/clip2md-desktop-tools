/** Generic pages have one local extraction path and no media/metrics fallback. */
import Defuddle from 'defuddle';
import { ArticleAccessRequired, ArticleBodyUnavailable, assertReadableBody, publicationDate, htmlToMarkdown, type ExtractedContent } from './extract';
import type { RenderedSnapshot } from './rendered-sites';

const loginRoute = /\/(?:login|signin|sign-in|passport|sso|auth)(?:\/|$)/i;
const loginDemand = /(?:请先?登录|登录后(?:查看|阅读|继续|访问|解锁)|登录(?:以|即可)(?:查看|阅读|继续|访问)|sign\s*in\s+to\s+(?:continue|read|view|access)|log\s*in\s+to\s+(?:continue|read|view|access)|authentication\s+required)/i;
const loginTitle = /^(?:登录|用户登录|账号登录|账户登录|sign\s*in|log\s*in)(?:\s*[-|·—].*)?$/i;

/** A login button or an HTTP error alone is never proof that content is gated. */
export function webLoginRequired(document: Document, snapshot: Pick<RenderedSnapshot, 'url' | 'httpStatus' | 'webAccess'>): boolean {
    const visible = document.body.cloneNode(true) as HTMLElement;
    visible.querySelectorAll('script,style,noscript,[hidden],[aria-hidden="true"],[style*="display:none"],[style*="display: none"],[style*="visibility:hidden"],[style*="visibility: hidden"]').forEach(node => node.remove());
    const text = visible.textContent?.replace(/\s+/g, ' ').trim() || '';
    const article = (visible.querySelector('article,main,[role="main"]') || visible).cloneNode(true) as HTMLElement;
    article.querySelectorAll('form,[role="dialog"],dialog,nav,header,footer,aside').forEach(node => node.remove());
    const bodyText = article.textContent?.replace(/\s+/g, ' ').trim() || '';
    const readable = bodyText.length >= 30 && !loginDemand.test(bodyText.slice(0, 240));
    const form = snapshot.webAccess?.loginForm ?? !!visible.querySelector('input[type="password"]');
    const overlay = snapshot.webAccess?.loginOverlay ?? Array.from(visible.querySelectorAll('[role="dialog"],dialog,[aria-modal="true"],[style*="position:fixed"],[style*="position: fixed"]'))
        .some(node => loginDemand.test(node.textContent || '') || (form && !!node.querySelector('input[type="password"]')));
    if (overlay) return true;
    if (readable) return false;
    const route = loginRoute.test(new URL(snapshot.url).pathname);
    return loginTitle.test(document.title.trim()) || form ||
        (loginDemand.test(text) && (text.length < 1500 || snapshot.httpStatus === 401 || route)) ||
        (route && (snapshot.httpStatus === 401 || text.length < 600));
}

export function defuddlePage(snapshot: RenderedSnapshot): ExtractedContent {
    const document = new DOMParser().parseFromString(snapshot.html, 'text/html');
    if (webLoginRequired(document, snapshot))
        throw new ArticleAccessRequired('正文被原站登录拦截，请完成登录后继续剪藏');
    if (snapshot.httpStatus && snapshot.httpStatus >= 400)
        throw new ArticleBodyUnavailable(`原站返回 HTTP ${snapshot.httpStatus}，未取得正文`);
    document.querySelectorAll('base').forEach(node => node.remove());
    const base = document.createElement('base');
    base.href = snapshot.url;
    document.head.prepend(base);
    // Defuddle's comment-cleanup regexp can take quadratic time on large
    // whitespace-only JSON-LD. Feed it bounded, valid, canonical JSON instead.
    for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
        try {
            const raw = script.textContent || '';
            if (raw.length > 64 * 1024) throw new Error('Oversize JSON-LD');
            const value: unknown = JSON.parse(raw);
            const pending = [{value, depth:0}];
            let visited = 0;
            while (pending.length) {
                const item = pending.pop()!;
                if (++visited > 4096 || item.depth > 32) throw new Error('Complex JSON-LD');
                if (typeof item.value === 'string' && (item.value.length > 8192 || /\s{256}/.test(item.value))) throw new Error('Oversize JSON-LD value');
                if (item.value && typeof item.value === 'object')
                    for (const child of Object.values(item.value)) pending.push({value:child,depth:item.depth+1});
            }
            script.textContent = JSON.stringify(value);
        } catch { script.remove(); }
    }
    const result = new Defuddle(document, { url: snapshot.url, useAsync: false, includeReplies: false }).parse();
    const content = new DOMParser().parseFromString(result.content || '', 'text/html');
    // Media embeds are not part of the generic article capability.
    content.querySelectorAll('video,audio,iframe,embed,object,script,style').forEach(node => node.remove());
    const markdown = htmlToMarkdown(content.body.innerHTML, snapshot.url).trim();
    const text = content.body.textContent?.trim() || '';
    if (text.length < 200 && /^(?:(?:please\s+)?(?:enable|turn on)\s+javascript|you need to enable javascript|loading\b|please wait\b|正在加载|加载中|请稍候)/i.test(text))
        throw new ArticleBodyUnavailable('来源尚未加载正文，请稍后重试');
    if ((!text || text === result.title || text.length < 10) && !content.querySelector('img[src]'))
        throw new ArticleBodyUnavailable('Defuddle 未取得有效正文，请确认页面已加载后重试');
    if (!markdown) throw new ArticleBodyUnavailable('Defuddle 未取得有效正文');
    assertReadableBody(markdown, result.title || '');
    const images = [...new Set(Array.from(content.querySelectorAll('img[src]')).flatMap(node => {
        try {
            const url = new URL(node.getAttribute('src')!, snapshot.url);
            return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? [url.href] : [];
        } catch { return []; }
    }))];
    return {
        title: result.title || '', source_title: result.title || undefined, markdown,
        author: result.author || undefined, source_date: publicationDate(result.published || ''),
        ...(images.length ? { image_urls: images } : {}),
    };
}
