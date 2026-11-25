import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { errorMessage } from '../kernel/logger.js';
import { withoutCredentials } from './git.js';

/** Where the files of an installed bundle came from. */
export interface BundleSource {
  /**
   * `git`: a repository. `path`: a folder of the server's machine. `zip`: an archive on the
   * server's machine. `upload`: an archive that was sent to the server.
   */
  readonly type: 'git' | 'path' | 'zip' | 'upload';
  /** The address of a repository, as it was given: it may hold credentials. */
  readonly url?: string | undefined;
  /** The branch, tag or commit that was asked for, if one was. */
  readonly ref?: string | undefined;
  /** The commit that was checked out. */
  readonly commit?: string | undefined;
  readonly path?: string | undefined;
  /** What the uploaded archive was called. */
  readonly filename?: string | undefined;
}

export interface SourceRecord {
  readonly source: BundleSource;
  /** The version that was installed from it. */
  readonly version: string;
  /** When, as an ISO 8601 time. */
  readonly installedAt: string;
  /** Who installed it. */
  readonly by: string;
}

/** A source as the API and the log tell it: without credentials. */
export interface PublicSource {
  readonly type: BundleSource['type'];
  readonly location: string;
  readonly ref?: string | undefined;
  readonly commit?: string | undefined;
}

/** A source the server can fetch from by itself. */
export type FetchableSource =
  | { readonly type: 'git'; readonly url: string; readonly ref?: string | undefined }
  | { readonly type: 'path'; readonly path: string }
  | { readonly type: 'zip'; readonly path: string };

export function publicSource(source: BundleSource): PublicSource {
  const { type, ref, commit } = source;
  if (type === 'git') {
    return {
      type,
      location: withoutCredentials(source.url ?? ''),
      ...(ref === undefined ? {} : { ref }),
      ...(commit === undefined ? {} : { commit }),
    };
  }
  if (type === 'upload') return { type, location: source.filename ?? 'uploaded archive' };
  return { type, location: source.path ?? '' };
}

/**
 * What to fetch to get the bundle again, for an update that names no source. A repository
 * is asked for the same ref as before, which for a branch is its newest commit. An upload
 * cannot be fetched again.
 */
export function refetchable(source: BundleSource | undefined): FetchableSource | undefined {
  if (source?.type === 'git' && source.url !== undefined) {
    return {
      type: 'git',
      url: source.url,
      ...(source.ref === undefined ? {} : { ref: source.ref }),
    };
  }
  if ((source?.type === 'path' || source?.type === 'zip') && source.path !== undefined) {
    return { type: source.type, path: source.path };
  }
  return undefined;
}

const SOURCES_FILE = 'bundle-sources.json';

/**
 * Remembers where each installed bundle came from, in `<data-dir>/bundle-sources.json`. The
 * file may hold credentials, as part of a Git address; like the rest of the data folder it
 * is for the server alone.
 */
export class BundleSources {
  readonly #dataDir: string;
  readonly #warn: (message: string) => void;
  #records: Map<string, SourceRecord> | undefined;
  /** The last write, so that two changes do not cross. */
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: { readonly dataDir: string; readonly warn?: (message: string) => void }) {
    this.#dataDir = options.dataDir;
    this.#warn = options.warn ?? (() => {});
  }

  async get(name: string): Promise<SourceRecord | undefined> {
    return (await this.#load()).get(name);
  }

  async all(): Promise<Record<string, SourceRecord>> {
    return Object.fromEntries([...(await this.#load())].sort(([a], [b]) => a.localeCompare(b)));
  }

  set(name: string, record: SourceRecord): Promise<void> {
    return this.#change((records) => records.set(name, record));
  }

  delete(name: string): Promise<void> {
    return this.#change((records) => records.delete(name));
  }

  async #load(): Promise<Map<string, SourceRecord>> {
    if (this.#records) return this.#records;
    let records = new Map<string, SourceRecord>();
    try {
      const stored: unknown = JSON.parse(await readFile(join(this.#dataDir, SOURCES_FILE), 'utf8'));
      if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
        throw new Error('it is no object');
      }
      records = new Map(Object.entries(stored as Record<string, SourceRecord>));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.#warn(
          `${SOURCES_FILE} could not be read, so where the bundles came from is not known: ${errorMessage(error)}`,
        );
      }
    }
    this.#records ??= records;
    return this.#records;
  }

  #change(change: (records: Map<string, SourceRecord>) => void): Promise<void> {
    const done = this.#tail
      .catch(() => {})
      .then(async () => {
        const records = await this.#load();
        change(records);
        const sorted = Object.fromEntries([...records].sort(([a], [b]) => a.localeCompare(b)));
        // Written beside the file and moved over it: the file is whole at every moment.
        await mkdir(this.#dataDir, { recursive: true });
        const file = join(this.#dataDir, SOURCES_FILE);
        await writeFile(`${file}.tmp`, `${JSON.stringify(sorted, null, 2)}\n`);
        await rename(`${file}.tmp`, file);
      });
    this.#tail = done;
    return done;
  }
}
