import { createWriteStream } from 'node:fs';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MoonCGError } from '@mooncg/core';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { publicError } from '../bundles/errors.js';
import { errorMessage } from '../kernel/logger.js';
import {
  entryNameProblem,
  type InstallLimits,
  isInside,
  refuse,
  removeDir,
  storageError,
  storageProblem,
  type TreeSize,
  treeCounter,
} from './files.js';

/** The manifest file, whose place tells where a bundle starts inside an archive. */
const MANIFEST_FILE = 'mooncg.json';
/** The bits of a Unix mode that say what kind of file an entry is. */
const TYPE_MASK = 0o170000;
const TYPE_FILE = 0o100000;
const TYPE_DIRECTORY = 0o040000;
const TYPE_LINK = 0o120000;
/** Below this many unpacked bytes the compression ratio is not looked at: text packs well. */
const RATIO_FLOOR_BYTES = 1024 * 1024;

interface Planned {
  readonly entry: Entry;
  readonly name: string;
  readonly isDirectory: boolean;
}

/**
 * Extracts a ZIP archive into `dest`, an empty folder. The whole table of contents is
 * checked before a byte is written: every name must stay inside `dest` and be writable as
 * it is on any system, no entry may be a link, a device or encrypted, none may come twice,
 * and count, size and compression ratio must be within the limits. While writing, what is
 * really unpacked is counted again, because an archive can lie about its sizes. Whatever is
 * refused leaves `dest` empty. Rejects with an `invalid` error that says what is wrong.
 */
export async function extractZip(
  archive: string,
  dest: string,
  limits: InstallLimits,
): Promise<TreeSize> {
  let zip: ZipFile;
  try {
    // Names are decoded here, strictly: a library that tidies a name up hides what it was.
    zip = await yauzl.openPromise(archive, {
      lazyEntries: true,
      autoClose: false,
      decodeStrings: false,
      validateEntrySizes: true,
    });
  } catch (error) {
    throw unusable(error);
  }
  try {
    const { size: archiveBytes } = await stat(archive);
    const planned = await plan(zip, archiveBytes, limits);
    try {
      return await write(zip, planned, dest, archiveBytes, limits);
    } catch (error) {
      // Nothing of a refused archive stays, not even what was fine.
      for (const name of await readdir(dest).catch(() => [])) await removeDir(join(dest, name));
      throw error;
    }
  } finally {
    zip.close();
  }
}

/** A path that is no folder of anything, for messages that are about no bundle. */
const NOWHERE = '\u0000';

/**
 * What to answer when reading an archive or writing its files failed. A failure of the disk
 * is the server's own problem and says so; anything else is the archive's. Neither names a
 * path of the server.
 */
export function archiveError(error: unknown): MoonCGError {
  if (error instanceof MoonCGError) return error;
  const storage = storageProblem(error);
  if (storage !== undefined) return storageError(storage);
  let message = errorMessage(error);
  // An error of the file system names the file it was about.
  for (const key of ['path', 'dest'] as const) {
    const path = (error as Partial<Record<typeof key, unknown>> | undefined)?.[key];
    if (typeof path === 'string' && path !== '') message = message.replaceAll(path, basename(path));
  }
  return refuse(`This is not a usable ZIP archive: ${publicError(message, NOWHERE)}`);
}
const unusable = archiveError;

