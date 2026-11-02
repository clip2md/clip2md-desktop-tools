/** Serialized into the owned renderer; keep this function self-contained. */
export function taobaoLoadStep(scroll = false): { ready: boolean; blocked: boolean; signature: string } {
  const visible = (node: Element) => !node.closest('[hidden],[aria-hidden="true"]')
    && getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden';
  const blocked = /^(?:淘宝网?\s*[-—|]\s*)?(?:登录|安全验证|访问验证|访问异常|验证码|滑块验证|请完成验证|captcha|sign in)(?:\s*[-—|].*)?$/i.test(document.title)
    || Array.from(document.querySelectorAll('#nc_1_wrapper,.nc-container,[id*="captcha" i],[class*="captcha" i],iframe[src*="login.taobao.com"],input[type="password"]')).some(visible);
  const ready = Array.from(document.querySelectorAll('[class*="mainTitle--"],.tb-main-title,.tb-detail-hd h1,h1'))
    .some(node => visible(node) && !!node.textContent?.trim());
  const detail = document.querySelector<HTMLElement>('#description,#J_DivItemDesc,#J_DivItemDescContainer,[class*="descV8-container"],[class*="descContent"],[class*="detailDesc"],.tb-detail-bd,#detail');
  const container = detail && detail.scrollHeight > detail.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(detail).overflowY) ? detail : undefined;
  const top = container ? container.scrollTop : window.scrollY;
  const height = container ? container.scrollHeight : document.documentElement.scrollHeight;
  const signature = `${top}:${height}:${detail?.querySelectorAll('img').length || 0}:${detail?.textContent?.length || 0}`;
  if (scroll && ready && !blocked && detail) {
    if (container) container.scrollTop += 800;
    else {
      const end = Math.max(0, detail.getBoundingClientRect().bottom + window.scrollY - window.innerHeight);
      const start = Math.max(0, detail.getBoundingClientRect().top + window.scrollY - 100);
      window.scrollTo(0, Math.min(end, Math.max(start, window.scrollY + 800)));
    }
  }
  return { ready, blocked, signature };
}
