import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isLoopbackRegistryUrl,
  MAX_INDEX_BYTES,
  MoonCGError,
  parseRegistryIndex,
  type RegistryEntry,
  type RegistryIndex,
  registryUrlProblem,
} from '@mooncg/core';
import { withoutCredentials } from '../install/git.js';
import { errorMessage, type Logger } from '../kernel/logger.js';
import type { SettingsStore } from '../storage/replicant-store.js';
import { getJson, type JsonAnswer } from './https.js';

/** How often the indexes are fetched again unless configured otherwise: every 6 hours. */
export const DEFAULT_REGISTRY_REFRESH_MS = 6 * 60 * 60_000;
/** How long a reason an index could not be used may be, as it is told and logged. */
const MAX_ERROR_LENGTH = 500;

/**
 * A reason as it may be told and logged: what an index server answered is quoted in it, so
 * control and format characters go, and it is cut short.
 */
function told(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
  const plain = text.replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}\u2028\u2029]+/gu, ' ').trim();
  return plain.length <= MAX_ERROR_LENGTH ? plain : `${plain.slice(0, MAX_ERROR_LENGTH - 1)}…`;
}

/** How long fetching one index may take. */
export const REGISTRY_TIMEOUT_MS = 30_000;
/** How many indexes there may be, configured and added together. */
export const MAX_INDEXES = 20;
/** The setting the indexes added in the dashboard or on the command line are kept in. */
const SETTING = 'registryIndexes';

/**
 * Where indexes are fetched from. The built-in one speaks `https:` (and `http:` on this
 * machine); another kind of source could be added for another scheme. Nothing but the index
 * itself is ever fetched through it.
 */
export interface RegistrySource {
  /** The URL schemes it fetches, such as `https:`. */
  readonly schemes: readonly string[];
  load(
    url: string,
    held: { readonly etag?: string | undefined; readonly lastModified?: string | undefined },
    options: { readonly timeoutMs: number; readonly signal: AbortSignal },
  ): Promise<JsonAnswer>;
}

/** The source of every `https://` index. */
export const httpsSource: RegistrySource = {
  schemes: ['https:', 'http:'],
  load: (url, held, options) => getJson(url, { ...held, ...options, maxBytes: MAX_INDEX_BYTES }),
};

/** How an index stands, as administrators are told: its address without credentials. */
export interface IndexState {
  readonly id: string;
  readonly url: string;
  /** `config`: set in the configuration, changed there. `added`: added at run time. */
  readonly origin: 'config' | 'added';
  /**
   * `pending`: not fetched yet. `ok`: the last fetch worked. `stale`: it did not, and the
   * last good copy is used. `error`: it did not and there is no copy.
   */
  readonly status: 'pending' | 'ok' | 'stale' | 'error';
  readonly error?: string | undefined;
  readonly title?: string | undefined;
  readonly entries: number;
  /** When the copy in use was fetched. */
  readonly fetchedAt?: string | undefined;
  /** When it was last tried. */
  readonly checkedAt?: string | undefined;
}

/** An entry of an index, with the addresses of its archives resolved against the index. */
export interface ListedEntry {
  readonly index: {
    readonly id: string;
    readonly url: string;
    readonly title?: string | undefined;
  };
  readonly entry: RegistryEntry;
}

/** What is kept of an index in `<data-dir>/registry/<id>.json`. */
interface Cached {
  readonly fetchedAt: string;
  readonly etag?: string | undefined;
  readonly lastModified?: string | undefined;
  readonly index: RegistryIndex;
}

interface Held {
  /** As it was given: it may hold credentials. */
  readonly url: string;
  readonly origin: IndexState['origin'];
  status: IndexState['status'];
  error?: string | undefined;
  checkedAt?: string | undefined;
  copy?: Cached | undefined;
  /** The fetch that runs now, which a second request joins. */
  running?: Promise<void> | undefined;
}

/**
 * The id of an index: a hash of its address without the user name and password, so that new
 * credentials for the same index keep what was installed from it tied to it.
 */
