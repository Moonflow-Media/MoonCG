import { randomBytes } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BUNDLE_NAME_PATTERN,
  type BundleOperation,
  isJobFinished,
  type JobEvent,
  type JobState,
  type Json,
  type Manifest,
  MODULES_MANAGE,
  MoonCGError,
  nextJobState,
  type OperationStep,
  type Replicant,
  type ReplicantRegistry,
  SYSTEM_BUNDLE,
} from '@mooncg/core';
import { engineProblem } from '../bundles/dependencies.js';
import { privateRoots, publicError } from '../bundles/errors.js';
import { errorMessage, type Logger } from '../kernel/logger.js';
import { type ModuleManager, readModuleManifest } from '../modules/manager.js';
import { fetchSource, receiveUpload, type StageSource, sourceProblem } from './fetch.js';
import {
  DEFAULT_INSTALL_LIMITS,
  type InstallLimits,
  measureTree,
  moveDir,
  refuse,
  removeDir,
  storageError,
  storageProblem,
} from './files.js';
import { type GitOptions, withoutCredentials } from './git.js';
import { createNpmInstall, type NpmInstall, type NpmNeed, npmNeed } from './npm.js';
import {
  type BundleSource,
  BundleSources,
  type PublicSource,
  publicSource,
  refetchable,
  type SourceRecord,
} from './sources.js';

/** The read-only replicant `{ jobs, staged }` of module installations, for module managers. */
export const MODULE_INSTALLS_REPLICANT = 'module-installs';
/** How long a fetched module waits for a decision before it is deleted again. */
export const MODULE_STAGING_TTL_MS = 30 * 60_000;
const JOBS_KEPT = 20;
const MAX_STAGE_JOBS = 2;
const MAX_STAGED = 5;
const UPLOAD_IDLE_MS = 30_000;
const STAGING_ID = /^[0-9a-f]{24}$/;
const DEFAULT_MAIN = 'index.js';

/**
 * What every summary of a module says, whatever the module declares: a module is no
 * sandboxed bundle extension.
 */
export const MODULE_ACCESS =
  'Its code runs inside the MoonCG server process with full access to the server, its data and secrets, and this machine. Install only a module you trust as much as MoonCG itself.';

/** A module that was fetched and checked, and what it declares, before it is installed. */
export interface StagedModule {
  readonly id: string;
  readonly kind: 'module';
  readonly name: string;
  readonly version: string;
  readonly title?: string | undefined;
  /** For an update: the installed module it is to replace, and the version there now. */
  readonly target?: string | undefined;
  readonly replaces?: string | undefined;
  /** For an update: whether the installed module is enabled, so that the update restarts it. */
  readonly enabled?: boolean | undefined;
  readonly source: PublicSource;
  readonly engine?: string | undefined;
  /** The file the server loads. */
  readonly main: string;
  /** Whether it has a configuration. */
  readonly config: boolean;
  readonly access: string;
  readonly npm: NpmNeed;
  readonly installCode: 'none' | 'on-request' | 'allowed';
  readonly files: number;
  readonly bytes: number;
  readonly by: string;
  readonly stagedAt: string;
  readonly expiresAt: string;
}

/** A long operation on a module and where it stands. */
export interface ModuleJob {
  readonly id: string;
  readonly operation: Exclude<BundleOperation, 'restore'>;
  readonly state: JobState;
  readonly step?: string | undefined;
  readonly module?: string | undefined;
  readonly staged?: StagedModule | undefined;
  readonly error?: string | undefined;
  readonly rollbackError?: string | undefined;
  readonly by: string;
  readonly startedAt: string;
  readonly finishedAt?: string | undefined;
}

