import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/** What ends a path inside an error message. */
const PATH_REST = String.raw`[^\s'"<>|*?]*`;

const forward = (path: string) => path.replaceAll('\\', '/').replace(/\/+$/, '');

/** A path as it may be shown: relative to the bundle if it is inside, else the file name only. */
function shown(path: string, bundleDir: string): string {
  const full = forward(path);
  const bundle = forward(bundleDir);
  // Compared without case, as Windows does; being lenient elsewhere hides nothing.
  if (full.toLowerCase() === bundle.toLowerCase()) return '.';
  if (full.toLowerCase().startsWith(`${bundle.toLowerCase()}/`)) {
    return full.slice(bundle.length + 1);
  }
  return full.slice(full.lastIndexOf('/') + 1);
}

/** Matches `prefix`, written with either kind of slash and in any case, and what follows it. */
function pathsUnder(prefix: string): RegExp {
  const escaped = forward(prefix)
    .split('/')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`))
    .join(String.raw`[\\/]`);
  return new RegExp(String.raw`${escaped}(?=[\\/]|$|[\s'":,)])(?:[\\/]${PATH_REST})?`, 'gi');
}

/** The folders whose location is nobody's business: the server's own, home, temp, cwd. */
export function privateRoots(): string[] {
  const server = fileURLToPath(new URL('../../', import.meta.url));
  return [server, process.cwd(), homedir(), tmpdir()].filter((root) => forward(root).length > 3);
}

/**
 * Takes absolute file paths out of an error message before it is published in the bundle
 * list. A path inside the bundle becomes relative to the bundle folder; any other path under
 * a known root, in a `file:` URL or with a Windows drive letter is reduced to its file name.
 * The full message still goes to the server log.
 */
export function publicError(
  message: string,
  bundleDir: string,
  roots: readonly string[] = privateRoots(),
): string {
  let text = message.replace(/file:\/\/\/?([^\s'"<>]+)/g, (url, rest: string) => {
    let path: string;
    try {
      path = decodeURIComponent(rest);
    } catch {
      return url;
    }
    return shown(/^[A-Za-z]:/.test(path) ? path : `/${path}`, bundleDir);
  });
  // Longest first, so a root inside another does not get in the way.
  const prefixes = [bundleDir, ...roots].sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    text = text.replace(pathsUnder(prefix), (path) => shown(path, bundleDir));
  }
  // What is left with a drive letter is a path elsewhere on a Windows machine.
  return text.replace(
    new RegExp(String.raw`(?<![A-Za-z0-9])[A-Za-z]:[\\/]${PATH_REST}`, 'g'),
    (path) => shown(path, bundleDir),
  );
}
