import {
  bundlePermission,
  type ChangeArea,
  changeArea,
  isIgnoredPath,
  type Manifest,
  planForAreas,
  planReload,
  type Stylesheet,
  type Timers,
} from '@mooncg/core';
import type { BundleManager, BundleWatch } from '../bundles/manager.js';
import type { GraphicInstances } from '../graphics/instances.js';
import { errorMessage, type Logger } from '../kernel/logger.js';
import type { ConnectedPages } from './pages.js';

/** How long the files of a bundle must have been quiet before a change is acted on. */
export const WATCH_DEBOUNCE_MS = 150;

/** How many changed paths a log line names before it only counts the rest. */
const NAMED_PATHS = 3;

/** One watched folder. */
export interface FileWatcher {
  /** Resolves once changes are being reported. A change made before that may be missed. */
  readonly ready?: Promise<void> | undefined;
  /** Resolves once nothing holds on to the folder any more. */
  close(): Promise<void>;
}

/**
 * Watches a folder and everything below it. `onChange` is told the path of every file that
 * was added, changed or deleted, relative to the folder.
 */
export type CreateFileWatcher = (
  dir: string,
  onChange: (path: string) => void,
  onError: (error: unknown) => void,
) => FileWatcher;

export interface BundleWatchersOptions {
  readonly manager: Pick<
    BundleManager,
    'get' | 'reloadIfValid' | 'restartExtension' | 'enable' | 'notePending'
  >;
  readonly pages: Pick<ConnectedPages, 'reload' | 'restyle'>;
  readonly instances: Pick<GraphicInstances, 'markOutOfDate'>;
  readonly logger: Logger;
  /** Whether the server runs in dev mode. Only then is a graphic reloaded by a change. */
  readonly dev: boolean;
  /** Whether the installation is on air. Changes then wait instead of being acted on. */
  readonly isOnAir: () => boolean;
  /** What watches a folder: chokidar on a real server, a stand-in in tests. */
  readonly createWatcher: CreateFileWatcher;
  /** For the debounce. Defaults to real time. */
  readonly timers?: Timers | undefined;
  readonly debounceMs?: number | undefined;
}

interface Watched {
  readonly dir: string;
  readonly watcher: FileWatcher;
  /** The paths that changed since the last time they were acted on. */
  readonly changed: Set<string>;
  /** What changed while the installation was on air. */
  readonly pending: Set<ChangeArea>;
  timer?: unknown;
}

/** The schema files a manifest names, relative to the bundle. */
/**
 * The changed stylesheets with the permission the server checks before it sends each: that of
 * the page entry a file is, or any permission of the bundle, as `/b/<bundle>/<area>/*` does.
 */
function stylesheets(
  bundle: string,
  manifest: Manifest | undefined,
  files: readonly string[],
): Stylesheet[] {
  const entries = manifest ? [...manifest.panels, ...manifest.dialogs, ...manifest.graphics] : [];
  return files.map((file) => ({
    file,
    permission: bundlePermission(bundle, entries.find((entry) => entry.file === file)?.requires),
  }));
}

function schemaFiles(manifest: Manifest | undefined): string[] {
  if (!manifest) return [];
  const replicants = Object.values(manifest.replicants).flatMap(({ schema }) => schema ?? []);
  return manifest.config ? [...replicants, manifest.config.schema] : replicants;
}

/**
 * Live reload: one watcher per bundle folder. It only collects what changed; what a change
 * leads to is decided by `planForAreas` in core, and carried out through the bundle manager
 * like any other change, so it waits its turn behind whatever else happens to the bundle.
 * The bundle manager says which folders are watched and when one must be let go of.
 */
export class BundleWatchers implements BundleWatch {
  readonly #options: BundleWatchersOptions;
  readonly #timers: Timers;
  readonly #create: CreateFileWatcher;
  readonly #watched = new Map<string, Watched>();
  /** What is being carried out right now, so that tests and shutdown can wait for it. */
  readonly #working = new Set<Promise<void>>();
  #disposed = false;

