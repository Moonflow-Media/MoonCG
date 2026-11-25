import { realpath, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/**
 * What an uploaded file is served with. `sandbox` makes whatever a browser opens from it a
 * document without an origin and without scripts, so an uploaded page or SVG cannot act as
 * this server towards whoever looks at it. Used as an image, a font or a clip by a page of a
 * bundle, the file works as before: the policy binds the file as a document, not its users.
 */
export const ASSET_CSP = [
  'sandbox',
  "default-src 'none'",
  "img-src 'self' data:",
  "media-src 'self'",
  "style-src 'unsafe-inline'",
  "frame-ancestors 'self'",
].join('; ');

/** Headers a route of a bundle or module may not set: they describe the connection. */
export const CONNECTION_HEADERS = new Set([
  'connection',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Request headers such a route never sees: they are the credentials of the caller, for this
 * server or for a proxy on the way to it.
 */
export const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);

/** Keeps the string values of a query or header map; of a repeated one, the first. */
export function flatten(
  values: Readonly<Record<string, unknown>>,
  without: ReadonlySet<string> = new Set(),
): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string' && !without.has(name)) flat[name] = first;
  }
  return flat;
}

/**
 * Resolves a requested file to its real location on disk. Answers `undefined` unless that is a
 * file whose real path, relative to the real area directory, is exactly the requested one.
 * This rejects names that differ only in case on a case-insensitive file system, and anything
 * reached through a symlink or junction, including one that points outside the area.
 */
export async function canonicalFile(
  areaDir: string,
  requested: string,
): Promise<string | undefined> {
  try {
    const root = await realpath(areaDir);
    const real = await realpath(join(root, requested));
    if (relative(root, real).split(sep).join('/') !== requested) return undefined;
    return (await stat(real)).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}
