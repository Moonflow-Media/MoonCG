import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  type FileHandle,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { join, relative } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  BUNDLE_NAME_PATTERN,
  BUNDLES_MANAGE,
  bundlePermission,
  type Json,
  type Manifest,
  type ReplicantRegistry,
} from '@mooncg/core';
import { accepts, assetFileName } from './names.js';

/**
 * The read-only replicant `<bundle>:$assets.<category>` lists the files of an asset category,
 * so that a graphic follows uploads without asking. It takes what the category takes for
 * reading. Names that start with `$` are the server's: a manifest cannot declare one.
 */
export const ASSETS_PREFIX = '$assets.';

/** One stored file as the API and the replicant tell it. */
export interface AssetFile {
  readonly name: string;
  readonly size: number;
  /** When it was last written, as an ISO 8601 time. */
  readonly modified: string;
  /** Where it is served. */
  readonly url: string;
}

/** An asset category of a running bundle, with the permissions it takes. */
export interface AssetCategory {
  readonly id: string;
  readonly title?: string | undefined;
  readonly accept?: readonly string[] | undefined;
  /** The permission it takes to list and load the files. */
  readonly read: string;
  /** The permission it takes to upload and delete. */
  readonly write: string;
}

/** Why an upload was refused, with the HTTP status that says so. */
export class AssetError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** How long an upload may send nothing before it is given up, unless configured otherwise. */
export const UPLOAD_IDLE_MS = 30_000;
/** How many files a category may hold, unless configured otherwise. */
export const DEFAULT_ASSET_MAX_FILES = 1000;
/** The waits before trying again to move a file that something else holds for a moment. */
const RENAME_RETRY_MS = [50, 100, 200];
/** What Windows answers while a virus scanner or another reader has the file open. */
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);

export interface AssetStoreOptions {
  /** The server's data directory. The files are in `assets/<bundle>/<category>/` below it. */
  readonly dataDir: string;
  readonly registry: ReplicantRegistry;
  /** The largest file that is taken, in bytes. */
  readonly maxFileBytes: number;
  /** How many bytes the files of one category may take together. */
  readonly quotaBytes: number;
  /** How many files one category may hold. Defaults to `DEFAULT_ASSET_MAX_FILES`. */
  readonly maxFiles?: number | undefined;
  /** How long an upload may send nothing before it is given up. Defaults to `UPLOAD_IDLE_MS`. */
  readonly uploadIdleMs?: number | undefined;
}

/** Folder for uploads that are still arriving. No bundle can be called this. */
const INCOMING = '.incoming';

/**
 * The files people upload for a bundle: logos, pictures, sounds. Each category of a bundle
 * is one flat folder. A file gets there complete or not at all: an upload is written beside
 * the folder first and moved in once every limit was kept.
 */
export class AssetStore {
  readonly #root: string;
  readonly #registry: ReplicantRegistry;
  readonly #categories = new Map<string, readonly AssetCategory[]>();
  /** The last change to each category, so that two uploads cannot share one quota. */
  readonly #tails = new Map<string, Promise<unknown>>();
  readonly maxFileBytes: number;
  readonly quotaBytes: number;
  readonly maxFiles: number;
  readonly #uploadIdleMs: number;

  constructor(options: AssetStoreOptions) {
    this.#root = join(options.dataDir, 'assets');
    this.#registry = options.registry;
    this.maxFileBytes = options.maxFileBytes;
    this.quotaBytes = options.quotaBytes;
    this.maxFiles = options.maxFiles ?? DEFAULT_ASSET_MAX_FILES;
    this.#uploadIdleMs = options.uploadIdleMs ?? UPLOAD_IDLE_MS;
  }

  /**
   * Removes what uploads left behind that were under way when the server last stopped.
   * Call it once at start, before anything is uploaded.
   */
  async sweep(): Promise<void> {
    await rm(join(this.#root, INCOMING), { recursive: true, force: true }).catch(() => {});
  }

  /** Declares the list of each asset category of a bundle that is starting. */
  async declare(bundle: string, manifest: Pick<Manifest, 'assets'>): Promise<void> {
    const categories = manifest.assets.map(
      ({ id, title, accept, read, write }): AssetCategory => ({
        id,
        title,
        accept,
        read: bundlePermission(bundle, read),
        // Reading follows the bundle's usual rule. Changing what a graphic shows on air is
        // more: unless the bundle names who may, it is for whoever manages bundles.
        write: write === undefined ? BUNDLES_MANAGE : bundlePermission(bundle, write),
      }),
    );
    for (const category of categories) {
      this.#registry.declare(bundle, `${ASSETS_PREFIX}${category.id}`, {
        initial: (await this.list(bundle, category.id)) as unknown as Json,
        readPermission: category.read,
        readOnly: true,
      });
    }
    this.#categories.set(bundle, categories);
  }

  /** Forgets the categories of a bundle that stopped. The files stay. */
  retract(bundle: string): void {
    this.#categories.delete(bundle);
  }