export interface ModuleInstallerOptions {
  readonly dataDir: string;
  readonly modulesDir: string;
  /** Kept out of reach of a `path` or `zip` source, like the data folder. */
  readonly bundlesDir: string;
  readonly modules: Pick<ModuleManager, 'get' | 'add' | 'replace' | 'forget'>;
  readonly registry: ReplicantRegistry;
  readonly logger: Logger;
  readonly mooncgVersion: string;
  /** Whether the installation is on air: an enabled module is then not updated or removed. */
  readonly onAir?: (() => boolean) | undefined;
  readonly limits?: InstallLimits | undefined;
  readonly timeoutMs?: number | undefined;
  readonly stagingTtlMs?: number | undefined;
  readonly uploadIdleMs?: number | undefined;
  readonly npmInstall?: NpmInstall | undefined;
  readonly npmRegistry?: string | undefined;
  readonly git?: Pick<GitOptions, 'allowFileUrls' | 'command' | 'env'> | undefined;
  /** Deletes what a module stored: its configuration. */
  readonly purge?: ((module: string) => Promise<void>) | undefined;
  readonly now?: (() => number) | undefined;
}

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

interface Outcome {
  readonly event: Exclude<JobEvent, 'start'>;
  readonly staged?: StagedModule;
  readonly error?: string;
  readonly rollbackError?: string;
}

interface Staged {
  readonly summary: StagedModule;
  readonly dir: string;
  readonly content: string;
  readonly source: BundleSource;
  readonly manifest: Manifest;
  readonly trusted: boolean;
  state: 'staged' | 'committing';
  timer?: ReturnType<typeof setTimeout>;
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/**
 * Installs, updates and removes the modules of the modules folder the way bundles are: a
 * module is fetched into `<data-dir>/module-staging/<id>/` and checked there with the same
 * bounds, Git hardening and npm rules as a bundle (`stage`); what it declares is shown, with
 * the plain statement that it runs inside the server with full access; and only then is it
 * put in place (`commit`) or deleted (`discard`). A module that was installed is disabled
 * until an administrator enables it. An update keeps the replaced version until the new one
 * runs, and puts it back if it does not; modules keep no backups beyond that.
 */
export class ModuleInstaller {
  readonly #options: ModuleInstallerOptions;
  readonly #log: Logger;
  readonly #limits: InstallLimits;
  readonly #timeoutMs: number;
  readonly #ttlMs: number;
  readonly #npmInstall: NpmInstall;
  readonly #now: () => number;
  readonly #stagingRoot: string;
  readonly #roots: readonly string[];
  readonly #sources: BundleSources;
  readonly #published: Replicant;
  readonly #entries = new Map<string, Staged>();
  readonly #jobs: Mutable<ModuleJob>[] = [];
  readonly #running = new Map<string, Promise<ModuleJob>>();
  #receiving = 0;
  readonly #shutdown = new AbortController();