  constructor(options: BundleWatchersOptions) {
    this.#options = options;
    this.#timers = options.timers ?? { setTimeout, clearTimeout };
    this.#create = options.createWatcher;
  }

  open(name: string, dir: string): void {
    if (this.#disposed || this.#watched.has(name)) return;
    const log = this.#options.logger.child(`bundle:${name}`);
    try {
      const watcher = this.#create(
        dir,
        (path) => this.#changed(name, path),
        (error) => log.warn(`Watching its files failed: ${errorMessage(error)}`),
      );
      this.#watched.set(name, { dir, watcher, changed: new Set(), pending: new Set() });
    } catch (error) {
      log.warn(`Its files cannot be watched: ${errorMessage(error)}`);
    }
  }

  /**
   * Lets go of a bundle folder. What changed and was not acted on yet is forgotten: whoever
   * closes the watch is about to change the folder themselves. Work that is under way is not
   * waited for; it goes through the bundle manager, which may be the one asking.
   */
  async close(name: string): Promise<void> {
    const watched = this.#watched.get(name);
    if (!watched) return;
    this.#watched.delete(name);
    this.#timers.clearTimeout(watched.timer);
    try {
      await watched.watcher.close();
    } catch (error) {
      this.#options.logger
        .child(`bundle:${name}`)
        .warn(`The watch on its files did not close cleanly: ${errorMessage(error)}`);
    }
  }

