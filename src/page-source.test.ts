// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from "vitest";
import { EventEmitter } from 'node:events';
import { snapshotPage, sourcePage, workIdentityFromUrl } from "./page-source";
import type { SiteSessions } from './auth';
import { publicPageStates } from "./adapters/site-state";

describe("snapshotPage", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps Douyin inline pace state for the offline property parser", () => {
    const detail = {
      aweme_id: "123",
      desc: "正文标题",
      author: { nickname: "作者" },
    };
    document.head.innerHTML = `<script>window.__pace_f.push(${JSON.stringify([
      1,
      JSON.stringify({ videoDetail: detail }),
    ])});</script>`;
    const snapshot = snapshotPage();
    const states = publicPageStates(
      new DOMParser().parseFromString(snapshot.html, "text/html"),
    );
    expect(states).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          videoDetail: expect.objectContaining({ aweme_id: "123" }),
        }),
      ]),
    );
  });

  it("does not copy unrelated executable page scripts", () => {
    document.head.innerHTML =
      "<script>window.__private_token = 'secret'</script>";
    const snapshot = snapshotPage();
    expect(snapshot.html).not.toContain("__private_token");
  });
  it("keeps inert JSON-LD source metadata while dropping executable scripts", () => {
    document.head.innerHTML = '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"标题"}</script>';
    const snapshot = snapshotPage();
    expect(snapshot.html).toContain('application/ld+json');
    expect(snapshot.html).toContain('"headline":"标题"');
  });
  it("keeps XHS initial state for note metadata and media extraction", () => {
    document.head.innerHTML = `<script>window.__INITIAL_STATE__=${JSON.stringify({ note: { noteId: "0123456789abcdef01234567", desc: "正文" } })};</script>`;
    const snapshot = snapshotPage();
    expect(snapshot.html).toContain("__INITIAL_STATE__");
    expect(publicPageStates(new DOMParser().parseFromString(snapshot.html, "text/html"))).toEqual(
      expect.arrayContaining([expect.objectContaining({ note: expect.objectContaining({ desc: "正文" }) })]),
    );
  });
  it('preserves generic JSON-LD and records computed hidden elements without collecting media',()=>{
    document.head.innerHTML='<style>.invisible {display:none}</style><script type="application/ld+json">{"@type":"Article","author":"作者"}</script><script>window.privateToken="secret"</script>';
    document.body.innerHTML='<main>正文</main><div class="invisible">请先登录</div><video src="/private.mp4"></video>';
    const result=snapshotPage(true);
    expect(result.html).toContain('application/ld+json');expect(result.html).not.toContain('privateToken');
    expect(new DOMParser().parseFromString(result.html,'text/html').querySelector('.invisible')?.hasAttribute('hidden')).toBe(true);
    expect(result.videos).toEqual([]);expect(result.webAccess).toEqual({loginForm:false,loginOverlay:false});
  });
  it('identifies a visible modal login gate without treating a cookie dialog as login',()=>{
    const rectangles=vi.spyOn(Element.prototype,'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
    try {
      document.body.innerHTML='<main>正文</main><div role="dialog">接受 Cookie</div>';
      expect(snapshotPage(true).webAccess?.loginOverlay).toBe(false);
      document.body.innerHTML='<main>正文</main><div role="dialog">登录后继续阅读<input type="password"></div>';
      expect(snapshotPage(true).webAccess).toEqual({loginForm:true,loginOverlay:true});
    } finally {rectangles.mockRestore();}
  });
});

it('passes the main-document HTTP status through the generic rendered snapshot',async()=>{
  vi.useFakeTimers();
  const url='https://example.com/private';
  const web=Object.assign(new EventEmitter(),{getURL:()=>url,executeJavaScript:vi.fn(async()=>({url,html:'<title>登录</title>',videos:[]}))});
  const win={webContents:web,loadURL:vi.fn(async()=>{web.emit('did-navigate',{},url,401);})};
  const sessions={targetFor:()=> 'web:example.com',open:vi.fn(async()=>win),allowed:()=>true,release:vi.fn()};
  try {
    const result=sourcePage(sessions as unknown as SiteSessions,url,new AbortController().signal);
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({httpStatus:401});expect(sessions.release).toHaveBeenCalled();
    expect(web.listenerCount('did-navigate')).toBe(0);
    expect(web.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining(')(true)'),false);
  } finally {vi.useRealTimers();}
});

describe("workIdentityFromUrl", () => {
  it.each([
    ["https://www.zhihu.com/question/433226615/answer/107204764383", "107204764383"],
    ["https://www.douyin.com/video/7698659081447329050", "7698659081447329050"],
    ["https://www.bilibili.com/opus/1261621092485693461/", "1261621092485693461"],
  ])("selects the work identity from %s", (url, identity) => {
    expect(workIdentityFromUrl(url)).toBe(identity);
  });
});

