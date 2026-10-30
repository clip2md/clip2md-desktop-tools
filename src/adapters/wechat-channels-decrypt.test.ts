import { describe, expect, it } from "vitest";
import {
  decryptWechatChannelsMediaBuffer,
  generateWechatChannelsDecryptorBytes,
} from "./wechat-channels-decrypt";

describe("WeChat Channels ISAAC64 head decryption", () => {
  it("matches the published fixed vectors", () => {
    const expected =
      "9c87e6946a410182aee08a5a116f7cb986f10740dd490b9a330cd31db53ddc4a";
    expect(
      generateWechatChannelsDecryptorBytes("123456789", 32).toString("hex"),
    ).toBe(expected);
    expect(
      generateWechatChannelsDecryptorBytes("0x75BCD15", 32).toString("hex"),
    ).toBe(expected);
  });
  it("decrypts and restores an MP4 header", () => {
    const plain = Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from("ftypisom"),
      Buffer.alloc(512, 2),
    ]);
    const key = "987654321";
    const stream = generateWechatChannelsDecryptorBytes(key, plain.length);
    for (let index = 0; index < plain.length; index++)
      plain[index] ^= stream[index];
    expect(decryptWechatChannelsMediaBuffer(plain, key)).toEqual(
      Buffer.concat([
        Buffer.from([0, 0, 0, 24]),
        Buffer.from("ftypisom"),
        Buffer.alloc(512, 2),
      ]),
    );
  });
  it("leaves invalid and empty inputs intact", () => {
    const input = Buffer.from([1, 2, 3, 4]);
    expect(decryptWechatChannelsMediaBuffer(input, "invalid")).toEqual(input);
    expect(decryptWechatChannelsMediaBuffer(Buffer.alloc(0), "123")).toEqual(
      Buffer.alloc(0),
    );
  });
  it("decrypts only the advertised leading span", () => {
    const input = Buffer.alloc(131_073, 0x5a);
    const output = decryptWechatChannelsMediaBuffer(input, "123456789");
    expect(output.subarray(0, 131_072)).not.toEqual(
      input.subarray(0, 131_072),
    );
    expect(output[131_072]).toBe(input[131_072]);
  });
});