  /** Resolves once every watcher that is open now reports changes. */
  async ready(): Promise<void> {
    await Promise.all([...this.#watched.values()].map(({ watcher }) => watcher.ready));
  }

  /** The names of the bundles whose folders are watched. */
  watching(): string[] {
    return [...this.#watched.keys()].sort();
  }

  /** Carries out what changed while the installation was on air. For when the lock is released. */
  async flushPending(): Promise<void> {
    for (const [name, watched] of [...this.#watched]) {
      if (watched.pending.size === 0) continue;
      const areas = [...watched.pending];
      watched.pending.clear();
      this.#options.manager.notePending(name, []);
      this.#start(name, areas, 'changes that waited for On Air to end');
    }
    await this.idle();
  }

  /** Resolves once nothing is being carried out. Timers that have not fired are not waited for. */
  async idle(): Promise<void> {
    while (this.#working.size > 0) await Promise.all([...this.#working]);
  }

  /** Closes every watcher and drops every timer. Nothing is watched afterwards. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    await Promise.all([...this.#watched.keys()].map((name) => this.close(name)));
  }

  #changed(name: string, path: string): void {
    const watched = this.#watched.get(name);
    if (!watched || isIgnoredPath(path)) return;
    // Which files are schemas is the manifest's to say, and that may have changed by the
    // time the changes are acted on; so nothing but what is ignored is sorted out here.
    const { manifest } = this.#options.manager.get(name) ?? {};
    if (changeArea(path, schemaFiles(manifest)) === 'other') return;
    watched.changed.add(path.split('\\').join('/'));
    this.#timers.clearTimeout(watched.timer);
    watched.timer = this.#timers.setTimeout(
      () => this.#flush(name),
      this.#options.debounceMs ?? WATCH_DEBOUNCE_MS,
    );
  }

  #flush(name: string): void {
    const watched = this.#watched.get(name);
    if (!watched) return;
    const paths = [...watched.changed].sort();
    watched.changed.clear();
    const { manifest } = this.#options.manager.get(name) ?? {};
    const files = schemaFiles(manifest);
    const areas = [...new Set(paths.map((path) => changeArea(path, files)))].filter(
      (area) => area !== 'other',
    );
    if (areas.length === 0) return;
    const named = paths.slice(0, NAMED_PATHS).join(', ');
    const more = paths.length > NAMED_PATHS ? ` and ${paths.length - NAMED_PATHS} more` : '';
    const what = `${named}${more} changed`;
    if (this.#options.isOnAir()) {
      this.#wait(name, watched, areas, what);
      return;
    }
    this.#start(name, areas, what, paths);
  }

  /** Notes changes that are not acted on while the installation is on air. */
  #wait(name: string, watched: Watched, areas: readonly ChangeArea[], what: string): void {
    for (const area of areas) watched.pending.add(area);
    this.#options.manager.notePending(name, [...watched.pending]);
    this.#options.logger
      .child(`bundle:${name}`)
      .info(`${what}; MoonCG is on air, so nothing is reloaded until On Air is switched off`);
  }

  /**
   * `paths` are the files that changed, when they are known. Changes that waited for On Air
   * to end are known by their areas only, and then reload the pages even for a stylesheet.
   */
  #start(name: string, areas: readonly ChangeArea[], what: string, paths?: string[]): void {
    const work = this.#carryOut(name, areas, what, paths).finally(() => this.#working.delete(work));
    this.#working.add(work);
  }

  async #carryOut(
    name: string,
    areas: readonly ChangeArea[],
    what: string,
    paths: string[] | undefined,
  ): Promise<void> {
    const { manager, pages, instances, dev } = this.#options;
    const log = this.#options.logger.child(`bundle:${name}`);
    const record = manager.get(name);
    if (!record) return;
    const options = {
      dev,
      devUrl: record.manifest?.dev !== undefined,
      schemaFiles: schemaFiles(record.manifest),
    };
    const plan = paths ? planReload(paths, options) : planForAreas(areas, options);
    try {
      if (plan.bundle === 'reload') {
        log.info(`${what}: reloading the bundle`);
        // With an invalid manifest the bundle keeps running and says why; the pages are
        // served from disk either way, so they are still told below.
        await manager.reloadIfValid(name);
      } else if (plan.bundle === 'restart-extension') {
        // A bundle that failed, perhaps over the very file that was just fixed, gets a try.
        const failed = record.state === 'failed';
        log.info(`${what}: ${failed ? 'starting the bundle again' : 'restarting the extension'}`);
        await (failed ? manager.enable(name) : manager.restartExtension(name));
      }
    } catch (error) {
      // The lock closed while the change was on its way: it waits like the others.
      const watched = this.#watched.get(name);
      if (watched && this.#options.isOnAir()) {
        this.#wait(name, watched, areas, what);
        return;
      }
      log.warn(`${what}, but it could not be applied: ${errorMessage(error)}`);
      return;
    }
    if (plan.panels) {
      const told = pages.reload(name, 'panels');
      log.info(`${what}: reloaded ${told} panel ${told === 1 ? 'page' : 'pages'}`);
    }
    if (plan.panelStyles?.length) {
      const told = pages.restyle(
        name,
        'panels',
        stylesheets(name, record.manifest, plan.panelStyles),
      );
      log.info(
        `${what}: swapped the stylesheets of ${told} panel ${told === 1 ? 'page' : 'pages'}`,
      );
    }
    if (plan.graphicStyles?.length) {
      const told = pages.restyle(
        name,
        'graphics',
        stylesheets(name, record.manifest, plan.graphicStyles),
      );
      log.info(
        `${what}: swapped the stylesheets of ${told} graphic ${told === 1 ? 'page' : 'pages'}`,
      );
    }
    if (plan.graphics === 'reload') {
      const told = pages.reload(name, 'graphics');
      log.info(`${what}: reloaded ${told} graphic ${told === 1 ? 'page' : 'pages'}`);
    } else if (plan.graphics === 'mark-out-of-date') {
      const marked = instances.markOutOfDate(name);
      log.info(
        `${what}: ${marked} open graphic ${marked === 1 ? 'page is' : 'pages are'} now out of date. ` +
          'Reload them from the Graphics page when it suits the show.',
      );
    }
  }
}
