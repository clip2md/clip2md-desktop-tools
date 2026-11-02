import { expect, it, vi } from 'vitest';
import { resolveTaobaoProduct } from './taobao-link';
import { platformFor } from '../config';
const share='https://e.tb.cn/h.example?tk=sample';
const signal=()=>new AbortController().signal;

it('resolves the literal mobile product target from a Taobao share page',async()=>{
  const read=vi.fn(async()=>({url:share,html:`<script>var url = 'https://pages-g.m.taobao.com/wow/z/app/detail-next/item/index?x-ssr=true&id=1069250507442&tk=private';</script>`}));
  expect(platformFor(share)).toBe('taobao');
  expect(await resolveTaobaoProduct(share,signal(),read)).toBe('https://item.taobao.com/item.htm?id=1069250507442');
  expect(read).toHaveBeenCalledOnce();
});
it('preserves direct item and selected SKU URLs and follows verified direct redirects',async()=>{
  const read=vi.fn(async()=>({url:'https://detail.tmall.com/item.htm?id=123&spm=tracking',html:''}));
  const direct='https://item.taobao.com/item.htm?id=123&skuId=456';
  expect(await resolveTaobaoProduct(direct,signal(),read)).toBe(direct);expect(read).not.toHaveBeenCalled();
  expect(await resolveTaobaoProduct(share,signal(),read)).toBe('https://detail.tmall.com/item.htm?id=123');
});
it.each([
 `<script>var url = 'https://pages-g.m.taobao.com.evil.test/wow/z/app/detail-next/item/index?id=123';</script>`,
 `<script>var url = 'https://attacker@item.taobao.com/item.htm?id=123';</script>`,
 `<script>var url = 'https://item.taobao.com/item.htm?id=123&id=456';</script>`,
 `<script>var other = 'https://item.taobao.com/item.htm?id=123';</script>`,
 `<script>var url = 'https://item.taobao.com/item.htm?id=123' + attack;</script>`,
 `<a href="https://item.taobao.com/item.htm?id=123">a</a><a href="https://item.taobao.com/item.htm?id=456">b</a>`,
])('rejects ambiguous or untrusted literal targets',async html=>{
 await expect(resolveTaobaoProduct(share,signal(),async()=>({url:share,html}))).rejects.toThrow('商品');
});
it('rejects a short link lookalike before requesting it',async()=>{
 const read=vi.fn();
 await expect(resolveTaobaoProduct('https://e.tb.cn.evil.test/h.example',signal(),read)).rejects.toThrow();
 expect(read).not.toHaveBeenCalled();
});
