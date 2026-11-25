const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const VALUES = new Map([...ALPHABET].map((char, index) => [char, index]));

/** Node's `Buffer`, where there is one: it does the same work many times faster. */
interface NodeBuffer {
  from(bytes: Uint8Array): { toString(encoding: 'base64'): string };
  from(text: string, encoding: 'base64'): Uint8Array;
}
const NativeBuffer = (globalThis as { Buffer?: NodeBuffer }).Buffer;

/** Bytes as base64 text, the form bodies take in the wire protocol. Needs no runtime API. */
export function bytesToBase64(bytes: Uint8Array): string {
  if (NativeBuffer) {
    return NativeBuffer.from(bytes).toString('base64');
  }
  let text = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] as number;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    const word = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    text += ALPHABET[(word >> 18) & 63];
    text += ALPHABET[(word >> 12) & 63];
    text += b === undefined ? '=' : ALPHABET[(word >> 6) & 63];
    text += c === undefined ? '=' : ALPHABET[word & 63];
  }
  return text;
}

/** The bytes of base64 text. Throws on text that is not base64. */
export function base64ToBytes(text: string): Uint8Array {
  if (text.length % 4 !== 0) throw new Error('Not base64: the length is not a multiple of 4');
  if (NativeBuffer && /^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    return new Uint8Array(NativeBuffer.from(text, 'base64'));
  }
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array((text.length / 4) * 3 - padding);
  let out = 0;
  for (let index = 0; index < text.length; index += 4) {
    let word = 0;
    for (let offset = 0; offset < 4; offset++) {
      const char = text[index + offset] as string;
      const value = char === '=' && index + offset >= text.length - padding ? 0 : VALUES.get(char);
      if (value === undefined) throw new Error('Not base64: an unknown character');
      word = (word << 6) | value;
    }
    for (const shift of [16, 8, 0]) {
      if (out < bytes.length) bytes[out++] = (word >> shift) & 255;
    }
  }
  return bytes;
}
