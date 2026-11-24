/** The longest name an asset file may have, in characters. */
export const MAX_ASSET_NAME_LENGTH = 150;

/** Characters Windows takes in no file name. `/` and `\` are refused before it gets here. */
const FORBIDDEN = new Set('<>:"|?*');
/** Names Windows reads as a device, with or without an extension, in any case. */
const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i;
const ENDS = /^[\s.]+|[\s.]+$/g;
/** The 8.3 alias Windows gives a long name: some characters, `~` and a digit, then the end. */
const SHORT_NAME = /~\d+(\.[^.]*)?$/;

/**
 * The name an uploaded file is stored under, or `undefined` for what is no name of one file.
 *
 * A name with a path separator or a NUL in it is refused, not repaired: it was meant as a
 * path, and no part of it is what the sender asked for. So is a name that ends like a short
 * name of Windows (`~1`), which Windows may resolve to a different file. Everything else is made safe for
 * every file system the server may run on: control characters and the characters Windows
 * forbids become `_`, dots and spaces come off both ends (Windows drops them from the end,
 * and a leading dot hides a file), and a device name of Windows (`CON`, `NUL`, `COM1`, …)
 * gets a `_` in front. A cleaned name is returned unchanged when it is cleaned again.
 */
export function assetFileName(raw: string): string | undefined {
  if (raw.includes('/') || raw.includes('\\') || raw.includes('\0')) return undefined;
  // `LONGFI~1.PNG` is how Windows abbreviates a long name, and may name another file.
  if (SHORT_NAME.test(raw)) return undefined;
  const replaced = [...raw.normalize('NFC')]
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f || FORBIDDEN.has(char) ? '_' : char;
    })
    .join('');
  const trimmed = replaced.replace(ENDS, '');
  if (trimmed === '') return undefined;
  // Windows looks at what stands before the first dot, without the spaces that end it.
  const stem = (trimmed.split('.')[0] ?? '').trimEnd();
  const name = DEVICE_NAME.test(stem) ? `_${trimmed}` : trimmed;
  return name.length > MAX_ASSET_NAME_LENGTH ? undefined : name;
}

/**
 * The content types an asset is served with, by extension. The list is closed on purpose:
 * what is not on it is sent as bytes to download. Nothing on it is a page, a script or a
 * style sheet, so an uploaded file is never something a browser runs as this server's own.
 */
const ASSET_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
};

const BYTES = 'application/octet-stream';

/** The extension of a file name in lowercase, without the dot; empty if it has none. */
function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * How a stored file is served: its content type, and whether a browser may show it in place
 * (`inline`) or is told to download it.
 */
export function assetType(name: string): { readonly type: string; readonly inline: boolean } {
  const type = ASSET_TYPES[extension(name)];
  return type === undefined ? { type: BYTES, inline: false } : { type, inline: true };
}

/**
 * Whether a category takes a file, by its name. An entry of `accept` is an extension (`.png`)
 * or a media type (`image/png`, `image/*`), as in HTML. A media type is matched against what
 * the extension stands for; what the upload claims to be is not looked at. The entry for
 * every media type, a star on both sides of the slash, takes any file at all.
 */
export function accepts(accept: readonly string[] | undefined, name: string): boolean {
  if (accept === undefined) return true;
  const ext = extension(name);
  const type = ASSET_TYPES[ext]?.split(';')[0];
  return accept.some((entry) => {
    const wanted = entry.trim().toLowerCase();
    if (wanted === '*/*') return true;
    if (wanted.startsWith('.')) return ext !== '' && wanted === `.${ext}`;
    if (type === undefined) return false;
    return wanted.endsWith('/*') ? type.startsWith(wanted.slice(0, -1)) : wanted === type;
  });
}
