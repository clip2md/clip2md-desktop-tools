import { describe, expect, it } from 'vitest';
import { parseNetscapeCookies, parseVideoPlan } from './tools';

describe('browser cookie bridge', () => {
  it('parses private Netscape cookies without exposing values in derived fields', () => {
    const rows = parseNetscapeCookies([
      '# Netscape HTTP Cookie File',
      '.youtube.com\tTRUE\t/\tTRUE\t1799999999\tSID\tsecret-value',
      'accounts.google.com\tFALSE\t/\tTRUE\t0\tHSID\tsecond-value',
      '.evil.example\tTRUE\t/\tFALSE\t0\tbad\tline;with-semicolon',
    ].join('\n'));
    expect(rows).toEqual([
      expect.objectContaining({ domain: '.youtube.com', name: 'SID', value: 'secret-value', secure: true }),
      expect.objectContaining({ domain: 'accounts.google.com', name: 'HSID', value: 'second-value' }),
    ]);
    expect(rows).toHaveLength(2);
  });
});
describe('video plan parsing', () => {
  it('accepts a signed MP4 when a site omits codec metadata', () => {
    const plan = parseVideoPlan(JSON.stringify({
      id: '1790807033836707947',
      webpage_url: 'https://x.com/OpenAIDevs/status/1790807033836707947',
      format_id:'http',ext:'mp4',url:'https://video.twimg.com/tweet_video/example.mp4',vcodec:null,acodec:null,
    }), 'https://x.com/OpenAIDevs/status/1790807033836707947');
    expect(plan.video).toMatchObject({extension:'mp4',url:'https://video.twimg.com/tweet_video/example.mp4'});
    expect(plan.audio).toBeUndefined();
  });
});
