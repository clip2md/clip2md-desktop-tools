// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { taobaoPage } from './taobao';
import { ArticleAccessRequired } from './extract';
import type { RenderedSnapshot } from './rendered-sites';

const makeSnapshot = (html: string, url = 'https://item.taobao.com/item.htm?id=123456789'): RenderedSnapshot => ({
  url,
  html,
  videos: [],
});

describe('taobao product detail extraction', () => {
  it('extracts a Taobao product overview, parameters, detail body, and lazy images', () => {
    const result = taobaoPage(makeSnapshot(`
      <title>测试商品</title>
      <h1 class="tb-main-title">测试商品</h1>
      <div class="shop-name">测试旗舰店</div>
      <span class="tb-rmb-num">￥129.00</span>
      <ul class="tb-thumb-list"><li><img data-src="//img.alicdn.com/main.jpg"></li></ul>
      <div class="sku"><span class="selected">黑色 128G</span></div>
      <table id="attributes"><tr><th>品牌</th><td>测试品牌</td></tr></table>
      <div id="description"><p>这是商品详情正文。</p><img data-original="https://img.alicdn.com/detail.jpg"><button>立即购买</button></div>
    `));
    expect(result.content).toMatchObject({ title: '测试商品', source: '淘宝' });
    expect(result.content.markdown).toContain('测试旗舰店');
    expect(result.content.markdown).toContain('￥129.00');
    expect(result.content.markdown).toContain('测试品牌');
    expect(result.content.markdown).toContain('这是商品详情正文');
    expect(result.content.markdown).toContain('https://img.alicdn.com/main.jpg');
    expect(result.content.markdown).toContain('https://img.alicdn.com/detail.jpg');
    expect(result.content.markdown).not.toContain('立即购买');
  });

  it('handles a Tmall detail URL and deduplicates images', () => {
    const result = taobaoPage(makeSnapshot(`
      <title>天猫商品</title><h1>天猫商品</h1>
      <div class="tm-price">299</div>
      <div id="detail"><img src="https://img.alicdn.com/a.jpg"><img data-src="https://img.alicdn.com/a.jpg"></div>
    `, 'https://detail.tmall.com/item.htm?id=987654321'));
    expect(result.content.title).toBe('天猫商品');
    expect(result.content.image_urls).toEqual(['https://img.alicdn.com/a.jpg']);
  });

  it.each([
    '<title>登录</title><body>请登录后查看商品</body>',
    '<title>安全验证</title><input type="password">',
    '<title>访问异常</title><main>验证码中间页</main>',
  ])('rejects login or verification shells', (html) => {
    expect(() => taobaoPage(makeSnapshot(html))).toThrow();
  });

  it('rejects a page without a product title or detail content', () => {
    expect(() => taobaoPage(makeSnapshot('<title>淘宝</title><main>空白</main>'))).toThrow();
  });
});

it('uses modern price and parameter sections without recommendations or hidden login widgets', () => {
  const url = 'https://chaoshi.detail.tmall.com/item.htm?id=123456789&skuId=456';
  const result = taobaoPage(makeSnapshot(`
    <title>天猫精选键盘</title>
    <header>请先登录<span class="tm-price">1元</span></header>
    <div hidden><input type="password"><div class="captcha">验证码</div></div>
    <aside class="recommend"><h1>推荐商品</h1><div class="priceWrap--other">999</div></aside>
    <h1 class="ItemTitle--mainTitle--a">天猫精选键盘</h1>
    <div class="shopHeader--x"><a href="https://shop1.taobao.com">键盘店</a></div>
    <div class="priceWrap--a"><span>活动价</span><span class="symbol--a">￥</span><span class="text--a">129–199</span><del class="subPrice--a">原价 299</del></div>
    <div class="sku--root"><span aria-checked="true">黑色</span><span class="selected">标准版</span><span class="unselected">白色</span></div>
    <div class="generalParamsInfoItem--a"><span class="generalParamsInfoItemTitle--a">品牌</span><span class="generalParamsInfoItemSubTitle--a">测试牌</span></div>
    <div class="Gallery--a"><img src="/main.jpg"></div>
    <div id="description"><p>介绍价格区间</p><img src="data:image/gif;base64,AA" data-src="//img.alicdn.com/detail.jpg"><div class="review">不要保存此评价</div><button>立即购买</button></div>
  `, url), url);
  expect(result.content).toMatchObject({title:'天猫精选键盘',source:'天猫'});
  expect(result.content.markdown).toContain('129–199');
  expect(result.content.markdown).toContain('原价 299');
  expect(result.content.markdown).toContain('黑色 / 标准版');
  expect(result.content.markdown).toContain('测试牌');
  expect(result.content.markdown).not.toMatch(/推荐商品|999|不要保存此评价|立即购买|白色|请先登录/);
  expect(result.content.image_urls).toEqual(['https://chaoshi.detail.tmall.com/main.jpg','https://img.alicdn.com/detail.jpg']);
});

it('preserves image-only details, relative sources and one reference per duplicate image', () => {
  const result = taobaoPage(makeSnapshot('<h1>商品</h1><div id="description"><img data-original="/detail.jpg"><img src="/detail.jpg"><img src="javascript:alert(1)"></div>'), 'https://item.taobao.com/item.htm?id=123456789');
  expect(result.content.markdown.match(/!\[.*?\]\(https:\/\/item.taobao.com\/detail.jpg\)/g)).toHaveLength(1);
  expect(result.content.markdown).not.toContain('javascript');
});

it.each([401,403,429])('reports HTTP %s as an authorization challenge even with stale product content', status => {
  const snapshot = {...makeSnapshot('<h1>商品</h1><div id="description">缓存正文</div>'),httpStatus:status};
  expect(() => taobaoPage(snapshot,snapshot.url)).toThrow(ArticleAccessRequired);
});

it('does not interpret ordinary login words within a product description as an authentication gate', () => {
  const snapshot = makeSnapshot('<title>安全验证器</title><h1>硬件安全验证器</h1><div id="description">通过验证码进行登录：这是一段商品介绍。</div>');
  // Product titles are not an access verdict when the page contains real product content.
  snapshot.html = snapshot.html.replace('<title>安全验证器</title>', '<title>硬件安全验证器</title>');
  expect(taobaoPage(snapshot,snapshot.url).content.markdown).toContain('商品介绍');
});

it('rejects another item, a bare heading and unidentified price-only shells', () => {
  const url = 'https://item.taobao.com/item.htm?id=123456789';
  expect(() => taobaoPage(makeSnapshot('<h1>商品</h1><div id="description">其他商品详情</div>',url.replace('123456789','999')),url)).toThrow('同一商品');
  expect(() => taobaoPage(makeSnapshot('<h1>商品</h1>'),url)).toThrow('未取得');
  expect(() => taobaoPage(makeSnapshot('<span class="tm-price">12</span>'),url)).toThrow('标题');
});

it('omits unrecognized font prices rather than inventing numeric prices', () => {
  const snapshot = makeSnapshot('<h1>商品</h1><span class="tm-price">￥&#xe001;&#xe002;</span><div id="description">详情正文</div>');
  const result = taobaoPage(snapshot,snapshot.url);
  expect(result.content.warnings?.[0]).toContain('字体字符');
  expect(result.content.markdown).not.toContain('当前显示价格');
});