  /**
   * Deletes every file that was uploaded for a bundle, for a bundle that is removed with
   * its data. Call it once the bundle is stopped.
   */
  async purge(bundle: string): Promise<void> {
    // A name that could leave the folder is nobody's bundle.
    if (!BUNDLE_NAME_PATTERN.test(bundle)) return;
    this.#categories.delete(bundle);
    await rm(join(this.#root, bundle), { recursive: true, force: true, maxRetries: 5 });
  }

  /** The asset categories of a running bundle. */
  categories(bundle: string): readonly AssetCategory[] {
    return this.#categories.get(bundle) ?? [];
  }

  category(bundle: string, id: string): AssetCategory | undefined {
    return this.categories(bundle).find((category) => category.id === id);
  }

  /** The files of a category, by name. Only what an upload could have put there counts. */
  async list(bundle: string, category: string): Promise<AssetFile[]> {
    const dir = this.#dir(bundle, category);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && assetFileName(entry.name) === entry.name)
        .map(async ({ name }): Promise<AssetFile | undefined> => {
          const stats = await stat(join(dir, name)).catch(() => undefined);
          return stats && this.#describe(bundle, category, name, stats);
        }),
    );
    return files
      .filter((file) => file !== undefined)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /**
   * Stores what `body` delivers as a file of the category, in place of a file of the same
   * name. `rawName` is cleaned first; the answer says what it became. `declaredLength` is
   * what the request said its body is long, which lets an upload that is too large be
   * refused before a byte of it is read; what really arrives is counted either way. Rejects
   * with an `AssetError`, and keeps nothing, when a limit is not kept.
   *
   * The body is received beside the category, without holding anything: an upload that is
   * slow or stalls holds up nobody. Only putting the finished file in place waits its turn,
   * and that is where quota and count are decided, so two uploads cannot share one quota.
   */
  async put(
    bundle: string,
    category: AssetCategory,
    rawName: string,
    body: NodeJS.ReadableStream,
    declaredLength?: number,
  ): Promise<AssetFile> {
    const name = assetFileName(rawName);
    if (name === undefined) throw new AssetError(400, 'That is not a name a file can have');
    if (!accepts(category.accept, name)) {
      throw new AssetError(
        415,
        `The category "${category.id}" takes ${category.accept?.join(', ')} only`,
      );
    }
    const tooLarge = () =>
      new AssetError(413, `A file may have at most ${this.maxFileBytes} bytes`);
    const overQuota = () =>
      new AssetError(
        413,
        `The category "${category.id}" may hold at most ${this.quotaBytes} bytes in all`,
      );
    // A file that differs from the new one only in case is the same file on Windows and
    // macOS. It is treated as the same everywhere, so the server behaves alike on all.
    const same = (other: string) => other.toLowerCase() === name.toLowerCase();
    const others = async () =>
      (await this.list(bundle, category.id)).filter((file) => !same(file.name));
    const sizeOf = (files: readonly AssetFile[]) => files.reduce((sum, file) => sum + file.size, 0);

    // Refused early where the request itself says enough. What decides is checked again
    // below, against what arrived and what the category holds by then.
    if (declaredLength !== undefined) {
      if (declaredLength > this.maxFileBytes) throw tooLarge();
      if (declaredLength > this.quotaBytes - sizeOf(await others())) throw overQuota();
    }

    const dir = this.#dir(bundle, category.id);
    const incoming = join(this.#root, INCOMING);
    await mkdir(incoming, { recursive: true });
    const temporary = join(incoming, randomUUID());
    try {
      const received = await this.#receive(body, temporary, tooLarge);
      return await this.#locked(bundle, category.id, async () => {
        const kept = await others();
        const isNew = kept.length === (await this.list(bundle, category.id)).length;
        if (isNew && kept.length >= this.maxFiles) {
          throw new AssetError(
            413,
            `The category "${category.id}" may hold at most ${this.maxFiles} files`,
          );
        }
        if (received > this.quotaBytes - sizeOf(kept)) throw overQuota();
        await mkdir(dir, { recursive: true });
        const before = await readdir(dir);
        await moveIntoPlace(temporary, join(dir, name));
        // Only now, with the new file in place, do other spellings of its name go. Where
        // the file system takes them for the same file, the one entry gets the new spelling.
        for (const entry of before) {
          if (!same(entry) || entry === name) continue;
          if (await sameFile(join(dir, entry), join(dir, name))) {
            await rename(join(dir, entry), join(dir, name)).catch(() => {});
          } else await rm(join(dir, entry), { force: true }).catch(() => {});
        }
        await this.#publish(bundle, category.id);
        return this.#describe(bundle, category.id, name, await stat(join(dir, name)));
      });
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      if (error instanceof AssetError) throw error;
      // Not the sender's doing, and nothing of the server's disk is told to them.
      throw new AssetError(500, 'The file could not be stored');
    }
  }

  /**
   * Writes what `body` delivers to a file and answers how many bytes that were. Gives up on
   * a body that is larger than a file may be, that ends early, or that sends nothing for
   * too long.
   */
  async #receive(
    body: NodeJS.ReadableStream,
    target: string,
    tooLarge: () => AssetError,
  ): Promise<number> {
    let received = 0;
    let failure: AssetError | undefined;
    const abort = new AbortController();
    const giveUp = () => {
      failure = new AssetError(408, 'The upload sent nothing for too long and was given up');
      abort.abort();
    };
    let idle = setTimeout(giveUp, this.#uploadIdleMs);
    const counting = new Transform({
      transform: (chunk: Buffer, _encoding, done) => {
        clearTimeout(idle);
        idle = setTimeout(giveUp, this.#uploadIdleMs);
        received += chunk.length;
        if (received > this.maxFileBytes) {
          failure = tooLarge();
          done(failure);
        } else done(null, chunk);
      },
    });
    try {
      await pipeline(body, counting, createWriteStream(target, { mode: 0o600 }), {
        signal: abort.signal,
      });
    } catch (error) {
      if (failure) throw failure;
      // The connection ended before the body did: that is the sender's side.
      if (isStreamEnd(error)) throw new AssetError(400, 'The upload did not arrive completely');
      throw error;
    } finally {
      clearTimeout(idle);
    }
    return received;
  }

  /**
   * Opens a stored file for reading. The size is that of the file that was opened, so it
   * stays right for what is read through the handle even if the name is given a new file
   * meanwhile. `undefined` under the conditions of `file`. The caller closes the handle.
   */
  async open(
    bundle: string,
    category: string,
    name: string,
  ): Promise<{ readonly handle: FileHandle; readonly size: number } | undefined> {
    const found = await this.file(bundle, category, name);
    if (!found) return undefined;
    let handle: FileHandle | undefined;
    try {
      handle = await open(found.path, 'r');
      const stats = await handle.stat();
      if (stats.isFile()) return { handle, size: stats.size };
    } catch {
      // Gone between looking and opening: not there.
    }
    await handle?.close().catch(() => {});
    return undefined;
  }

  /** Deletes a file. Answers whether there was one. */
  remove(bundle: string, category: string, name: string): Promise<boolean> {
    return this.#locked(bundle, category, async () => {
      const found = await this.file(bundle, category, name);
      if (!found) return false;
      await rm(found.path, { force: true });
      await this.#publish(bundle, category);
      return true;
    });
  }