  constructor(options: ModuleInstallerOptions) {
    this.#options = options;
    this.#log = options.logger.child('modules');
    this.#limits = options.limits ?? DEFAULT_INSTALL_LIMITS;
    this.#timeoutMs = options.timeoutMs ?? 5 * 60_000;
    this.#ttlMs = options.stagingTtlMs ?? MODULE_STAGING_TTL_MS;
    this.#npmInstall =
      options.npmInstall ??
      createNpmInstall({ home: join(options.dataDir, 'npm'), registry: options.npmRegistry });
    this.#now = options.now ?? Date.now;
    this.#stagingRoot = join(options.dataDir, 'module-staging');
    this.#roots = [options.modulesDir, options.bundlesDir, options.dataDir, ...privateRoots()];
    this.#sources = new BundleSources({
      dataDir: options.dataDir,
      file: 'module-sources.json',
      warn: (message) => this.#log.warn(message),
    });
    this.#published = options.registry.declare(SYSTEM_BUNDLE, MODULE_INSTALLS_REPLICANT, {
      initial: { jobs: [], staged: [] },
      readPermission: MODULES_MANAGE,
      readOnly: true,
    }).replicant;
  }

  /** Deletes what earlier runs left in staging. Call it once, before anything is staged. */
  async start(): Promise<void> {
    await removeDir(this.#stagingRoot).catch((error) => {
      this.#log.warn(`The module staging folder could not be emptied: ${errorMessage(error)}`);
    });
  }

  /**
   * Fetches a module into staging and checks it. `target` makes it the update of an
   * installed module, which it must be named like. `scripts` trusts it to run code while it
   * is installed; without it a module that would steer npm is refused.
   */
  stage(request: {
    readonly source: StageSource;
    readonly target?: string | undefined;
    readonly scripts?: boolean | undefined;
    readonly by: string;
  }): Promise<ModuleJob> {
    return this.#guarded(async () => {
      const { source, target, by } = request;
      const trusted = request.scripts === true;
      if (target !== undefined) this.#replaceable(target);
      const problem = sourceProblem(source, 'module', this.#options.git?.allowFileUrls === true);
      if (problem !== undefined) throw refuse(problem);
      this.#assertRoom();

      const id = randomBytes(12).toString('hex');
      const dir = join(this.#stagingRoot, id);
      await mkdir(dir, { recursive: true });
      if (source.type === 'upload') {
        this.#receiving++;
        try {
          await receiveUpload(source.body, join(dir, 'upload.zip'), {
            maxBytes: this.#limits.maxArchiveBytes,
            idleMs: this.#options.uploadIdleMs ?? UPLOAD_IDLE_MS,
            ...(source.length === undefined ? {} : { declared: source.length }),
          });
        } catch (error) {
          await removeDir(dir).catch(() => {});
          throw error;
        } finally {
          this.#receiving--;
        }
      }

      return this.#begin('stage', by, target, async ({ step, job }) => {
        try {
          step('fetch');
          const content = join(dir, 'module');
          const stored = await fetchSource(source, dir, content, {
            limits: this.#limits,
            timeoutMs: this.#timeoutMs,
            signal: this.#shutdown.signal,
            git: this.#options.git,
            forbidden: [this.#options.modulesDir, this.#options.bundlesDir, this.#options.dataDir],
            noun: 'module',
          });
          step('validate');
          // A bundle is refused here: it says `"kind": "bundle"`.
          const { manifest, errors } = await readModuleManifest(content);
          if (!manifest) throw refuse(errors.join('; '));
          job.module = manifest.name;
          const problems = await this.#problems(manifest, content, target);
          if (problems.length > 0) throw refuse(problems.join('; '));
          const npm = await npmNeed(content, this.#options.npmRegistry);
          const steering = [...npm.config.map((file) => `it brings ${file}`), ...npm.unusual];
          if (npm.needed && !trusted && steering.length > 0) {
            throw refuse(
              `Installing this module would make npm do more than fetch packages from the registry: ${steering.join('; ')}. ` +
                'That can run programs on the server before the module is installed. ' +
                'Fetch it again with install scripts allowed if you trust it, or bring node_modules in the module.',
            );
          }
          const size = await measureTree(content, this.#limits);
          const now = this.#now();
          const installed = target === undefined ? undefined : this.#options.modules.get(target);
          const summary: StagedModule = {
            id,
            kind: 'module',
            name: manifest.name,
            version: manifest.version,
            ...(manifest.title === undefined ? {} : { title: manifest.title }),
            ...(target === undefined
              ? {}
              : { target, replaces: installed?.version, enabled: installed?.enabled === true }),
            source: publicSource(stored),
            ...(manifest.engine === undefined ? {} : { engine: manifest.engine.mooncg }),
            main: manifest.main ?? DEFAULT_MAIN,
            config: manifest.config !== undefined,
            access: MODULE_ACCESS,
            npm,
            installCode: !npm.needed ? 'none' : trusted ? 'allowed' : 'on-request',
            ...size,
            by,
            stagedAt: new Date(now).toISOString(),
            expiresAt: new Date(now + this.#ttlMs).toISOString(),
          };
          const entry: Staged = {
            summary,
            dir,
            content,
            source: stored,
            manifest,
            trusted,
            state: 'staged',
          };
          this.#entries.set(id, entry);
          this.#arm(entry);
          this.#log.info(
            `${by} staged module ${manifest.name} ${manifest.version} from ${describe(stored)} (staging ${id})`,
          );
          return { event: 'succeed', staged: summary };
        } catch (error) {
          await removeDir(dir).catch(() => {});
          throw error;
        }
      });
    });
  }

  /** The modules that were fetched and wait for a decision, oldest first. */
  staged(): StagedModule[] {
    return [...this.#entries.values()]
      .filter((entry) => entry.state === 'staged')
      .map((entry) => entry.summary);
  }

  /** The update of an enabled module and what is blocked of it while on air, if anything. */
  lockedBy(id: string): string | undefined {
    const target = this.#entries.get(id)?.summary.target;
    return target !== undefined && this.#options.modules.get(target)?.enabled ? target : undefined;
  }

  /**
   * Installs a staged module, disabled, or puts it in the place of the module it updates.
   * `forceOnAir` updates an enabled module although the installation is on air.
   */
  commit(
    id: string,
    options: {
      readonly scripts?: boolean | undefined;
      readonly forceOnAir?: boolean | undefined;
      readonly by: string;
    },
  ): ModuleJob {
    const entry = STAGING_ID.test(id) ? this.#entries.get(id) : undefined;
    if (!entry) throw new MoonCGError('not_found', 'There is no staged module with this id');
    if (entry.state !== 'staged') {
      throw new MoonCGError('conflict', 'This staged module is being installed already');
    }
    const { name, version, target } = entry.summary;
    if (target !== undefined) this.#assertNotOnAir(target, 'updating', options.forceOnAir);
    entry.state = 'committing';
    clearTimeout(entry.timer);
    const { by } = options;
    return this.#begin(target === undefined ? 'install' : 'update', by, name, async ({ step }) => {
      const used = { up: false };
      try {
        step('dependencies');
        const problems = await this.#problems(entry.manifest, entry.content, target);
        if (problems.length > 0) throw refuse(problems.join('; '));
        await this.#installDependencies(entry, options.scripts === true, by, used);
        const record: SourceRecord = {
          source: entry.source,
          version,
          installedAt: new Date(this.#now()).toISOString(),
          by,
        };
        const live = join(this.#options.modulesDir, name);
        if (target === undefined) {
          step('place');
          if (await exists(live)) throw refuse(`There is a folder "${name}" in the modules folder`);
          await mkdir(this.#options.modulesDir, { recursive: true });
          try {
            await moveDir(entry.content, live);
          } catch (error) {
            await removeDir(live).catch(() => {});
            throw error;
          }
          let added = false;
          try {
            await this.#options.modules.add(name);
            added = true;
            await this.#sources.set(name, record);
          } catch (error) {
            // The modules folder and the manager must agree: the module is not installed.
            used.up = !(await this.#takeBack(entry, name, live, added));
            throw error;
          }
          used.up = true;
          this.#log.info(
            `${by} installed module ${name} ${version} from ${describe(entry.source)}; it is disabled until it is enabled`,
          );
          return { event: 'succeed' };
        }
        const before = this.#options.modules.get(name)?.version ?? 'unknown';
        const aside = join(entry.dir, 'previous');
        let moved = false;
        step('disable');
        const result = await this.#options.modules.replace(name, {
          apply: async () => {
            step('backup');
            await moveDir(live, aside);
            step('place');
            await moveDir(entry.content, live);
            moved = true;
            used.up = true;
            step('enable');
          },
          revert: async () => {
            step('rollback');
            if (!(await exists(aside))) return;
            if (moved && (await exists(live))) await moveDir(live, join(entry.dir, 'rejected'));
            await moveDir(aside, live);
          },
        });
        if (result.outcome === 'replaced') {
          used.up = true;
          // The new version runs and its folder is in place: the manager and the modules
          // folder agree. Only where it came from may be out of date.
          await this.#sources.set(name, record).catch((error) => {
            this.#log.warn(
              `Where module ${name} ${version} came from could not be written, so an update without a source may fetch the earlier one: ${errorMessage(error)}`,
            );
          });
          this.#log.info(`${by} updated module ${name} from ${before} to ${version}`);
          return { event: 'succeed' };
        }
        const error = result.error ?? 'The new version could not be put in place';
        if (result.outcome === 'rolled-back') {
          this.#log.warn(`${by}: updating module ${name} to ${version} was rolled back: ${error}`);
          return { event: 'roll-back', error };
        }
        return {
          event: 'fail',
          error,
          rollbackError: result.rollbackError ?? 'The earlier version could not be put back',
        };
      } finally {
        if (used.up) await this.#drop(entry);
        else {
          entry.state = 'staged';
          this.#arm(entry);
        }
      }
    });
  }

  /** Deletes a staged module. `false` if there is none with this id that waits. */
  async discard(id: string, by: string): Promise<boolean> {
    const entry = STAGING_ID.test(id) ? this.#entries.get(id) : undefined;
    if (entry?.state !== 'staged') return false;
    await this.#drop(entry);
    this.#log.info(`${by} discarded the staged module ${entry.summary.name}`);
    return true;
  }

  /** Stages a new version of an installed module: from `source`, or from where it came from. */
  async update(
    name: string,
    options: {
      readonly source?: StageSource | undefined;
      readonly scripts?: boolean | undefined;
      readonly by: string;
    },
  ): Promise<ModuleJob> {
    this.#replaceable(name);
    let { source } = options;
    if (source === undefined) {
      const known = (await this.#sources.get(name))?.source;
      source = refetchable(known);
      if (source === undefined) {
        throw new MoonCGError(
          'conflict',
          `It is not known where module "${name}" came from, or it cannot be fetched again; give the new version as a source`,
        );
      }
    }
    return this.stage({ source, target: name, scripts: options.scripts, by: options.by });
  }

  /**
   * Removes a module of the modules folder: stops it and deletes its files. Its
   * configuration stays unless `purgeData` is given. `forceOnAir` removes an enabled module
   * although the installation is on air.
   */
  remove(
    name: string,
    options: {
      readonly forceOnAir?: boolean | undefined;
      readonly purgeData?: boolean | undefined;
      readonly by: string;
    },
  ): ModuleJob {
    const record = this.#replaceable(name);
    if (record.enabled) this.#assertNotOnAir(name, 'removing', options.forceOnAir);
    const { by, purgeData = false } = options;
    return this.#begin('remove', by, name, async ({ step }) => {
      const version = record.version ?? 'unknown';
      step('disable');
      await this.#options.modules.forget(name, async () => {
        step('erase');
        const trash = join(this.#stagingRoot, `trash-${randomBytes(6).toString('hex')}`);
        await mkdir(this.#stagingRoot, { recursive: true });
        await moveDir(join(this.#options.modulesDir, name), trash);
        await removeDir(trash).catch((error) => {
          this.#log.warn(
            `What is left of module ${name} could not be deleted: ${errorMessage(error)}`,
          );
        });
      });
      step('purge');
      let purgeError: string | undefined;
      try {
        if (purgeData) await this.#options.purge?.(name);
      } catch (error) {
        purgeError = errorMessage(error);
      }
      await this.#sources.delete(name).catch(() => {});
      this.#log.info(
        `${by} removed module ${name} ${version} (configuration ${purgeData ? (purgeError === undefined ? 'deleted' : 'NOT deleted') : 'kept'})`,
      );
      return purgeError === undefined
        ? { event: 'succeed' }
        : {
            event: 'fail',
            error: `Module "${name}" was removed, but its configuration could not be deleted: ${purgeError}`,
          };
    });
  }

  jobs(): ModuleJob[] {
    return this.#jobs.map((job) => ({ ...job }));
  }

  job(id: string): ModuleJob | undefined {
    const found = this.#jobs.find((job) => job.id === id);
    return found && { ...found };
  }

  /** Where each installed module came from, as far as that is known, without credentials. */
  async sources(): Promise<Record<string, PublicSource>> {
    return Object.fromEntries(
      Object.entries(await this.#sources.all()).map(([name, record]) => [
        name,
        publicSource(record.source),
      ]),
    );
  }

  /** Resolves with a job once it is over. */
  async settled(id: string): Promise<ModuleJob> {
    const job = (await this.#running.get(id)) ?? this.job(id);
    if (!job) throw new MoonCGError('not_found', 'There is no such job');
    return job;
  }

  async idle(): Promise<void> {
    while (this.#running.size > 0) await Promise.all(this.#running.values());
  }

  async close(): Promise<void> {
    for (const entry of this.#entries.values()) clearTimeout(entry.timer);
    this.#shutdown.abort();
    await this.idle();
  }

  async #guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof MoonCGError) || error.code === 'disconnected') throw error;
      throw new MoonCGError(error.code, this.#public(error.message));
    }
  }

  /** A module of the modules folder that is installed; never one shipped with MoonCG. */
  #replaceable(name: string) {
    const record = BUNDLE_NAME_PATTERN.test(name) ? this.#options.modules.get(name) : undefined;
    if (!record) throw new MoonCGError('not_found', `There is no module "${name}"`);
    if (record.builtin) {
      throw new MoonCGError(
        'conflict',
        `The module "${name}" is shipped with MoonCG and is updated with it`,
      );
    }
    return record;
  }

  #assertNotOnAir(name: string, doing: string, force: boolean | undefined): void {
    if (force === true || this.#options.onAir?.() !== true) return;
    throw new MoonCGError(
      'conflict',
      `MoonCG is on air: ${doing} the enabled module "${name}" is blocked. ` +
        'Switch On Air off first, or override the lock for this one change ' +
        '("forceOnAir": true in the request, --on-air on the command line).',
    );
  }

  #assertRoom(): void {
    const fetching =
      this.#receiving +
      this.#jobs.filter((job) => job.operation === 'stage' && !isJobFinished(job.state)).length;
    if (fetching >= MAX_STAGE_JOBS) {
      throw new MoonCGError(
        'conflict',
        `${fetching} modules are being fetched already; wait until one of them is done`,
      );
    }
    if (fetching + this.#entries.size >= MAX_STAGED) {
      throw new MoonCGError(
        'conflict',
        `${this.#entries.size} fetched modules wait for a decision; install or discard one first`,
      );
    }
  }

  /** What speaks against installing a module with this manifest and these files. */
  async #problems(manifest: Manifest, content: string, target: string | undefined) {
    const problems: string[] = [];
    if (target !== undefined && manifest.name !== target) {
      problems.push(`The module is called "${manifest.name}", not "${target}"`);
    }
    if (target === undefined && this.#options.modules.get(manifest.name) !== undefined) {
      problems.push(
        `There is a module "${manifest.name}" already; update it instead of installing it again`,
      );
    }
    const engine = engineProblem(manifest.engine?.mooncg, this.#options.mooncgVersion);
    if (engine !== undefined) problems.push(engine);
    const main = manifest.main ?? DEFAULT_MAIN;
    const isFile = await stat(join(content, main)).then(
      (stats) => stats.isFile(),
      () => false,
    );
    if (!isFile) problems.push(`The main file "${main}" is missing`);
    return problems;
  }

  async #installDependencies(
    entry: Staged,
    asked: boolean,
    by: string,
    used: { up: boolean },
  ): Promise<void> {
    const { npm, name, version } = entry.summary;
    if (!npm.needed) return;
    const scripts = asked || entry.trusted;
    if (asked && !entry.trusted) {
      this.#log.warn(
        `${by} allowed the install scripts of the npm packages of module ${name} ${version} to run`,
      );
    }
    const log = this.#options.logger.child(`npm:${name}`);
    try {
      await this.#npmInstall({
        dir: entry.content,
        lockfile: npm.lockfile,
        scripts,
        timeoutMs: this.#timeoutMs,
        signal: this.#shutdown.signal,
        log: (line) => log.info(withoutCredentials(line)),
      });
    } catch (error) {
      const message = withoutCredentials(errorMessage(error));
      throw error instanceof MoonCGError
        ? new MoonCGError(error.code, message)
        : new Error(message);
    }
    try {
      await measureTree(entry.content, this.#limits);
      const { manifest } = await readModuleManifest(entry.content);
      if (JSON.stringify(manifest) !== JSON.stringify(entry.manifest)) {
        throw refuse(
          'The module changed while its npm packages were installed: its manifest is not the one that was shown. Nothing was installed',
        );
      }
    } catch (error) {
      used.up = true;
      throw error;
    }
  }

  #arm(entry: Staged): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (entry.state !== 'staged') return;
      this.#log.info(`The staged module ${entry.summary.name} expired and was deleted`);
      void this.#drop(entry);
    }, this.#ttlMs);
    entry.timer.unref();
    this.#publish();
  }

  /**
   * Undoes putting a new module in place when the manager or the sources file did not take
   * it: forgets it again if it was added, and moves its folder back to where it was staged,
   * so that it can be installed once more. Returns whether it is staged again; a folder that
   * cannot be moved back is deleted.
   */
  async #takeBack(entry: Staged, name: string, live: string, added: boolean): Promise<boolean> {
    let back = false;
    const moveBack = async () => {
      await moveDir(live, entry.content);
      back = true;
    };
    try {
      if (added) await this.#options.modules.forget(name, moveBack);
      else await moveBack();
    } catch (error) {
      this.#log.warn(
        `Module ${name} could not be put back where it was staged, so it is deleted: ${errorMessage(error)}`,
      );
    }
    if (!back) await removeDir(live).catch(() => {});
    return back;
  }

  async #drop(entry: Staged): Promise<void> {
    clearTimeout(entry.timer);
    this.#entries.delete(entry.summary.id);
    this.#publish();
    await removeDir(entry.dir).catch((error) => {
      this.#log.warn(`A module staging folder could not be deleted: ${errorMessage(error)}`);
    });
  }

  #begin(
    operation: ModuleJob['operation'],
    by: string,
    module: string | undefined,
    work: (progress: {
      step(name: OperationStep | 'rollback'): void;
      job: Mutable<ModuleJob>;
    }) => Promise<Outcome>,
  ): ModuleJob {
    const job: Mutable<ModuleJob> = {
      id: randomBytes(8).toString('hex'),
      operation,
      state: 'queued',
      ...(module === undefined ? {} : { module }),
      by,
      startedAt: new Date(this.#now()).toISOString(),
    };
    this.#jobs.unshift(job);
    this.#trim();
    const move = (event: JobEvent) => {
      job.state = nextJobState(job.state, event) ?? job.state;
    };
    const snapshot = { ...job };
    const run = async (): Promise<ModuleJob> => {
      await Promise.resolve();
      move('start');
      this.#publish();
      let outcome: Outcome;
      try {
        outcome = await work({
          job,
          step: (name) => {
            job.step = name;
            this.#publish();
          },
        });
      } catch (error) {
        const storage = storageProblem(error);
        outcome = {
          event: 'fail',
          error: storage === undefined ? errorMessage(error) : storageError(storage).message,
        };
        this.#log.error(
          `${by}: ${operation}${job.module === undefined ? '' : ` of module ${job.module}`} failed: ${errorMessage(error)}`,
        );
      }
      if (outcome.staged) job.staged = outcome.staged;
      if (outcome.error !== undefined) job.error = this.#public(outcome.error);
      if (outcome.rollbackError !== undefined) {
        job.rollbackError = this.#public(outcome.rollbackError);
      }
      move(outcome.event);
      job.finishedAt = new Date(this.#now()).toISOString();
      this.#running.delete(job.id);
      this.#trim();
      this.#publish();
      return { ...job };
    };
    this.#running.set(job.id, run());
    this.#publish();
    return snapshot;
  }

  #trim(): void {
    for (let index = this.#jobs.length - 1; index >= 0 && this.#jobs.length > JOBS_KEPT; index--) {
      const job = this.#jobs[index];
      if (job && isJobFinished(job.state)) this.#jobs.splice(index, 1);
    }
  }

  #public(message: string): string {
    return publicError(withoutCredentials(message), this.#options.modulesDir, this.#roots);
  }

  #publish(): void {
    const value = { jobs: this.jobs(), staged: this.staged() } as unknown as Json;
    if (JSON.stringify(value) === JSON.stringify(this.#published.value)) return;
    this.#published.applyOp({ patches: [{ op: 'replace', path: '', value }] });
  }
}

/** How the log names a source. */
function describe(source: BundleSource): string {
  const { type, location, ref } = publicSource(source);
  if (type === 'git') return `Git repository ${location}${ref === undefined ? '' : ` at ${ref}`}`;
  if (type === 'path') return `folder ${location}`;
  return type === 'zip' ? `archive ${location}` : `uploaded archive ${location}`;
}
