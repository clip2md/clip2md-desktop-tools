// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { taobaoLoadStep } from './taobao-page';

afterEach(()=>{document.head.innerHTML='';document.body.innerHTML='';vi.restoreAllMocks();});

it('waits for the product heading and scrolls only the detail region',()=>{
  document.body.innerHTML='<div id="description">详情<img src="/image.jpg"></div><section class="reviews">评论</section>';
  const scroll=vi.spyOn(window,'scrollTo').mockImplementation(()=>{});
  expect(taobaoLoadStep(true).ready).toBe(false);
  expect(scroll).not.toHaveBeenCalled();
  document.body.insertAdjacentHTML('afterbegin','<h1>商品标题</h1>');
  vi.spyOn(document.querySelector('#description')!,'getBoundingClientRect').mockReturnValue({top:2000,bottom:6000} as DOMRect);
  const result=taobaoLoadStep(true);
  expect(result).toMatchObject({ready:true,blocked:false});
  expect(scroll).toHaveBeenCalledWith(0,1900);
});

it('keeps a visible challenge for the user, ignoring hidden login forms',()=>{
  document.body.innerHTML='<h1>商品标题</h1><div hidden><input type="password"></div><div id="description">正文</div>';
  const scroll=vi.spyOn(window,'scrollTo').mockImplementation(()=>{});
  expect(taobaoLoadStep(false).blocked).toBe(false);
  document.body.insertAdjacentHTML('beforeend','<div class="nc-container">拖动滑块</div>');
  expect(taobaoLoadStep(true).blocked).toBe(true);
  expect(scroll).not.toHaveBeenCalled();
});

it('retains product titles beginning with safety terms and does not click purchase or SKU controls',()=>{
  document.title='安全验证器';document.body.innerHTML='<h1>安全验证器</h1><div id="description">产品说明</div><button>立即购买</button>';
  const click=vi.spyOn(HTMLElement.prototype,'click');
  vi.spyOn(window,'scrollTo').mockImplementation(()=>{});
  expect(taobaoLoadStep(false)).toMatchObject({ready:true,blocked:false});
  expect(click).not.toHaveBeenCalled();
});