  /**
   * Where a file of a category is on disk. `undefined` unless `name` is exactly the name of a
   * stored file: one an upload could have produced, directly in the folder of the category,
   * spelled as it is stored, and not reached through a link.
   */
  async file(
    bundle: string,
    category: string,
    name: string,
  ): Promise<{ readonly path: string; readonly size: number } | undefined> {
    if (assetFileName(name) !== name) return undefined;
    try {
      const dir = await realpath(this.#dir(bundle, category));
      const path = await realpath(join(dir, name));
      if (relative(dir, path) !== name) return undefined;
      const stats = await stat(path);
      return stats.isFile() ? { path, size: stats.size } : undefined;
    } catch {
      return undefined;
    }
  }

  #dir(bundle: string, category: string): string {
    return join(this.#root, bundle, category);
  }

  #describe(
    bundle: string,
    category: string,
    name: string,
    stats: { readonly size: number; readonly mtime: Date },
  ): AssetFile {
    return {
      name,
      size: stats.size,
      modified: stats.mtime.toISOString(),
      url: `/b/${bundle}/assets/${category}/${encodeURIComponent(name)}`,
    };
  }

  async #publish(bundle: string, category: string): Promise<void> {
    const entry = this.#registry.get(`${bundle}:${ASSETS_PREFIX}${category}`);
    if (!entry) return;
    const value = (await this.list(bundle, category)) as unknown as Json;
    entry.replicant.applyOp({ patches: [{ op: 'replace', path: '', value }] });
  }

  /** Runs `work` once every earlier change to the same category has finished. */
  #locked<T>(bundle: string, category: string, work: () => Promise<T>): Promise<T> {
    const key = `${bundle}/${category}`;
    const result = (this.#tails.get(key) ?? Promise.resolve()).then(work);
    const tail = result.catch(() => {});
    this.#tails.set(key, tail);
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return result;
  }
}

/** Whether an error of a stream says that it ended before its end, not that writing failed. */
function isStreamEnd(error: unknown): boolean {
  const { code } = error as NodeJS.ErrnoException;
  return code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ECONNRESET' || code === 'ABORT_ERR';
}

/** Whether two paths name one file, as on a file system that does not tell case apart. */
async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    const [first, second] = await Promise.all([
      stat(a, { bigint: true }),
      stat(b, { bigint: true }),
    ]);
    return first.dev === second.dev && first.ino === second.ino;
  } catch {
    return false;
  }
}

/**
 * Moves a finished upload to its name, in place of a file that is there. On Windows that
 * fails for a moment while something else has the old file open, so it is tried again a few
 * times before it counts as failed.
 */
async function moveIntoPlace(from: string, to: string): Promise<void> {
  for (const wait of [...RENAME_RETRY_MS, undefined]) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException;
      if (wait === undefined || code === undefined || !BUSY.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}
