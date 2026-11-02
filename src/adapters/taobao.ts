/** DOM-only product capture. No API replay, credentials, or page globals. */
import { htmlToMarkdown, ArticleAccessRequired, ArticleBodyUnavailable } from './extract';
import { taobaoItemId } from '../config';
import type { RenderedSnapshot } from './rendered-sites';
import type { SiteResult } from './sites';

const EXCLUDED = 'nav,header,footer,aside,form,button,input,select,textarea,script,style,noscript,[role="dialog"],[role="button"],[hidden],[aria-hidden="true"],[class*="recommend" i],[class*="comment" i],.review,.reviews,[class*="Reviews--"],[class*="reviewList"],#J_Reviews';
const TITLES = ['[class*="mainTitle--"]', '.tb-main-title', '.tb-detail-hd h1', 'h1'];
const DETAILS = ['#description', '#J_DivItemDesc', '#J_DivItemDescContainer', '[class*="descV8-container"]', '[class*="descContent"]', '[class*="detailDesc"]', '.tb-detail-bd', '#detail'];
const GALLERIES = '.tb-thumb-list,#J_UlThumb,.tb-gallery,[class*="Gallery"],[class*="gallery"]';
const PARAMETERS = '#attributes,#J_AttrUL,.attributes,.attributes-list,[class*="ParamsInfo"],[class*="paramsInfo"],[class*="BasicContent--root"]';

function plain(node: Element | null | undefined): string {
  return (node?.textContent || '').replace(/\s+/g, ' ').trim();
}

function first(root: ParentNode, selectors: string[]): Element | undefined {
  for (const selector of selectors) {
    const node = root.querySelector(selector);
    if (node && plain(node)) return node;
  }
}

function address(value: string | null, base: string): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value.trim(), base);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* Try the next source attribute. */ }
}