describe('Taobao local page loading',()=>{
  const url='https://item.taobao.com/item.htm?id=123';
  function pageFixture(challenge=false,changing=false){
    let steps=0;
    const snapshot={url,html:'<h1>商品</h1><div id="description">详情</div>',videos:[]};
    const web=Object.assign(new EventEmitter(),{getURL:()=>url,executeJavaScript:vi.fn(async(script:string)=>{
      if(script.includes('taobaoLoadStep'))return {ready:true,blocked:challenge,signature:changing?String(++steps):'stable'};
      return snapshot;
    })});
    const win={webContents:web,loadURL:vi.fn(async()=>{})};
    const sessions={targetFor:()=> 'taobao',open:vi.fn(async()=>win),allowed:()=>true,release:vi.fn()};
    return {sessions,web};
  }
  it.each([false,true])('bounds lazy-loading with changing=%s and takes a DOM-only snapshot',async changing=>{
    vi.useFakeTimers();
    const f=pageFixture(false,changing);
    try{
      const pending=sourcePage(f.sessions as unknown as SiteSessions,url,new AbortController().signal);
      await vi.runAllTimersAsync();
      expect((await pending).url).toBe(url);
      const calls=f.web.executeJavaScript.mock.calls;
      expect(calls.filter(([script])=>script.includes('taobaoLoadStep')).length).toBeLessThanOrEqual(25);
      expect(calls.at(-1)?.[0]).toContain(')(true)');
      expect(f.sessions.release).toHaveBeenCalled();
      expect(f.web.listenerCount('did-navigate')).toBe(0);
    }finally{vi.useRealTimers();}
  });
  it('stops at a verification page and releases the hidden window',async()=>{
    const f=pageFixture(true);
    await expect(sourcePage(f.sessions as unknown as SiteSessions,url,new AbortController().signal)).rejects.toThrow('人工');
    expect(f.web.executeJavaScript).toHaveBeenCalledOnce();expect(f.sessions.release).toHaveBeenCalled();
  });
  it('captures the rendered product when optional lazy loading reaches its budget',async()=>{
    vi.useFakeTimers();const f=pageFixture(false,true);const budget=new AbortController();
    const timeout=vi.spyOn(AbortSignal,'timeout').mockReturnValueOnce(budget.signal);
    try {
      const pending=sourcePage(f.sessions as unknown as SiteSessions,url,new AbortController().signal);
      await vi.advanceTimersByTimeAsync(1000);budget.abort(new DOMException('budget','TimeoutError'));
      await vi.runAllTimersAsync();
      expect((await pending).url).toBe(url);
      expect(f.web.executeJavaScript.mock.calls.at(-1)?.[0]).toContain(')(true)');
      expect(f.sessions.release).toHaveBeenCalled();
    }finally{timeout.mockRestore();vi.useRealTimers();}
  });
  it('rejects a search page before opening a capture session',async()=>{
    const f=pageFixture();
    await expect(sourcePage(f.sessions as unknown as SiteSessions,'https://s.taobao.com/search?q=test',new AbortController().signal)).rejects.toThrow('详情链接');
    expect(f.sessions.open).not.toHaveBeenCalled();
  });
  it('cancels pending lazy loading and releases the session',async()=>{
    vi.useFakeTimers();const f=pageFixture(false,true);const controller=new AbortController();
    try{
      const pending=sourcePage(f.sessions as unknown as SiteSessions,url,controller.signal);
      const rejected=expect(pending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(1000);controller.abort();await rejected;
      expect(f.sessions.release).toHaveBeenCalled();
    }finally{vi.useRealTimers();}
  });
});

it('retries the first Douyin snapshot when restored localStorage reloads the renderer', async () => {
  vi.useFakeTimers();
  const url = 'https://www.douyin.com/video/1234567890123456789';
  const snapshot = { url, html: '<main>视频</main>', videos: [] };
  const executeJavaScript = vi.fn()
    .mockRejectedValueOnce(new Error('Script failed to execute, this normally means an error was thrown.'))
    .mockResolvedValue(snapshot);
  const web = Object.assign(new EventEmitter(), {
    getURL: () => url,
    executeJavaScript,
    debugger: {
      attach: vi.fn(),
      detach: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
      sendCommand: vi.fn(async () => ({})),
    },
  });
  const win = { webContents: web, loadURL: vi.fn(async () => {}), isDestroyed: () => false, destroy: vi.fn() };
  const sessions = {
    targetFor: () => 'douyin',
    open: vi.fn(async () => win),
    allowed: () => true,
    release: vi.fn(),
  };
  try {
    const pending = sourcePage(sessions as unknown as SiteSessions, url, new AbortController().signal);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ url });
    expect(executeJavaScript.mock.calls.filter(([script]) => String(script).includes('function snapshotPage')).length).toBe(2);
    expect(sessions.release).toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
