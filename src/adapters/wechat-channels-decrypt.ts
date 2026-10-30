/**
 * ISAAC64 head decryption used by older WeChat Channels media URLs.
 *
 * This TypeScript implementation is adapted from the MIT-licensed
 * datawhalechina/video-devour implementation linked in THIRD_PARTY_NOTICES.md.
 */

export const WECHAT_CHANNELS_ENCRYPTED_HEAD_BYTES = 131_072;
const u64 = (value: bigint) => BigInt.asUintN(64, value);
const ZERO = BigInt(0);
const ONE = BigInt(1);
const KEY_SHIFTS = {
  five: BigInt(5),
  nine: BigInt(9),
  twelve: BigInt(12),
  fourteen: BigInt(14),
  fifteen: BigInt(15),
  seventeen: BigInt(17),
  twenty: BigInt(20),
  twentyOne: BigInt(21),
  twentyThree: BigInt(23),
  thirtyThree: BigInt(33),
};

class Isaac64 {
  private readonly randrsl = new Array<bigint>(256).fill(ZERO);
  private readonly mm = new Array<bigint>(256).fill(ZERO);
  private randcnt = 0;
  private aa = ZERO;
  private bb = ZERO;
  private cc = ZERO;

  constructor(seed: bigint) {
    this.randrsl[0] = u64(seed);
    this.randinit();
  }

  private mix(
    a: bigint, b: bigint, c: bigint, d: bigint,
    e: bigint, f: bigint, g: bigint, h: bigint,
  ): [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint] {
    a = u64(a - e); f = u64(f ^ (h >> KEY_SHIFTS.nine)); h = u64(h + a);
    b = u64(b - f); g = u64(g ^ u64(a << KEY_SHIFTS.nine)); a = u64(a + b);
    c = u64(c - g); h = u64(h ^ (b >> KEY_SHIFTS.twentyThree)); b = u64(b + c);
    d = u64(d - h); a = u64(a ^ u64(c << KEY_SHIFTS.fifteen)); c = u64(c + d);
    e = u64(e - a); b = u64(b ^ (d >> KEY_SHIFTS.fourteen)); d = u64(d + e);
    f = u64(f - b); c = u64(c ^ u64(e << KEY_SHIFTS.twenty)); e = u64(e + f);
    g = u64(g - c); d = u64(d ^ (f >> KEY_SHIFTS.seventeen)); f = u64(f + g);
    h = u64(h - d); e = u64(e ^ u64(g << KEY_SHIFTS.fourteen)); g = u64(g + h);
    return [a, b, c, d, e, f, g, h];
  }

  private randinit(): void {
    let a = BigInt("0x9e3779b97f4a7c13");
    let b = a, c = a, d = a, e = a, f = a, g = a, h = a;
    for (let index = 0; index < 4; index++)
      [a, b, c, d, e, f, g, h] = this.mix(a, b, c, d, e, f, g, h);
    for (let index = 0; index < 256; index += 8) {
      a = u64(a + this.randrsl[index]);
      b = u64(b + this.randrsl[index + 1]);
      c = u64(c + this.randrsl[index + 2]);
      d = u64(d + this.randrsl[index + 3]);
      e = u64(e + this.randrsl[index + 4]);
      f = u64(f + this.randrsl[index + 5]);
      g = u64(g + this.randrsl[index + 6]);
      h = u64(h + this.randrsl[index + 7]);
      [a, b, c, d, e, f, g, h] = this.mix(a, b, c, d, e, f, g, h);
      this.mm.splice(
        index, 8, a, b, c, d, e, f, g, h,
      );
    }
    for (let index = 0; index < 256; index += 8) {
      a = u64(a + this.mm[index]);
      b = u64(b + this.mm[index + 1]);
      c = u64(c + this.mm[index + 2]);
      d = u64(d + this.mm[index + 3]);
      e = u64(e + this.mm[index + 4]);
      f = u64(f + this.mm[index + 5]);
      g = u64(g + this.mm[index + 6]);
      h = u64(h + this.mm[index + 7]);
      [a, b, c, d, e, f, g, h] = this.mix(a, b, c, d, e, f, g, h);
      this.mm.splice(
        index, 8, a, b, c, d, e, f, g, h,
      );
    }
    this.isaac64();
    this.randcnt = 256;
  }

  private isaac64(): void {
    this.cc = u64(this.cc + ONE);
    this.bb = u64(this.bb + this.cc);
    for (let index = 0; index < 256; index++) {
      const value = this.mm[index];
      if (index % 4 === 0)
        this.aa = u64(~u64(this.aa ^ u64(this.aa << KEY_SHIFTS.twentyOne)));
      else if (index % 4 === 1)
        this.aa = u64(this.aa ^ (this.aa >> KEY_SHIFTS.five));
      else if (index % 4 === 2)
        this.aa = u64(this.aa ^ u64(this.aa << KEY_SHIFTS.twelve));
      else
        this.aa = u64(this.aa ^ (this.aa >> KEY_SHIFTS.thirtyThree));
      this.aa = u64(this.aa + this.mm[(index + 128) % 256]);
      const item = u64(this.mm[Number((value >> BigInt(3)) & BigInt(255))] + this.aa + this.bb);
      this.mm[index] = item;
      this.bb = u64(this.mm[Number((item >> BigInt(11)) & BigInt(255))] + value);
      this.randrsl[index] = this.bb;
    }
  }

  next(): bigint {
    if (this.randcnt === 0) {
      this.isaac64();
      this.randcnt = 256;
    }
    this.randcnt--;
    return this.randrsl[this.randcnt];
  }

  generate(length: number): Buffer {
    const result = Buffer.alloc(Math.max(0, Number(length) || 0));
    let position = 0;
    while (position < result.length) {
      const value = this.next();
      for (let shift = 56; shift >= 0 && position < result.length; shift -= 8)
        result[position++] = Number((value >> BigInt(shift)) & BigInt(255));
    }
    return result;
  }
}

export function parseWechatChannelsDecryptKey(value: unknown): bigint | undefined {
  const candidate = String(value ?? "").trim();
  if (!candidate) return;
  try {
    if (/^0x[0-9a-f]+$/i.test(candidate) || /^\d+$/.test(candidate))
      return u64(BigInt(candidate));
  } catch {
    return;
  }
}

export function generateWechatChannelsDecryptorBytes(
  key: unknown,
  length: number,
): Buffer {
  const seed = parseWechatChannelsDecryptKey(key);
  if (seed === undefined || !Number.isSafeInteger(length) || length < 0)
    return Buffer.alloc(0);
  return new Isaac64(seed).generate(length);
}

export function decryptWechatChannelsMediaBuffer(
  value: Buffer,
  key: unknown,
  limit = WECHAT_CHANNELS_ENCRYPTED_HEAD_BYTES,
): Buffer {
  const input = Buffer.from(value);
  const seed = parseWechatChannelsDecryptKey(key);
  if (seed === undefined || !input.length) return input;
  const length = Math.min(
    input.length,
    Number.isFinite(limit)
      ? Math.max(0, Math.floor(limit))
      : WECHAT_CHANNELS_ENCRYPTED_HEAD_BYTES,
  );
  if (!length) return input;
  const result = Buffer.from(input);
  const stream = new Isaac64(seed).generate(length);
  for (let index = 0; index < length; index++)
    result[index] ^= stream[index];
  return result;
}

