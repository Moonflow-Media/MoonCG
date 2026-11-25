import { cp, lstat, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { MoonCGError } from '@mooncg/core';

/**
 * How much a bundle that is being installed may be. Whatever an archive or a repository
 * says about itself, these are checked against what is really read and written.
 */
export interface InstallLimits {
  /** The largest ZIP archive that is taken, in bytes. */
  readonly maxArchiveBytes: number;
  /** How many bytes the files of a bundle may take together once unpacked. */
  readonly maxUnpackedBytes: number;
  /** How many files and folders a bundle may consist of. */
  readonly maxFiles: number;
  /** How many times larger than its archive an unpacked bundle may be. */
  readonly maxCompressionRatio: number;
}

export const DEFAULT_INSTALL_LIMITS: InstallLimits = {
  maxArchiveBytes: 100 * 1024 * 1024,
  // Room for a bundle that brings its `node_modules`.
  maxUnpackedBytes: 500 * 1024 * 1024,
  maxFiles: 50_000,
  maxCompressionRatio: 100,
};

/** An installation that is refused for what was supplied: answered as `invalid`. */
export const refuse = (message: string) => new MoonCGError('invalid', message);

/**
 * Whether `child` is `parent` or lies below it. Both are absolute paths; they are compared
 * as written, so resolve links first where that matters. Windows paths compare without case.
 */
export function isInside(parent: string, child: string): boolean {
  const fold = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);
  const path = relative(fold(parent), fold(child));
  // By segments: a folder called `..a` is a folder, not a way out.
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/**
 * Whether a path names a place on another machine or a device rather than a folder of a
 * local disk: a UNC path such as `//server/share`, written with either kind of slash.
 * Reading one makes the server open a connection, with its own credentials, to wherever the
 * path says.
 */
export function isNetworkPath(path: string): boolean {
  return /^[\\/]{2}[^\\/]/.test(path);
}

/**
 * The real location of a path, also of one that is not there yet: the nearest folder above
 * it that exists is resolved, by the system itself, and the rest is put back on. So a path
 * through a link, or one written with the short names of Windows, compares equal to the same
 * place written out.
 */
export async function realNearest(path: string): Promise<string> {
  const rest: string[] = [];
  for (let current = path; ; ) {
    try {
      return join(await realpath(current), ...rest);
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      rest.unshift(basename(current));
      current = parent;
    }
  }
}

/** What the disk says when it cannot take a file, as opposed to what is wrong with the file. */
const STORAGE_PROBLEMS: Readonly<Record<string, string>> = {
  ENOSPC: 'the disk is full',
  EDQUOT: 'the disk quota is used up',
  EROFS: 'the disk is read-only',
  EPERM: 'the server is not allowed to write there',
  EACCES: 'the server is not allowed to write there',
  EIO: 'the disk reported an error',
  EMFILE: 'the server has too many files open',
  ENFILE: 'the system has too many files open',
};

/**
 * What kept the server from writing, in words that name no path, when `error` is a failure
 * of the disk. `undefined` for any other error.
 */
export function storageProblem(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const problem = code === undefined ? undefined : STORAGE_PROBLEMS[code];
  return problem === undefined ? undefined : `${problem} (${code})`;
}

/** An installation that failed for a reason of the server's own: answered as `internal`. */
export const storageError = (problem: string) =>
  new MoonCGError('internal', `The server could not store the bundle: ${problem}`);

/** Names Windows gives to devices, whatever extension follows. */
const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
/** Deeper or longer than any bundle needs, and than Windows takes without special care. */
const MAX_DEPTH = 40;
const MAX_SEGMENT_LENGTH = 255;
const MAX_NAME_LENGTH = 1024;

/**
 * Why a forward-slash path from an archive may not be written, or `undefined` if it may: it
 * must stay inside the folder it is extracted into and mean the same file on every system.
 * A trailing slash marks a folder.
 */
export function entryNameProblem(name: string): string | undefined {
  if (name === '') return 'the name is empty';
  if (name.length > MAX_NAME_LENGTH) return 'the name is too long';
  if (name.includes('\\')) return 'the name contains a backslash';
  if (name.startsWith('/')) return 'the name is an absolute path';
  if (/^[A-Za-z]:/.test(name)) return 'the name starts with a drive letter';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'the name contains a control character';
  const parts = (name.endsWith('/') ? name.slice(0, -1) : name).split('/');
  if (parts.length > MAX_DEPTH) return 'the path is too deep';
  for (const part of parts) {
    if (part === '') return 'the path has an empty segment';
    if (part === '.' || part === '..') return `the path has a "${part}" segment`;
    if (part.length > MAX_SEGMENT_LENGTH) return 'a segment of the path is too long';
    if (part.includes(':')) return 'the name contains ":"';
    if (/[<>"|?*]/.test(part)) return 'the name contains a character Windows does not allow';
    if (/[. ]$/.test(part)) return `"${part}" ends with a dot or a space`;
    if (RESERVED_NAME.test(part)) return `"${part}" is a reserved name on Windows`;
  }
  return undefined;
}

/**
 * The waits before trying again to move a folder that something still holds: on Windows a
 * virus scanner, an indexer or a file that is still being served keeps a folder from being
 * renamed for a moment. About three seconds in all.
 */
export const MOVE_RETRY_MS: readonly number[] = [50, 100, 200, 400, 800, 1600];
/** What Windows answers while something has a file of the folder open. */
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);

export interface MoveOptions {
  /** For tests: stands in for `fs.rename`. */
  readonly rename?: (from: string, to: string) => Promise<void>;
  /** For tests: stands in for waiting. */
  readonly wait?: (ms: number) => Promise<void>;
}

const codeOf = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Moves a folder to a path where nothing is yet. A rename where that works, which is at
 * once and all or nothing. A folder that is held is tried again with growing waits.
 *
 * Across volumes the folder is copied. The original is then renamed aside, which again is
 * all or nothing, and only then deleted; if it cannot be renamed, the copy is removed and the
 * original stays as it was. So the folder is whole in exactly one of the two places whatever
 * fails, and what is left of a deletion that did not finish has a name that starts with a
 * dot, which nothing takes for a bundle.
 */
export async function moveDir(from: string, to: string, options: MoveOptions = {}): Promise<void> {
  const move = options.rename ?? rename;
  const wait = options.wait ?? sleep;
  const there = await lstat(to).then(
    () => true,
    () => false,
  );
  if (there) throw new Error(`Cannot move to "${to}": it already exists`);
  /** Renames, waiting while the folder is held. `false` when the target is on another volume. */
  const renamed = async (source: string, target: string): Promise<boolean> => {
    for (let attempt = 0; ; attempt++) {
      try {
        await move(source, target);
        return true;
      } catch (error) {
        const code = codeOf(error);
        if (code === 'EXDEV') return false;
        if (code === undefined || !BUSY.has(code)) throw error;
        const delay = MOVE_RETRY_MS[attempt];
        if (delay === undefined) {
          throw new Error(
            `Cannot move "${source}": it is in use by another program (${code}). ` +
              'Close what has its files open and try again.',
          );
        }
        await wait(delay);
      }
    }
  };
  if (await renamed(from, to)) return;
  const aside = join(dirname(from), `.${basename(from)}.moved-${Date.now().toString(36)}`);
  try {
    await cp(from, to, { recursive: true, errorOnExist: true, force: false });
    if (!(await renamed(from, aside))) throw new Error(`Cannot move "${from}" aside`);
  } catch (error) {
    await removeDir(to).catch(() => {});
    throw error;
  }
  await removeDir(aside).catch(() => {});
}

/** Deletes a folder and everything in it. A folder that is not there is fine. */
export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

export interface TreeSize {
  readonly files: number;
  readonly bytes: number;
}

/** Counts files and bytes as they are met, and refuses what goes beyond the limits. */
export function treeCounter(limits: Pick<InstallLimits, 'maxFiles' | 'maxUnpackedBytes'>) {
  let entries = 0;
  let files = 0;
  let bytes = 0;
  return {
    /** One more file or folder. */
    entry(isFile: boolean): void {
      if (++entries > limits.maxFiles) {
        throw refuse(`The bundle has more than ${limits.maxFiles} files`);
      }
      if (isFile) files++;
    },
    /** So many more bytes of file content. */
    add(count: number): void {
      bytes += count;
      if (bytes > limits.maxUnpackedBytes) {
        throw refuse(`The bundle is larger than ${limits.maxUnpackedBytes} bytes`);
      }
    },
    size: (): TreeSize => ({ files, bytes }),
  };
}

/**
 * Walks a folder that was just fetched: counts its files and bytes against the limits and
 * refuses anything that is neither a file nor a folder, a symbolic link above all.
 */
export async function measureTree(
  dir: string,
  limits: Pick<InstallLimits, 'maxFiles' | 'maxUnpackedBytes'>,
): Promise<TreeSize> {
  const counter = treeCounter(limits);
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      const shown = relative(dir, path).split(sep).join('/');
      if (entry.isSymbolicLink()) throw refuse(`"${shown}" is a symbolic link`);
      if (entry.isDirectory()) {
        counter.entry(false);
        await walk(path);
      } else if (entry.isFile()) {
        counter.entry(true);
        counter.add((await stat(path)).size);
      } else {
        throw refuse(`"${shown}" is neither a file nor a folder`);
      }
    }
  };
  await walk(dir);
  return counter.size();
}