/** Reads the table of contents and refuses the archive for anything that is wrong with it. */
async function plan(zip: ZipFile, archiveBytes: number, limits: InstallLimits): Promise<Planned[]> {
  if (zip.entryCount === 0) throw refuse('The archive is empty');
  if (zip.entryCount > limits.maxFiles) {
    throw refuse(`The archive has more than ${limits.maxFiles} entries`);
  }
  const planned: Planned[] = [];
  /** What each path is, by its name without case: Windows and macOS tell no two apart. */
  const kinds = new Map<string, 'file' | 'folder'>();
  let claimed = 0;
  try {
    for await (const entry of zip.eachEntry()) {
      const name = decodeName(entry);
      const fail = (problem: string) => refuse(`Entry "${printable(name)}": ${problem}`);
      const problem = entryNameProblem(name);
      if (problem !== undefined) throw fail(problem);
      const type = (entry.externalFileAttributes >>> 16) & TYPE_MASK;
      if (type === TYPE_LINK) throw fail('symbolic links are not extracted');
      if (type !== 0 && type !== TYPE_FILE && type !== TYPE_DIRECTORY) {
        throw fail('it is a special file, not a file or a folder');
      }
      if (entry.isEncrypted()) throw fail('it is encrypted');
      if (!entry.canDecodeFileData()) throw fail('it uses a compression that is not supported');

      const isDirectory = name.endsWith('/') || type === TYPE_DIRECTORY;
      const parts = name.replace(/\/$/, '').normalize('NFC').toLowerCase().split('/');
      const key = parts.join('/');
      if (kinds.get(key) === 'file' || (kinds.has(key) && !isDirectory)) {
        throw fail(
          kinds.get(key) === 'file' && !isDirectory
            ? 'the archive has this file twice'
            : 'it is both a file and a folder in the archive',
        );
      }
      for (let depth = 1; depth < parts.length; depth++) {
        const parent = parts.slice(0, depth).join('/');
        if (kinds.get(parent) === 'file') {
          throw fail('it is both a file and a folder in the archive');
        }
        kinds.set(parent, 'folder');
      }
      kinds.set(key, isDirectory ? 'folder' : 'file');

      claimed += isDirectory ? 0 : entry.uncompressedSize;
      checkSize(claimed, archiveBytes, limits);
      planned.push({ entry, name, isDirectory });
    }
  } catch (error) {
    throw unusable(error);
  }
  return planned;
}

/** The name of an entry as it is in the archive: UTF-8 or CP437, with nothing replaced. */
function decodeName(entry: Entry): string {
  return yauzl.getFileNameLowLevel(
    entry.generalPurposeBitFlag,
    entry.fileNameRaw,
    entry.extraFields,
    // Strict: a backslash stays a backslash, and is refused as one.
    true,
  );
}

/** A name for an error message: cut, and with nothing in it that could not be printed. */
const printable = (name: string) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
  name.slice(0, 120).replace(/[\u0000-\u001f\u007f]/g, '?');

function checkSize(unpacked: number, archiveBytes: number, limits: InstallLimits): void {
  if (unpacked > limits.maxUnpackedBytes) {
    throw refuse(`The archive unpacks to more than ${limits.maxUnpackedBytes} bytes`);
  }
  if (unpacked > RATIO_FLOOR_BYTES && unpacked > archiveBytes * limits.maxCompressionRatio) {
    throw refuse(
      `The archive is compressed more than ${limits.maxCompressionRatio} times, which no bundle is`,
    );
  }
}

async function write(
  zip: ZipFile,
  planned: readonly Planned[],
  dest: string,
  archiveBytes: number,
  limits: InstallLimits,
): Promise<TreeSize> {
  const counter = treeCounter(limits);
  let written = 0;
  for (const { entry, name, isDirectory } of planned) {
    const target = join(dest, ...name.split('/').filter((part) => part !== ''));
    // The names were checked; this is the same promise kept a second time.
    if (!isInside(dest, target)) throw refuse(`Entry "${printable(name)}": leaves the folder`);
    counter.entry(!isDirectory);
    if (isDirectory) {
      await mkdir(target, { recursive: true });
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    const counting = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        written += chunk.length;
        try {
          counter.add(chunk.length);
          checkSize(written, archiveBytes, limits);
        } catch (error) {
          return done(error as Error);
        }
        done(null, chunk);
      },
    });
    try {
      const data = await zip.openReadStreamPromise(entry);
      // `wx`: never over a file that is there, whatever the checks above let through.
      await pipeline(data, counting, createWriteStream(target, { flags: 'wx' }));
    } catch (error) {
      throw unusable(error);
    }
  }
  return counter.size();
}

/**
 * Where the bundle starts in a folder an archive was extracted into: the folder itself, or
 * the one folder in it when that is all there is, as in an archive of a repository.
 */
export async function bundleRoot(dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  const [only] = entries;
  if (entries.length !== 1 || only === undefined || !only.isDirectory()) return dir;
  if (entries.some((entry) => entry.name === MANIFEST_FILE)) return dir;
  return join(dir, only.name);
}
