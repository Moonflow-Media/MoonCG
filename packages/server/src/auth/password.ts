import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** The only rule for passwords: a minimum length. Long passphrases beat forced symbols. */
export const MIN_PASSWORD_LENGTH = 8;
/** Bounds the work one login attempt can cause. */
export const MAX_PASSWORD_LENGTH = 1024;

/** scrypt cost parameters. They are stored with each hash, so they can be raised later. */
export interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

/** About 16 MiB of memory and some tens of milliseconds per hash. */
export const DEFAULT_SCRYPT: ScryptParams = { N: 16384, r: 8, p: 1 };

const KEY_BYTES = 32;
const SALT_BYTES = 16;

function derive(password: string, salt: Buffer, { N, r, p }: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Twice what the parameters need, so raising them moderately does not hit the limit.
    const maxmem = 256 * N * r;
    scrypt(password.normalize('NFKC'), salt, KEY_BYTES, { N, r, p, maxmem }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

/** Hashes a password with a fresh salt as `scrypt$N$r$p$salt$hash`. */
export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT,
): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, params);
  const { N, r, p } = params;
  return ['scrypt', N, r, p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/**
 * Whether the password is the one the hash was made from. The comparison takes the same time
 * whatever the outcome. A hash that cannot be read verifies nothing.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, N, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || salt === undefined || hash === undefined) return false;
  const params = { N: Number(N), r: Number(r), p: Number(p) };
  if (![params.N, params.r, params.p].every((value) => Number.isSafeInteger(value) && value > 0)) {
    return false;
  }
  try {
    const expected = Buffer.from(hash, 'base64url');
    const actual = await derive(password, Buffer.from(salt, 'base64url'), params);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
