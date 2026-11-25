import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { errorMessage } from '../kernel/logger.js';
import { withoutCredentials } from './git.js';

/**
 * The entry of a registry index something was installed from. Only what was installed from
 * an index entry is ever offered updates from that index entry: an index that lists the name
 * of a bundle installed otherwise claims nothing by that.
 */
export interface CatalogOrigin {
  /** The id of the index: a hash of its address without credentials. */
  readonly index: string;
  /** The address of the index without credentials, for people. */
  readonly indexUrl: string;
  readonly kind: 'bundle' | 'module';
  readonly name: string;
  /** The version of the entry that was installed. */
  readonly version: string;
}

/** Where the files of an installed bundle came from. */
export interface BundleSource {
  /**
   * `git`: a repository. `path`: a folder of the server's machine. `zip`: an archive on the
   * server's machine. `upload`: an archive that was sent to the server. `url`: an archive
   * downloaded from an address, checked against its SHA-256.
   */
  readonly type: 'git' | 'path' | 'zip' | 'upload' | 'url';
  /** The address of a repository or an archive, as it was given: it may hold credentials. */
  readonly url?: string | undefined;
  /** For `url`: the SHA-256 the archive had to have. */
  readonly sha256?: string | undefined;
  /** The registry index entry it was installed from, if it was. */
  readonly catalog?: CatalogOrigin | undefined;
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
  readonly sha256?: string | undefined;
  readonly catalog?: CatalogOrigin | undefined;
}

/** A source the server can fetch from by itself. */
export type FetchableSource =
  | {
      readonly type: 'git';
      readonly url: string;
      readonly ref?: string | undefined;
      /** The commit the fetched ref must be, as an index pins it. */
      readonly commit?: string | undefined;
      /**
       * The address of the registry index that lists the repository: only an index on this
       * machine may point to this machine. Set by the server for what comes from the catalog,
       * never taken from a request, and not kept with the source.
       */
      readonly index?: string | undefined;
    }
  | { readonly type: 'path'; readonly path: string }
  | { readonly type: 'zip'; readonly path: string }
  | {
      readonly type: 'url';
      readonly url: string;
      readonly sha256: string;
      /**
       * The address of the registry index that lists the archive, credentials included. Only
       * an index on this machine may point to this machine, and the credentials of the index
       * go to its own origin. Set by the server for what comes from the catalog, never taken
       * from a request, and not kept with the source.
       */
      readonly index?: string | undefined;
    };

export function publicSource(source: BundleSource): PublicSource {
  const { type, ref, commit, sha256, catalog } = source;
  const from = catalog === undefined ? {} : { catalog };
  if (type === 'git' || type === 'url') {
    return {
      type,
      location: withoutCredentials(source.url ?? ''),
      ...(ref === undefined ? {} : { ref }),
      ...(commit === undefined ? {} : { commit }),
      ...(sha256 === undefined ? {} : { sha256 }),
      ...from,
    };
  }
  if (type === 'upload') return { type, location: source.filename ?? 'uploaded archive', ...from };
  return { type, location: source.path ?? '', ...from };
}

/**
 * What to fetch to get the bundle again, for an update that names no source. A repository
 * is asked for the same ref as before, which for a branch is its newest commit. An upload
 * cannot be fetched again. What came from an index entry is fetched as that entry said: a
 * repository at the commit it named, and with the rules of the index, an archive with the
 * credentials and the rules of the index, which `indexAddress` gives by its id.
 */
export function refetchable(
  source: BundleSource | undefined,
  indexAddress?: ((id: string) => string | undefined) | undefined,
): FetchableSource | undefined {
  const listed = source?.catalog;
  if (source?.type === 'git' && source.url !== undefined) {
    const index = listed === undefined ? undefined : indexAddress?.(listed.index);
    return {
      type: 'git',
      url: source.url,
      ...(source.ref === undefined ? {} : { ref: source.ref }),
      ...(listed === undefined || source.commit === undefined ? {} : { commit: source.commit }),
      ...(index === undefined ? {} : { index }),
    };
  }
  if (source?.type === 'url' && source.url !== undefined && source.sha256 !== undefined) {
    const index = listed === undefined ? undefined : indexAddress?.(listed.index);
    return {
      type: 'url',
      url: source.url,
      sha256: source.sha256,
      ...(index === undefined ? {} : { index }),
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
 * is for the server alone, and it is written readable by its owner only (mode 0600) where the
 * platform has such modes.
 */
export class BundleSources {
  readonly #dataDir: string;
  readonly #file: string;
  readonly #warn: (message: string) => void;
  #records: Map<string, SourceRecord> | undefined;
  /** The last write, so that two changes do not cross. */
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: {
    readonly dataDir: string;
    readonly warn?: (message: string) => void;
    /** The file in the data folder, for another kind of thing installed than bundles. */
    readonly file?: string | undefined;
  }) {
    this.#dataDir = options.dataDir;
    this.#file = options.file ?? SOURCES_FILE;
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
      const stored: unknown = JSON.parse(await readFile(join(this.#dataDir, this.#file), 'utf8'));
      if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
        throw new Error('it is no object');
      }
      records = new Map(Object.entries(stored as Record<string, SourceRecord>));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.#warn(
          `${this.#file} could not be read, so where what is installed came from is not known: ${errorMessage(error)}`,
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
        const file = join(this.#dataDir, this.#file);
        // For the owner alone, as a Git address may hold credentials. The mode is set again
        // for a file left over that was made with another. On Windows, where files have no
        // such mode, the access list of the data folder is what protects it.
        await writeFile(`${file}.tmp`, `${JSON.stringify(sorted, null, 2)}\n`, { mode: 0o600 });
        if (process.platform !== 'win32') await chmod(`${file}.tmp`, 0o600);
        await rename(`${file}.tmp`, file);
      });
    this.#tail = done;
    return done;
  }
}