export function indexId(url: string): string {
  let key = url;
  if (URL.canParse(url)) {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    key = parsed.href;
  }
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * An index entry whose archive addresses are absolute, resolved against the index address
 * without its credentials: they are asked for when the archive is fetched, so they are never
 * kept with what was installed.
 */
function resolved(entry: RegistryEntry, index: string): RegistryEntry {
  const base = new URL(index);
  base.username = '';
  base.password = '';
  return {
    ...entry,
    versions: entry.versions.map((version) =>
      version.source.type === 'zip'
        ? {
            ...version,
            source: { ...version.source, url: new URL(version.source.url, base).href },
          }
        : version,
    ),
  };
}

export interface RegistryOptions {
  readonly dataDir: string;
  readonly store: Pick<SettingsStore, 'get' | 'set'>;
  /** The indexes the configuration names; they cannot be removed at run time. */
  readonly configured: readonly string[];
  readonly refreshMs?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly logger: Logger;
  /** Where indexes are fetched from, by URL scheme. Defaults to `httpsSource`. */
  readonly sources?: readonly RegistrySource[] | undefined;
  readonly now?: (() => number) | undefined;
}

/**
 * The registry indexes this server knows: those the configuration names and those an
 * administrator added, each fetched at start and every few hours, and on request. The last
 * good copy of each is kept in the data folder and used when a fetch fails. An index only ever
 * makes the server fetch the index itself; what it lists is fetched when an administrator
 * installs it.
 */
export class Registry {
  readonly #options: RegistryOptions;
  readonly #log: Logger;
  readonly #dir: string;
  readonly #held = new Map<string, Held>();
  readonly #sources: readonly RegistrySource[];
  readonly #shutdown = new AbortController();
  #timer: ReturnType<typeof setInterval> | undefined;
  #refreshing: Promise<void> | undefined;
  readonly #now: () => number;

  constructor(options: RegistryOptions) {
    this.#options = options;
    this.#log = options.logger.child('registry');
    this.#dir = join(options.dataDir, 'registry');
    this.#sources = options.sources ?? [httpsSource];
    this.#now = options.now ?? Date.now;
  }

  /** How often the indexes are fetched again. */
  get refreshMs(): number {
    return this.#options.refreshMs ?? DEFAULT_REGISTRY_REFRESH_MS;
  }

  /**
   * Takes up the configured and the added indexes with their cached copies, fetches them in
   * the background and then every `refreshMs`. A configured address that is unusable is
   * logged and left out.
   */
  async start(): Promise<void> {
    for (const url of this.#options.configured) {
      const problem = registryUrlProblem(url);
      if (problem !== undefined) {
        this.#log.error(`The registry index ${withoutCredentials(url)} is not used: ${problem}`);
        continue;
      }
      this.#hold(url, 'config');
    }
    let added: unknown;
    try {
      added = await this.#options.store.get(SETTING);
    } catch (error) {
      this.#log.error(`The added registry indexes could not be read: ${errorMessage(error)}`);
    }
    for (const url of Array.isArray(added) ? added : []) {
      if (typeof url === 'string' && registryUrlProblem(url) === undefined)
        this.#hold(url, 'added');
    }
    for (const [id, held] of this.#held) held.copy = await this.#readCopy(id, held.url);
    for (const held of this.#held.values()) if (held.copy) held.status = 'stale';
    this.#refreshing = this.refresh();
    this.#timer = setInterval(() => void this.refresh(), this.refreshMs);
    this.#timer.unref();
  }

  /** Resolves once the fetch that was started last is over. */
  async refreshed(): Promise<void> {
    await this.#refreshing;
  }

  /**
   * Stops fetching: what runs is ended, and no new fetch starts. Resolves once what ran is
   * over, so nothing is written after that.
   */
  async close(): Promise<void> {
    clearInterval(this.#timer);
    this.#shutdown.abort();
    await Promise.allSettled([...this.#held.values()].map((held) => held.running));
  }

  /** Fetches every index again. A refresh that runs is joined, not doubled. */
  refresh(): Promise<void> {
    const all = Promise.all([...this.#held.keys()].map((id) => this.#fetch(id))).then(() => {});
    this.#refreshing = all;
    return all;
  }

  /**
   * Every index, in the order they were configured and added. `kinds` counts the entries of
   * those kinds alone, for whoever may read only them.
   */
  indexes(kinds?: readonly RegistryEntry['kind'][]): IndexState[] {
    return [...this.#held].map(([id, held]) => this.#state(id, held, kinds));
  }

  /** The entries of every index that has a copy, with their archive addresses resolved. */
  entries(): ListedEntry[] {
    return [...this.#held].flatMap(([id, held]) => {
      const copy = held.copy;
      if (!copy) return [];
      const index = {
        id,
        url: withoutCredentials(held.url),
        ...(copy.index.title === undefined ? {} : { title: copy.index.title }),
      };
      return copy.index.entries.map((entry) => ({ index, entry: resolved(entry, held.url) }));
    });
  }

  /** Adds an index, remembers it, and fetches it. Rejects for an address that is not usable. */
  async add(url: string, by: string): Promise<IndexState> {
    if (typeof url !== 'string') throw new MoonCGError('bad_request', '"url" must be an address');
    const trimmed = url.trim();
    const problem = registryUrlProblem(trimmed);
    if (problem !== undefined) throw new MoonCGError('invalid', problem);
    const id = indexId(trimmed);
    if (this.#held.has(id)) throw new MoonCGError('conflict', 'This index is listed already');
    if (this.#held.size >= MAX_INDEXES) {
      throw new MoonCGError('conflict', `There may be at most ${MAX_INDEXES} indexes`);
    }
    this.#hold(trimmed, 'added');
    try {
      await this.#saveAdded();
    } catch (error) {
      this.#held.delete(id);
      throw error;
    }
    this.#log.info(`${by} added the registry index ${withoutCredentials(trimmed)}`);
    const held = this.#held.get(id) as Held;
    await this.#fetch(id);
    return this.#state(id, held);
  }

  /** Removes an added index and its copy. A configured one is changed in the configuration. */
  async remove(id: string, by: string): Promise<void> {
    const held = this.#held.get(id);
    if (!held) throw new MoonCGError('not_found', 'There is no such index');
    if (held.origin === 'config') {
      throw new MoonCGError(
        'conflict',
        'This index is set in the configuration of the server; remove it there',
      );
    }
    this.#held.delete(id);
    await this.#saveAdded();
    // A fetch that runs keeps no copy once it sees the index gone; this one goes now.
    await this.#removeCopy(id);
    this.#log.info(`${by} removed the registry index ${withoutCredentials(held.url)}`);
  }

  /** The address of an index as it was given, credentials included, for fetching from it. */
  address(id: string): string | undefined {
    return this.#held.get(id)?.url;
  }

  #hold(url: string, origin: IndexState['origin']): void {
    const id = indexId(url);
    if (this.#held.has(id)) return;
    if (this.#held.size >= MAX_INDEXES) {
      this.#log.error(
        `The registry index ${withoutCredentials(url)} is not used: too many indexes`,
      );
      return;
    }
    this.#held.set(id, { url, origin, status: 'pending' });
  }

  #state(id: string, held: Held, kinds?: readonly RegistryEntry['kind'][]): IndexState {
    const { copy } = held;
    const entries = copy?.index.entries.filter(
      (entry) => kinds === undefined || kinds.includes(entry.kind),
    );
    return {
      id,
      url: withoutCredentials(held.url),
      origin: held.origin,
      status: held.status,
      ...(held.error === undefined ? {} : { error: held.error }),
      ...(copy?.index.title === undefined ? {} : { title: copy.index.title }),
      entries: entries?.length ?? 0,
      ...(copy === undefined ? {} : { fetchedAt: copy.fetchedAt }),
      ...(held.checkedAt === undefined ? {} : { checkedAt: held.checkedAt }),
    };
  }

  #saveAdded(): Promise<void> {
    const added = [...this.#held.values()]
      .filter((held) => held.origin === 'added')
      .map((held) => held.url);
    return this.#options.store.set(SETTING, added);
  }

  #fetch(id: string): Promise<void> {
    const held = this.#held.get(id);
    if (!held) return Promise.resolve();
    held.running ??= this.#load(id, held).finally(() => {
      held.running = undefined;
    });
    return held.running;
  }

  async #load(id: string, held: Held): Promise<void> {
    if (this.#shutdown.signal.aborted) return;
    const shown = withoutCredentials(held.url);
    const scheme = URL.canParse(held.url) ? new URL(held.url).protocol : '';
    const source = this.#sources.find((candidate) => candidate.schemes.includes(scheme));
    held.checkedAt = new Date(this.#now()).toISOString();
    try {
      if (!source) throw new MoonCGError('invalid', `No source can fetch ${scheme} addresses`);
      const answer = await source.load(
        held.url,
        { etag: held.copy?.etag, lastModified: held.copy?.lastModified },
        {
          timeoutMs: this.#options.timeoutMs ?? REGISTRY_TIMEOUT_MS,
          signal: this.#shutdown.signal,
        },
      );
      if (answer.status === 'not-modified' && held.copy) {
        held.status = 'ok';
        held.error = undefined;
        return;
      }
      if (answer.status === 'not-modified') throw new MoonCGError('invalid', 'nothing to use');
      // Only an index on this machine may list addresses on this machine.
      const parsed = parseRegistryIndex(answer.value, {
        loopback: isLoopbackRegistryUrl(held.url),
      });
      if (!parsed.ok) {
        throw new MoonCGError(
          'invalid',
          `it is no valid index: ${parsed.errors
            .map(({ path, message }) => (path === '' ? message : `${path}: ${message}`))
            .join('; ')}`,
        );
      }
      const copy: Cached = {
        fetchedAt: new Date(this.#now()).toISOString(),
        ...(answer.etag === undefined ? {} : { etag: answer.etag }),
        ...(answer.lastModified === undefined ? {} : { lastModified: answer.lastModified }),
        index: parsed.index,
      };
      // Removed meanwhile, or the server stops: what arrived belongs to nobody.
      const gone = () => this.#held.get(id) !== held || this.#shutdown.signal.aborted;
      if (gone()) return;
      held.copy = copy;
      held.status = 'ok';
      held.error = undefined;
      await this.#writeCopy(id, copy).catch((error) => {
        this.#log.warn(`The copy of ${shown} could not be kept: ${told(errorMessage(error))}`);
      });
      // Removed while it was written: the copy is removed again.
      if (this.#held.get(id) !== held) await this.#removeCopy(id);
    } catch (error) {
      if (this.#shutdown.signal.aborted) return;
      held.error = told(withoutCredentials(errorMessage(error)));
      held.status = held.copy ? 'stale' : 'error';
      this.#log.warn(
        `The registry index ${shown} could not be used: ${held.error}` +
          (held.copy ? `; the copy from ${held.copy.fetchedAt} is used` : ''),
      );
    }
  }

  async #readCopy(id: string, url: string): Promise<Cached | undefined> {
    try {
      const stored = JSON.parse(await readFile(join(this.#dir, `${id}.json`), 'utf8')) as Cached;
      // Checked again as if it had just arrived: nothing kept is believed.
      const parsed = parseRegistryIndex(stored.index, { loopback: isLoopbackRegistryUrl(url) });
      if (!parsed.ok || typeof stored.fetchedAt !== 'string') return undefined;
      const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
      return {
        fetchedAt: stored.fetchedAt,
        etag: text(stored.etag),
        lastModified: text(stored.lastModified),
        index: parsed.index,
      };
    } catch {
      return undefined;
    }
  }

  async #removeCopy(id: string): Promise<void> {
    await rm(join(this.#dir, `${id}.json`), { force: true }).catch(() => {});
  }

  async #writeCopy(id: string, copy: Cached): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const file = join(this.#dir, `${id}.json`);
    await writeFile(`${file}.tmp`, `${JSON.stringify(copy)}\n`);
    await rename(`${file}.tmp`, file);
  }
}
