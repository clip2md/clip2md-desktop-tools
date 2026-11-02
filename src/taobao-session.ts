import type { SiteCookie } from './auth';

/** Visitor and MTop signing cookies alone do not indicate a signed-in buyer. */
export function hasTaobaoLogin(cookies: SiteCookie[]): boolean {
  const valid = cookies.filter(cookie => {
    const host = cookie.domain.replace(/^\./, '').toLowerCase();
    return (host === 'taobao.com' || host.endsWith('.taobao.com')) && !!cookie.value
      && (!cookie.expirationDate || cookie.expirationDate > Date.now() / 1000);
  });
  return valid.some(cookie => cookie.name === 'cookie2') && valid.some(cookie => cookie.name === 'unb');
}
