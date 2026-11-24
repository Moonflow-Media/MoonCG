import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Every API token starts with this, so one is recognized wherever it turns up. */
export const TOKEN_PREFIX = 'mcg_';

/** A secret nobody can guess: 256 random bits, safe in URLs, cookies and headers. */
export function randomSecret(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * What is stored in place of a session or token secret. These secrets are random and long, so
 * a plain fast hash is enough: there is nothing to guess, unlike with a password.
 */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Compares two secrets without revealing through timing where they differ. */
export function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(hashSecret(a), 'hex'), Buffer.from(hashSecret(b), 'hex'));
}

const TOKEN_PATTERN = /mcg_[A-Za-z0-9_-]+/g;

/** Replaces every API token in a text. Applied to every log line and every error message. */
export function redactSecrets(text: string): string {
  return text.replace(TOKEN_PATTERN, `${TOKEN_PREFIX}***`);
}
