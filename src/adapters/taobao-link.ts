import { taobaoItemId } from '../config';
import { readWebPageResult } from './network';

function productAddress(value: string): string | undefined {
  try {
    const url = new URL(value.replace(/&amp;/g, '&').replace(/\\\//g, '/'));
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return;
    const desktop = taobaoItemId(url.href);
    const mobile = (['a.m.taobao.com', 'h5.m.taobao.com', 'pages-g.m.taobao.com'].includes(url.hostname)
      && /^(?:\/i\d+\.htm|\/awp\/core\/detail\.htm|\/wow\/z\/app\/detail-next\/item\/index)$/.test(url.pathname));
    const id = desktop || (mobile ? url.searchParams.get('id') || url.pathname.match(/^\/i([1-9]\d*)\.htm$/)?.[1] : undefined);
    if (!id || !/^[1-9]\d{0,29}$/.test(id) || url.searchParams.getAll('id').length > 1) return;
    // Keep only the product identity; attribution/login tokens are not needed.
    const host = url.hostname.endsWith('.tmall.com') ? 'detail.tmall.com' : 'item.taobao.com';
    return `https://${host}/item.htm?id=${id}`;
  } catch { return; }
}

/** Read a first-party share page's literal target, without executing scripts. */
export async function resolveTaobaoProduct(
  value: string,
  signal: AbortSignal,
  read?: typeof readWebPageResult,
): Promise<string> {
  if (taobaoItemId(value)) return value;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !['e.tb.cn', 'm.tb.cn'].includes(url.hostname) || !/^\/h\.[a-zA-Z0-9]+\/?$/.test(url.pathname))
    throw new Error('请使用淘宝/天猫商品详情链接或淘宝分享短链接');
  const page = await (read || readWebPageResult)(value, AbortSignal.any([signal, AbortSignal.timeout(15000)]));
  signal.throwIfAborted();
  const final = productAddress(page.url);
  if (final) return final;
  const host = new URL(page.url).hostname;
  if (!['e.tb.cn', 'm.tb.cn'].includes(host) || page.html.length > 512 * 1024)
    throw new Error('淘宝分享短链接未返回可核验的商品地址');
  const document = new DOMParser().parseFromString(page.html, 'text/html');
  const values = Array.from(document.querySelectorAll('a[href],meta[http-equiv="refresh"]'))
    .map(node => node.getAttribute('href') || node.getAttribute('content')?.match(/url\s*=\s*(.+)$/i)?.[1] || '');
  // The share page uses `var url = 'https://pages-g.m.taobao.com/...&id=...'`.
  // Read only this literal; ignore executable expressions and other variables.
  for (const script of Array.from(document.scripts)) {
    const source = script.textContent || '';
    for (const match of source.matchAll(/\b(?:var|let|const)\s+url\s*=\s*(['"])(https:[^'"\r\n]{1,8192})\1\s*;/g)) values.push(match[2]);
  }
  const products = [...new Set(values.map(productAddress).filter((value): value is string => !!value))];
  if (products.length !== 1) throw new Error('淘宝分享短链接未返回唯一商品，请复制商品详情页链接重试');
  return products[0];
}