function cell(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replace(/[\\|`*_[\]<>]/g, '\\$&');
}

function parameters(document: Document, detail: Element | undefined): Array<[string, string]> {
  const rows = new Map<string, string>();
  const add = (key: string, value: string) => {
    if (key && value && rows.size < 80) rows.set(key.replace(/[：:]$/, ''), value);
  };
  const roots = [...Array.from(document.querySelectorAll(PARAMETERS)), ...(detail ? [detail] : [])];
  for (const root of roots) {
    for (const row of Array.from(root.querySelectorAll('tr'))) {
      const cells = Array.from(row.querySelectorAll('th,td')).map(plain);
      if (cells.length >= 2) add(cells[0], cells.slice(1).join(' / '));
    }
    for (const row of Array.from(root.querySelectorAll('dl'))) add(plain(row.querySelector('dt')), plain(row.querySelector('dd')));
    for (const row of Array.from(root.querySelectorAll('li'))) {
      const match = plain(row).match(/^([^：:]{1,60})[：:]\s*(.+)$/);
      if (match) add(match[1].trim(), match[2]);
    }
  }
  for (const prefix of ['general', 'emphasis']) {
    const keys = document.querySelectorAll(`[class*="${prefix}ParamsInfoItemTitle--"]`);
    const values = document.querySelectorAll(`[class*="${prefix}ParamsInfoItemSubTitle--"]`);
    keys.forEach((key, index) => {
      const value = values[index];
      if (prefix === 'emphasis') add(plain(value), plain(key));
      else add(plain(key), plain(value));
    });
  }
  return [...rows];
}

export function taobaoPage(snapshot: RenderedSnapshot, requested: string = snapshot.url): SiteResult {
  const id = taobaoItemId(requested);
  if (!id) throw new Error('请使用包含商品 ID 的 HTTPS 淘宝/天猫电脑端商品详情链接');
  const document = new DOMParser().parseFromString(snapshot.html, 'text/html');
  document.querySelectorAll('[hidden],[aria-hidden="true"],[style*="display:none"],[style*="display: none"],[style*="visibility:hidden"],[style*="visibility: hidden"],script,style,noscript').forEach(node => node.remove());
  const title = document.title.trim();
  const blocked = snapshot.httpStatus === 401 || snapshot.httpStatus === 403 || snapshot.httpStatus === 429
    || snapshot.webAccess?.loginOverlay
    || /^(?:淘宝网?\s*[-—|]\s*)?(?:登录|安全验证|访问验证|访问异常|验证码|滑块验证|请完成验证|人机验证|access denied|captcha|sign in)(?:\s*[-—|].*)?$/i.test(title)
    || document.querySelector('#nc_1_wrapper,#nc_1_n1z,.nc-container,[id*="captcha" i],[class*="captcha" i],iframe[src*="captcha" i],iframe[src*="login.taobao.com"],input[type="password"]');
  const ownTitle = plain(first(document, TITLES));
  const body = plain(document.body);
  if (blocked || (!ownTitle && /(?:请先?登录|登录后查看|请完成验证|拖动滑块|访问异常|安全验证|验证码)/.test(body.slice(0, 1000))))
    throw new ArticleAccessRequired('淘宝/天猫需要原站登录或安全验证，请在原站窗口人工完成后重试');
  if (taobaoItemId(snapshot.url) !== id)
    throw new Error('淘宝/天猫页面已跳转，未取得同一商品的详情');

  document.querySelectorAll(EXCLUDED).forEach(node => node.remove());
  const detail = DETAILS.map(selector => document.querySelector(selector)).find((node): node is Element => !!node);
  const productTitle = plain(first(document, TITLES))
    || (detail ? document.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim() : '');
  if (!productTitle || /^(?:淘宝网?|天猫|商品详情|请稍候|加载中)(?:\s*[-—|].*)?$/.test(productTitle))
    throw new ArticleBodyUnavailable('尚未取得淘宝/天猫商品标题，请确认详情页已加载');

  const rows: Array<[string, string]> = [['商品 ID', id]];
  const shop = plain(first(document, ['[class*="shopHeader--"] a[href*="taobao.com"]', '[class*="shopHeader--"] a[href*="tmall.com"]', '.shop-name', '.slogo a', '.tb-shop-name a', '[class*="shopName--"]']));
  if (shop) rows.push(['店铺', shop]);
  const priceNode = first(document, ['[class*="priceWrap--"]', '#J_PromoPrice', '.tm-promo-price', '.tm-price-panel .tm-price', '#J_StrPrice', '.tb-property .tb-rmb-num', '.tb-rmb-num', '.tm-price']);
  let price = '';
  if (priceNode) {
    const copy = priceNode.cloneNode(true) as Element;
    copy.querySelectorAll('del,s,[class*="subPrice--"],[class*="originalPrice"],.tm-original-price').forEach(node => node.remove());
    price = plain(copy);
  }
  const warnings: string[] = [];
  if (price && /[\uE000-\uF8FF]/.test(price)) warnings.push('页面价格含无法识别的字体字符，请从原文核对价格');
  else if (/\d/.test(price)) rows.push(['当前显示价格', price]);
  const original = plain(first(document, ['[class*="priceWrap--"] [class*="subPrice--"]', '#J_StrPrice del', '.tm-original-price']));
  if (original && !/[\uE000-\uF8FF]/.test(original)) rows.push(['页面原价', original]);
  const promotion = plain(first(document, ['[class*="priceWrap--"] [class*="tip"]', '[class*="promotionText--"]', '.tb-promo-type', '.tm-promo-type']));
  if (promotion && !price.includes(promotion)) rows.push(['优惠提示', promotion]);
  const selected = [...new Set(Array.from(document.querySelectorAll('.tb-sku .tb-selected,.tb-sku [aria-checked="true"],[class*="sku" i] [aria-checked="true"],[class*="sku" i] [class*="isSelected"],[class*="sku" i] [class~="selected"],[class*="sku" i] [class*="--selected"],[class*="valueItem--"][class*="isSelected"]')).map(plain).filter(Boolean))];
  if (selected.length) rows.push(['当前规格', selected.join(' / ')]);
  const attrs = parameters(document, detail);
  rows.push(...attrs);

  const roots = [...Array.from(document.querySelectorAll(GALLERIES)), ...(detail ? [detail] : [])];
  const images: string[] = [];
  const visited = new Set<Element>();
  for (const root of roots) {
    for (const image of Array.from(root.querySelectorAll('img'))) {
      if (visited.has(image)) continue;
      visited.add(image);
      let src: string | undefined;
      for (const attr of ['data-src', 'data-original', 'data-lazy-src', 'data-ks-lazyload', 'src']) {
        src = address(image.getAttribute(attr), snapshot.url);
        if (src) break;
      }
      if (!src || images.includes(src)) { image.remove(); continue; }
      image.setAttribute('src', src);
      if (!images.includes(src) && images.length < 100) images.push(src);
    }
  }
  const detailMarkdown = detail ? htmlToMarkdown(detail.innerHTML, snapshot.url).trim() : '';
  const usablePrice = /\d/.test(price) && !/[\uE000-\uF8FF]/.test(price);
  if (!detailMarkdown && !images.length && !usablePrice && !attrs.length && !selected.length)
    throw new ArticleBodyUnavailable('未取得淘宝/天猫商品内容，请等待详情加载后重试');
  const overview = `## 商品信息\n\n| 项目 | 内容 |\n| --- | --- |\n${rows.map(([key, value]) => `| ${cell(key)} | ${cell(value)} |`).join('\n')}`;
  const gallery = images.filter(src => !detailMarkdown.includes(src)).map(src => `![](${src})`).join('\n\n');
  return { content: {
    title: productTitle,
    source_title: productTitle,
    source: snapshot.url.includes('.tmall.com/') ? '天猫' : '淘宝',
    markdown: [overview, gallery, detailMarkdown ? `## 商品详情\n\n${detailMarkdown}` : '', ...warnings.map(warning => `> ${warning}`)].filter(Boolean).join('\n\n'),
    ...(images.length ? { image_urls: images } : {}),
    ...(warnings.length ? { warnings } : {}),
  } };
}
