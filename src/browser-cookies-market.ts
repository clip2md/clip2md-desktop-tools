import type { SiteCookie } from "./auth";

/** Market builds never access browser cookies; website builds replace this module. */
export async function readChromeCookies(_ytdlp: string, _signal: AbortSignal): Promise<SiteCookie[]> {
  return [];
}
