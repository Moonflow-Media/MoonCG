import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BUNDLE_NAME_PATTERN,
  BUNDLES_MANAGE,
  type BundleOperation,
  backupId,
  backupsToPrune,
  DEFAULT_BACKUPS_KEPT,
  isJobFinished,
  type JobEvent,
  type JobState,
  type Json,
  type Manifest,
  MoonCGError,
  nextJobState,
  type OperationStep,
  parseBackupId,
  type Replicant,
  type ReplicantRegistry,
  removalBlockers,
  SYSTEM_BUNDLE,
} from '@mooncg/core';
import { readManifest } from '../bundles/bundles.js';
import { installProblems } from '../bundles/dependencies.js';
import { privateRoots, publicError } from '../bundles/errors.js';
import type { BundleManager } from '../bundles/manager.js';
import { errorMessage, type Logger } from '../kernel/logger.js';
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
  type CatalogOrigin,
  type PublicSource,
  publicSource,
  refetchable,
  type SourceRecord,
} from './sources.js';

/**
 * The name of the read-only replicant `{ jobs, staged }`: the latest installations, updates
 * and removals with where each stands, and the bundles that were fetched and wait for a
 * decision. For those who may manage bundles.
 */
export const INSTALLS_REPLICANT = 'installs';
/** How long a fetched bundle waits for a decision before it is deleted again. */
export const STAGING_TTL_MS = 30 * 60_000;
/** How long fetching with Git, and installing with npm, may each take. */
export const INSTALL_TIMEOUT_MS = 5 * 60_000;
/** How many finished jobs are remembered. */
export const JOBS_KEPT = 20;
/** How long an uploaded archive may send nothing before it is given up. */
export const UPLOAD_IDLE_MS = 30_000;
/** How many bundles are fetched at the same time. */
export const MAX_STAGE_JOBS = 2;
/** How many bundles may be fetched, or wait fetched for a decision, in all. */
export const MAX_STAGED = 5;

export type { StageSource } from './fetch.js';

/** The role grants a bundle proposes, and whether installing it makes them. */
export interface ProposedRoles {
  /** Role to the bundle's permissions it would be granted. */
  readonly grants: Readonly<Record<string, readonly string[]>>;
  /**
   * Whether they are granted when the bundle is installed. They are only the first time a
   * bundle of this name is seen; after that the roles are an administrator's to change.
   */
  readonly applies: boolean;
}

/** A bundle that was fetched and checked, and what it declares, before it is installed. */
export interface StagedBundle {
  /** Names the staged bundle when it is committed or discarded. */
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly title?: string | undefined;
  /** For an update: the installed bundle this one is to replace. */
  readonly target?: string | undefined;
  /** For an update: the version that is installed now. */
  readonly replaces?: string | undefined;
  readonly source: PublicSource;
  /** The range of MoonCG versions the bundle asks for. */
  readonly engine?: string | undefined;
  readonly permissions: readonly { readonly name: string; readonly description: string }[];
  /** What the extension may reach beyond its own bundle. */
  readonly capabilities: readonly string[];
  readonly dependencies: Readonly<Record<string, string>>;
  /** Whether the bundle brings code that runs on the server. */
  readonly extension: boolean;
  readonly panels: number;
  readonly dialogs: number;
  readonly graphics: number;
  /** How many asset categories it declares. */
  readonly assets: number;
  /** Whether it has settings. */
  readonly config: boolean;
  readonly npm: NpmNeed;
  /**
   * Whether installing the bundle, before it is ever started, can run code on the server.
   * `none`: npm is not run. `on-request`: npm fetches packages from the registry and runs
   * nothing, unless install scripts are allowed at commit. `allowed`: whoever fetched the
   * bundle trusted it to run code while it is installed; its `.npmrc`, its dependencies from
   * elsewhere and the install scripts of its packages all apply.
   */
  readonly installCode: 'none' | 'on-request' | 'allowed';
  readonly roles: ProposedRoles;
  readonly files: number;
  readonly bytes: number;
  /** Who fetched it. */
  readonly by: string;
  readonly stagedAt: string;
  /** When it is deleted unless someone decides. */
  readonly expiresAt: string;
}

/** A long operation and where it stands. */
export interface InstallJob {
  readonly id: string;
  readonly operation: BundleOperation;
  readonly state: JobState;
  /** The step that runs, or the one the job ended in. `rollback` while a version is restored. */
  readonly step?: string | undefined;
  readonly bundle?: string | undefined;
  /** For a `stage` job that succeeded: what was fetched. */
  readonly staged?: StagedBundle | undefined;
  /** Why the job failed or was rolled back. */
  readonly error?: string | undefined;
  /** Why the earlier version is not back either. */
  readonly rollbackError?: string | undefined;
  /** Who asked for it. */
  readonly by: string;
  readonly startedAt: string;
  readonly finishedAt?: string | undefined;
}

/** An earlier version of a bundle that is kept in the backups. */
export interface BackupInfo {
  readonly id: string;
  readonly version: string;
  /** When it was moved aside, as an ISO 8601 time. */
  readonly time: string;
  /** What moved it aside. */
  readonly reason: 'update' | 'remove' | 'restore';
}

export interface InstallerOptions {
  readonly dataDir: string;
  readonly bundlesDir: string;
  readonly manager: BundleManager;
  readonly registry: ReplicantRegistry;
  readonly logger: Logger;
  /** The version of this MoonCG, which a bundle's `engine.mooncg` must allow. */
  readonly mooncgVersion: string;
  readonly limits?: InstallLimits | undefined;
  /** How long Git and npm may each take. Defaults to `INSTALL_TIMEOUT_MS`. */
  readonly timeoutMs?: number | undefined;
  /** How many earlier versions of each bundle are kept. With 0, none is. */
  readonly backupsKept?: number | undefined;
  readonly stagingTtlMs?: number | undefined;
  /** How long an upload may send nothing before it is given up. Defaults to `UPLOAD_IDLE_MS`. */
  readonly uploadIdleMs?: number | undefined;
  /** How many bundles are fetched at the same time. Defaults to `MAX_STAGE_JOBS`. */
  readonly maxStageJobs?: number | undefined;
  /** How many bundles may be fetched or wait fetched in all. Defaults to `MAX_STAGED`. */
  readonly maxStaged?: number | undefined;
  /** Installs npm dependencies. Defaults to running npm; tests put their own in its place. */
  readonly npmInstall?: NpmInstall | undefined;
  /** The registry npm packages are fetched from. Without it, npm's own. */
  readonly npmRegistry?: string | undefined;
  /**
   * The address of a registry index by its id, credentials included, for fetching again what
   * was installed from it. Without it, that is fetched as an address of its own.
   */
  readonly indexAddress?: ((id: string) => string | undefined) | undefined;
  /** For tests: how Git is run, and whether `file://` addresses are taken. */
  readonly git?: Pick<GitOptions, 'allowFileUrls' | 'command' | 'env'> | undefined;
  /** Deletes what a bundle stored: configuration, assets, replicants and role grants. */
  readonly purge?: ((bundle: string) => Promise<void>) | undefined;
  /** Says which role grants a bundle would bring. Without it, none are said to be made. */
  readonly roles?:
    | {
        proposed(
          bundle: string,
          defaultRoles: Readonly<Record<string, readonly string[]>>,
        ): ProposedRoles;
      }
    | undefined;
  /** Called after a bundle was installed, updated or removed. */
  readonly afterChange?: (() => void) | undefined;
  /** For tests: stands in for moving a folder. */
  readonly move?: ((from: string, to: string) => Promise<void>) | undefined;
  readonly now?: (() => number) | undefined;
}

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

/** How a job ended, as its work reports it. */
interface Outcome {
  readonly event: Exclude<JobEvent, 'start'>;
  readonly staged?: StagedBundle;
  readonly error?: string;
  readonly rollbackError?: string;
}

/** A step of an operation, from the table in core, or the bringing back of a version. */
type Step = OperationStep | 'rollback';

interface Progress {
  step(name: Step): void;
  readonly job: Mutable<InstallJob>;
}

interface Staged {
  readonly summary: StagedBundle;
  /** Its folder in staging; the bundle's files are in `bundle` below it. */
  readonly dir: string;
  readonly content: string;
  /** The source as it is stored, credentials included. */
  readonly source: BundleSource;
  readonly manifest: Manifest;
  /** Whoever fetched it allowed it to run code while it is installed. */
  readonly trusted: boolean;
  state: 'staged' | 'committing';
  timer?: ReturnType<typeof setTimeout>;
}

interface BackupMeta {
  readonly name: string;
  readonly version: string;
  readonly time: string;
  readonly reason: BackupInfo['reason'];
  /** Where the version came from, so that a restore remembers it again. */
  readonly source?: SourceRecord | undefined;
}

const STAGING_ID = /^[0-9a-f]{24}$/;
/** The note in a staging folder that lets a restart take the bundle up again. */
const STAGED_NOTE = 'staged.json';
const SOURCE_TYPES = new Set(['git', 'path', 'zip', 'upload', 'url']);

/** How a bundle was fetched and decided about, as a restart needs it. */
interface StagedNote {
  readonly id: string;
  readonly source: BundleSource;
  readonly trusted: boolean;
  readonly by: string;
  readonly stagedAt: string;
  readonly expiresAt: string;
  readonly target?: string | undefined;
}

/** The longest each text of a note may be. A note longer than that was not written here. */
const NOTE_LIMITS = {
  url: 4096,
  ref: 256,
  commit: 64,
  path: 4096,
  filename: 255,
  sha256: 64,
  by: 200,
} as const;

/** A text field of a note: absent, or a string no longer than its limit. */
const noteText = (field: unknown, limit: number) =>
  field === undefined || (typeof field === 'string' && field.length <= limit);

/**
 * A note as it was read, or `undefined` for anything that is no note of this folder. The
 * source is built anew from the fields a source has, so nothing else in the note is kept.
 */
function parseNote(
  value: unknown,
  id: string,
):
  | (Omit<StagedNote, 'stagedAt' | 'expiresAt'> & { stagedAt: number; expiresAt: number })
  | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const note = value as Record<string, unknown>;
  const source = note.source as Record<string, unknown> | undefined;
  const stagedAt = typeof note.stagedAt === 'string' ? Date.parse(note.stagedAt) : Number.NaN;
  const expiresAt = typeof note.expiresAt === 'string' ? Date.parse(note.expiresAt) : Number.NaN;
  if (
    note.id !== id ||
    typeof note.trusted !== 'boolean' ||
    typeof note.by !== 'string' ||
    !noteText(note.by, NOTE_LIMITS.by) ||
    !Number.isFinite(stagedAt) ||
    !Number.isFinite(expiresAt) ||
    !(
      note.target === undefined ||
      (typeof note.target === 'string' && BUNDLE_NAME_PATTERN.test(note.target))
    ) ||
    typeof source !== 'object' ||
    source === null ||
    !SOURCE_TYPES.has(source.type as string) ||
    !noteText(source.url, NOTE_LIMITS.url) ||
    !noteText(source.ref, NOTE_LIMITS.ref) ||
    !noteText(source.commit, NOTE_LIMITS.commit) ||
    !noteText(source.path, NOTE_LIMITS.path) ||
    !noteText(source.filename, NOTE_LIMITS.filename) ||
    !noteText(source.sha256, NOTE_LIMITS.sha256) ||
    !(source.catalog === undefined || parseCatalogOrigin(source.catalog))
  ) {
    return undefined;
  }
  const field = (name: 'url' | 'ref' | 'commit' | 'path' | 'filename' | 'sha256') =>
    source[name] === undefined ? {} : { [name]: source[name] as string };
  const catalog = parseCatalogOrigin(source.catalog);
  return {
    id,
    source: {
      type: source.type as BundleSource['type'],
      ...field('url'),
      ...field('ref'),
      ...field('commit'),
      ...field('path'),
      ...field('filename'),
      ...field('sha256'),
      ...(catalog === undefined ? {} : { catalog }),
    },
    trusted: note.trusted,
    by: note.by,
    stagedAt,
    expiresAt,
    ...(note.target === undefined ? {} : { target: note.target as string }),
  };
}
/** The index entry a note says a staged bundle came from, built anew from its fields. */
export function parseCatalogOrigin(value: unknown): CatalogOrigin | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const given = value as Record<string, unknown>;
  const text = (field: unknown, limit: number) =>
    typeof field === 'string' && field.length > 0 && field.length <= limit;
  if (
    !text(given.index, 64) ||
    !text(given.indexUrl, 2048) ||
    (given.kind !== 'bundle' && given.kind !== 'module') ||
    !text(given.name, 214) ||
    !text(given.version, 64)
  ) {
    return undefined;
  }
  return {
    index: given.index as string,
    indexUrl: given.indexUrl as string,
    kind: given.kind,
    name: given.name as string,
    version: given.version as string,
  };
}
const BACKUP_META = 'backup.json';
const succeeded: Outcome = { event: 'succeed' };

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** How the log names a source. */
function describeSource(source: BundleSource): string {
  const { type, location, ref } = publicSource(source);
  if (type === 'git') return `Git repository ${location}${ref === undefined ? '' : ` at ${ref}`}`;
  if (type === 'path') return `folder ${location}`;
  return type === 'zip' || type === 'url' ? `archive ${location}` : `uploaded archive ${location}`;
}

/**
 * Installs, updates and removes bundles. A bundle is first fetched into
 * `<data-dir>/staging/<id>/` and checked there (`stage`); nothing of it runs, and nothing
 * that is installed changes. What it declares is shown, and then it is either put in place
 * (`commit`) or deleted (`discard`). An update keeps the version it replaces in
 * `<data-dir>/backups/<bundle>/` and brings it back if the new one does not start.
 *
 * Everything that takes time runs as a job, published in the replicant `system:installs`.
 * Whatever changes a bundle goes through the bundle manager, so that it cannot cross an
 * enable, disable or reload of the same bundle.
 */
export class BundleInstaller {
  readonly #options: InstallerOptions;
  readonly #log: Logger;
  readonly #limits: InstallLimits;
  readonly #timeoutMs: number;
  readonly #ttlMs: number;
  readonly #backupsKept: number;
  readonly #maxStageJobs: number;
  readonly #maxStaged: number;
  readonly #npmInstall: NpmInstall;
  readonly #move: (from: string, to: string) => Promise<void>;
  readonly #now: () => number;
  readonly #stagingRoot: string;
  readonly #backupsRoot: string;
  readonly #roots: readonly string[];
  readonly #sources: BundleSources;
  readonly #published: Replicant;
  readonly #entries = new Map<string, Staged>();
  readonly #jobs: Mutable<InstallJob>[] = [];
  readonly #running = new Map<string, Promise<InstallJob>>();
  /** Uploads that are still arriving: each will become a job. */
  #receiving = 0;
  /** The backup folders that are being filled right now, which a sweep must leave alone. */
  readonly #filling = new Set<string>();
  /** Fires when the server shuts down: Git and npm are ended rather than waited for. */
  readonly #shutdown = new AbortController();

  constructor(options: InstallerOptions) {
    this.#options = options;
    this.#log = options.logger.child('bundles');
    this.#limits = options.limits ?? DEFAULT_INSTALL_LIMITS;
    this.#timeoutMs = options.timeoutMs ?? INSTALL_TIMEOUT_MS;
    this.#ttlMs = options.stagingTtlMs ?? STAGING_TTL_MS;
    this.#backupsKept = options.backupsKept ?? DEFAULT_BACKUPS_KEPT;
    this.#maxStageJobs = options.maxStageJobs ?? MAX_STAGE_JOBS;
    this.#maxStaged = options.maxStaged ?? MAX_STAGED;
    this.#npmInstall =
      options.npmInstall ??
      createNpmInstall({ home: join(options.dataDir, 'npm'), registry: options.npmRegistry });
    this.#move = options.move ?? ((from, to) => moveDir(from, to));
    this.#now = options.now ?? Date.now;
    this.#stagingRoot = join(options.dataDir, 'staging');
    this.#backupsRoot = join(options.dataDir, 'backups');
    this.#roots = [options.bundlesDir, options.dataDir, ...privateRoots()];
    this.#sources = new BundleSources({
      dataDir: options.dataDir,
      warn: (message) => this.#log.warn(message),
    });
    this.#published = options.registry.declare(SYSTEM_BUNDLE, INSTALLS_REPLICANT, {
      initial: { jobs: [], staged: [] },
      readPermission: BUNDLES_MANAGE,
      readOnly: true,
    }).replicant;
  }

  /** The bounds this installer keeps to, for whoever tells people about them. */
  get limits(): InstallLimits & {
    readonly backupsKept: number;
    readonly maxStageJobs: number;
    readonly maxStaged: number;
  } {
    return {
      ...this.#limits,
      backupsKept: this.#backupsKept,
      maxStageJobs: this.#maxStageJobs,
      maxStaged: this.#maxStaged,
    };
  }

  /**
   * Takes up what earlier runs left in staging. A bundle that was fetched and is still
   * within its lifetime is kept, with the trust it was fetched with, after it was read and
   * checked again from its files as if it had just been fetched: nothing stored about what
   * the files hold is believed. Everything else there is deleted, and so is a backup folder
   * that was never filled. Call it once, before anything is staged.
   */
  async start(): Promise<void> {
    const now = this.#now();
    let kept = 0;
    for (const name of await readdir(this.#stagingRoot).catch(() => [] as string[])) {
      const dir = join(this.#stagingRoot, name);
      if (STAGING_ID.test(name)) {
        const notKept =
          kept >= this.#maxStaged
            ? 'as many staged bundles as may wait are kept already'
            : await this.#takeUp(name, dir, now).catch((error: unknown) => errorMessage(error));
        if (notKept === undefined) {
          kept++;
          continue;
        }
        this.#log.warn(`The staged bundle ${name} is not kept: ${notKept}`);
      }
      // Anything else there, such as what a removal left to be deleted, is no staged bundle.
      await removeDir(dir).catch((error) => {
        this.#log.warn(`A staging folder could not be deleted: ${errorMessage(error)}`);
      });
    }
    for (const name of await readdir(this.#backupsRoot).catch(() => [])) {
      if (BUNDLE_NAME_PATTERN.test(name)) await this.#prune(name);
    }
  }

  /**
   * Fetches a bundle into staging and checks it. Resolves with the job as soon as the
   * request is taken; an uploaded archive has been received by then. Rejects, without a
   * job, for a request that names no usable source, or while as much is being fetched or
   * waits fetched as may. `target` makes it the update of an installed bundle: the fetched
   * bundle must have that name. `scripts` says that the bundle is trusted to run code while
   * it is installed; without it a bundle that would steer npm is refused. `catalog` says which
   * registry index entry the source was taken from: it is remembered with the source.
   */
  stage(request: {
    readonly source: StageSource;
    readonly target?: string | undefined;
    readonly scripts?: boolean | undefined;
    readonly catalog?: CatalogOrigin | undefined;
    readonly by: string;
  }): Promise<InstallJob> {
    return this.#guarded(async () => {
      const { source, target, by, catalog } = request;
      const trusted = request.scripts === true;
      if (target !== undefined) this.#installed(target);
      const problem = this.#sourceProblem(source);
      if (problem !== undefined) throw refuse(problem);
      this.#assertRoom();

      const id = randomBytes(12).toString('hex');
      const dir = join(this.#stagingRoot, id);
      if (source.type === 'upload') {
        this.#receiving++;
        try {
          await mkdir(dir, { recursive: true });
          await this.#receive(source.body, join(dir, 'upload.zip'), source.length);
        } catch (error) {
          await removeDir(dir).catch(() => {});
          throw error;
        } finally {
          this.#receiving--;
        }
      } else await mkdir(dir, { recursive: true });

      return this.#begin('stage', by, target, async ({ step, job }) => {
        try {
          step('fetch');
          const content = join(dir, 'bundle');
          const fetched = await this.#fetch(source, dir, content);
          const stored: BundleSource = catalog === undefined ? fetched : { ...fetched, catalog };
          step('validate');
          const { manifest, errors } = await readManifest(content);
          if (!manifest) throw refuse(errors.join('; '));
          job.bundle = manifest.name;
          // An index entry names what it offers; an archive that is something else is not it.
          if (catalog !== undefined && manifest.name !== catalog.name) {
            throw refuse(
              `The index entry "${catalog.name}" brought bundle "${manifest.name}"; nothing was staged`,
            );
          }
          // Nor is a version that the index claims for an archive of another one.
          if (catalog !== undefined && manifest.version !== catalog.version) {
            throw refuse(
              `The index lists "${catalog.name}" ${catalog.version}, but the bundle it brought is version ${manifest.version}; nothing was staged`,
            );
          }
          const problems = this.#problems(manifest, target);
          if (problems.length > 0) throw refuse(problems.join('; '));
          const now = this.#now();
          const { summary } = await this.#check({
            id,
            manifest,
            content,
            stored,
            target,
            trusted,
            by,
            stagedAt: now,
            expiresAt: now + this.#ttlMs,
          });
          const entry: Staged = {
            summary,
            dir,
            content,
            source: stored,
            manifest,
            trusted,
            state: 'staged',
          };
          // What a restart needs to take it up again: how it was fetched and decided about,
          // never what its files hold, which is read from them again.
          const note: StagedNote = {
            id,
            source: stored,
            trusted,
            by,
            stagedAt: summary.stagedAt,
            expiresAt: summary.expiresAt,
            ...(target === undefined ? {} : { target }),
          };
          await writeFile(join(dir, STAGED_NOTE), `${JSON.stringify(note, null, 2)}\n`);
          this.#entries.set(id, entry);
          this.#arm(entry);
          this.#log.info(
            `${by} staged ${manifest.name} ${manifest.version} from ${describeSource(stored)} (staging ${id})`,
          );
          if (trusted && summary.npm.needed) {
            this.#log.warn(
              `${by} allowed ${manifest.name} ${manifest.version} to run code while it is installed`,
            );
          }
          return { event: 'succeed', staged: summary };
        } catch (error) {
          await removeDir(dir).catch(() => {});
          throw error;
        }
      });
    });
  }

  /** The bundles that were fetched and wait for a decision, oldest first. */
  staged(): StagedBundle[] {
    return [...this.#entries.values()]
      .filter((entry) => entry.state === 'staged')
      .map((entry) => entry.summary);
  }

  /**
   * Installs a staged bundle, or puts it in the place of the bundle it updates. Throws for
   * an id that names nothing staged. `scripts` lets the install scripts of its npm
   * dependencies run; a bundle that was fetched as trusted has that already.
   */
  commit(
    id: string,
    options: {
      readonly scripts?: boolean | undefined;
      readonly by: string;
      /** Put an update in place although the installation is on air. */
      readonly forceOnAir?: boolean | undefined;
    },
  ): InstallJob {
    const entry = STAGING_ID.test(id) ? this.#entries.get(id) : undefined;
    if (!entry) throw new MoonCGError('not_found', 'There is no staged bundle with this id');
    if (entry.state !== 'staged') {
      throw new MoonCGError('conflict', 'This staged bundle is being installed already');
    }
    entry.state = 'committing';
    clearTimeout(entry.timer);
    const { by } = options;
    const { name, version, target } = entry.summary;
    return this.#begin(target === undefined ? 'install' : 'update', by, name, async (progress) => {
      const { step } = progress;
      /** Set once the bundle's files are no longer in staging as they were shown. */
      const used = { up: false };
      try {
        step('dependencies');
        const problems = this.#problems(entry.manifest, target);
        if (problems.length > 0) throw refuse(problems.join('; '));
        await this.#installDependencies(entry, options.scripts === true, by, used);
        const record: SourceRecord = {
          source: entry.source,
          version,
          installedAt: new Date(this.#now()).toISOString(),
          by,
        };
        return target === undefined
          ? await this.#install(entry, record, used, step)
          : await this.#update(entry, record, used, step, options.forceOnAir === true);
      } finally {
        if (used.up) await this.#drop(entry);
        else {
          entry.state = 'staged';
          this.#arm(entry, Math.max(0, Date.parse(entry.summary.expiresAt) - this.#now()));
        }
      }
    });
  }

  /** Deletes a staged bundle. `false` if there is none with this id that waits. */
  async discard(id: string, by: string): Promise<boolean> {
    const entry = STAGING_ID.test(id) ? this.#entries.get(id) : undefined;
    if (entry?.state !== 'staged') return false;
    await this.#drop(entry);
    this.#log.info(`${by} discarded the staged ${entry.summary.name} ${entry.summary.version}`);
    return true;
  }

  /**
   * Stages a new version of an installed bundle: from `source`, or without one from where
   * the bundle came from. The result is committed like any staged bundle.
   */
  async update(
    name: string,
    options: {
      readonly source?: StageSource | undefined;
      readonly scripts?: boolean | undefined;
      readonly by: string;
    },
  ): Promise<InstallJob> {
    this.#installed(name);
    let { source } = options;
    let catalog: CatalogOrigin | undefined;
    if (source === undefined) {
      const known = (await this.#sources.get(name))?.source;
      source = refetchable(known, this.#options.indexAddress);
      // Fetched again from an index entry, it stays tied to that entry.
      catalog = known?.catalog;
      if (source === undefined) {
        throw new MoonCGError(
          'conflict',
          known?.type === 'upload'
            ? `Bundle "${name}" was installed from an uploaded archive, which cannot be fetched again; give the new version as a source`
            : `It is not known where bundle "${name}" came from; give the new version as a source`,
        );
      }
    }
    return this.stage({
      source,
      target: name,
      scripts: options.scripts,
      by: options.by,
      ...(catalog === undefined ? {} : { catalog }),
    });
  }

  /**
   * Removes a bundle: stops it and moves its folder to the backups, or deletes it with
   * `deleteFiles` and where no backups are kept. What the bundle stored stays unless
   * `purgeData` is given. Throws at once for a bundle that is not there or that enabled
   * bundles need, unless `force` is given. `forceOnAir` is the other override, for a
   * removal while the installation is on air; neither stands in for the other.
   */
  remove(
    name: string,
    options: {
      readonly force?: boolean | undefined;
      /** Remove although the installation is on air. */
      readonly forceOnAir?: boolean | undefined;
      readonly deleteFiles?: boolean | undefined;
      readonly purgeData?: boolean | undefined;
      readonly by: string;
    },
  ): InstallJob {
    const { manager, bundlesDir } = this.#options;
    const { by, force = false, purgeData = false } = options;
    // Where nothing is kept, a backup would be made only to be deleted.
    const deleteFiles = options.deleteFiles === true || this.#backupsKept === 0;
    this.#installed(name);
    // Asked again under the lock; asked here so that the refusal is the answer.
    const blockers = removalBlockers(
      name,
      manager.list().map((other) => ({
        name: other.name,
        enabled: other.state !== 'disabled',
        dependencies: Object.keys(other.manifest?.dependencies ?? {}),
      })),
      force,
    );
    if (blockers.length > 0) {
      throw new MoonCGError(
        'conflict',
        `Bundle "${name}" is needed by ${blockers.join(', ')}; disable or remove those first, or force the removal`,
      );
    }
    return this.#begin('remove', by, name, async ({ step }) => {
      const version = manager.get(name)?.manifest?.version ?? 'unknown';
      const live = join(bundlesDir, name);
      step('disable');
      await manager.remove(name, { force, forceOnAir: options.forceOnAir }, async () => {
        step('erase');
        if (deleteFiles) {
          // Out of the bundles folder in one move, so that it is gone whole or not at all.
          const trash = join(this.#stagingRoot, `trash-${randomBytes(6).toString('hex')}`);
          await mkdir(this.#stagingRoot, { recursive: true });
          await this.#move(live, trash);
          await removeDir(trash).catch((error) => {
            this.#log.warn(`What is left of ${name} could not be deleted: ${errorMessage(error)}`);
          });
          return;
        }
        await this.#backup(name, version, 'remove', undefined, (backup) =>
          this.#move(live, join(backup, 'bundle')),
        );
      });
      // The bundle is gone from here on. Whatever else fails, the books are closed.
      step('purge');
      let purgeError: string | undefined;
      try {
        if (purgeData) await this.#options.purge?.(name);
      } catch (error) {
        purgeError = errorMessage(error);
      }
      await this.#sources.delete(name).catch((error) => {
        this.#log.warn(`The source of ${name} could not be forgotten: ${errorMessage(error)}`);
      });
      await this.#prune(name);
      this.#options.afterChange?.();
      this.#log.info(
        `${by} removed ${name} ${version} (files ${deleteFiles ? 'deleted' : 'moved to the backups'}, ` +
          `data ${purgeData ? (purgeError === undefined ? 'purged' : 'NOT purged') : 'kept'}${force ? ', forced' : ''})`,
      );
      if (purgeError === undefined) return succeeded;
      return {
        event: 'fail',
        error: `Bundle "${name}" was removed, but what it stored could not be deleted: ${purgeError}`,
      };
    });
  }

  /** The earlier versions of a bundle that are kept, newest first. */
  async backups(name: string): Promise<BackupInfo[]> {
    if (!BUNDLE_NAME_PATTERN.test(name)) return [];
    const dir = join(this.#backupsRoot, name);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const found = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) => parseBackupId(entry.name) ?? [])
        .map(async ({ id, version, time }): Promise<BackupInfo | undefined> => {
          if (!(await exists(join(dir, id, 'bundle')))) return undefined;
          const meta = await this.#backupMeta(join(dir, id));
          return {
            id,
            version,
            time: new Date(time).toISOString(),
            reason: meta?.reason ?? 'update',
          };
        }),
    );
    return found
      .filter((backup) => backup !== undefined)
      .sort((a, b) => b.time.localeCompare(a.time) || b.id.localeCompare(a.id));
  }

  /**
   * Every bundle that has a backup, by name, with its backups and whether a bundle of that
   * name is installed. One that is not was removed: its backup is how it comes back.
   */
  async allBackups(): Promise<
    { readonly name: string; readonly installed: boolean; readonly backups: BackupInfo[] }[]
  > {
    const names = (await readdir(this.#backupsRoot).catch(() => []))
      .filter((name) => BUNDLE_NAME_PATTERN.test(name))
      .sort();
    const found = await Promise.all(
      names.map(async (name) => ({
        name,
        installed: this.#options.manager.get(name) !== undefined,
        backups: await this.backups(name),
      })),
    );
    return found.filter(({ backups }) => backups.length > 0);
  }

  /**
   * Puts a backup back in place, after the same checks as an update: the MoonCG it asks
   * for, the bundles it needs and the bundles that need it. An installed version is moved to
   * the backups in turn, and comes back if the restored one does not start; a bundle that
   * was removed is installed again. Rejects for a backup that is not there.
   */
  async restore(
    name: string,
    backup: string,
    by: string,
    options: { readonly forceOnAir?: boolean | undefined } = {},
  ): Promise<InstallJob> {
    const { manager, bundlesDir } = this.#options;
    const missing = () => new MoonCGError('not_found', `Bundle "${name}" has no such backup`);
    if (!BUNDLE_NAME_PATTERN.test(name) || parseBackupId(backup) === undefined) throw missing();
    const dir = join(this.#backupsRoot, name, backup);
    const kept = join(dir, 'bundle');
    if (!(await exists(kept))) throw missing();

    return this.#begin('restore', by, name, async ({ step }) => {
      const live = join(bundlesDir, name);
      const meta = await this.#backupMeta(dir);
      const version = parseBackupId(backup)?.version ?? 'unknown';
      const { manifest, errors } = await readManifest(kept, name);
      if (!manifest) throw refuse(errors.join('; '));
      const current = manager.get(name);
      const problems = this.#problems(manifest, current ? name : undefined);
      if (problems.length > 0) throw refuse(problems.join('; '));
      const remember = async () => {
        if (meta?.source) await this.#sources.set(name, meta.source);
        else await this.#sources.delete(name);
        await removeDir(dir);
        this.#options.afterChange?.();
      };

      if (!current) {
        step('place');
        const record = await manager.install(name, Object.keys(manifest.dependencies), async () => {
          await mkdir(bundlesDir, { recursive: true });
          await this.#place(kept, live);
          step('enable');
        });
        await remember();
        this.#log.info(`${by} restored ${name} ${version} from its backup`);
        return record.state === 'running'
          ? succeeded
          : {
              event: 'fail',
              error: `Bundle "${name}" was restored but does not start: ${record.errors.join('; ')}`,
            };
      }

      const before = current.manifest?.version ?? 'unknown';
      const source = await this.#sources.get(name);
      let aside: string | undefined;
      let moved = false;
      step('disable');
      const result = await manager.replace(
        name,
        {
          apply: async () => {
            step('backup');
            await this.#backup(name, before, 'restore', source, async (folder) => {
              aside = folder;
              await this.#move(live, join(folder, 'bundle'));
            });
            step('place');
            await this.#move(kept, live);
            moved = true;
            step('enable');
          },
          revert: async () => {
            step('rollback');
            if (aside === undefined) return;
            if (await exists(join(aside, 'bundle'))) {
              // What was restored and does not run goes back to being a backup.
              if (moved && (await exists(live))) await this.#move(live, kept);
              await this.#move(join(aside, 'bundle'), live);
            }
            await removeDir(aside);
          },
        },
        options,
      );
      if (result.outcome === 'replaced') {
        await remember();
        await this.#prune(name);
        this.#log.info(`${by} restored ${name} ${version} from its backup, in place of ${before}`);
        return succeeded;
      }
      return this.#notReplaced(result, `${by}: restoring ${name} ${version}`);
    });
  }

  /** The latest jobs, newest first. */
  jobs(): InstallJob[] {
    return this.#jobs.map((job) => ({ ...job }));
  }

  job(id: string): InstallJob | undefined {
    const found = this.#jobs.find((job) => job.id === id);
    return found && { ...found };
  }

  /** Where each installed bundle came from, as far as that is known, without credentials. */
  async sources(): Promise<Record<string, PublicSource>> {
    return Object.fromEntries(
      Object.entries(await this.#sources.all()).map(([name, record]) => [
        name,
        publicSource(record.source),
      ]),
    );
  }

  /** Resolves with a job once it is over. Rejects for a job nobody knows. */
  async settled(id: string): Promise<InstallJob> {
    const job = (await this.#running.get(id)) ?? this.job(id);
    if (!job) throw new MoonCGError('not_found', 'There is no such job');
    return job;
  }

  /** Resolves once no job is running. */
  async idle(): Promise<void> {
    while (this.#running.size > 0) await Promise.all(this.#running.values());
  }

  /**
   * For shutdown: ends Git and npm where they run, and waits for the jobs to notice. A job
   * that was moving files finishes that, so that no bundle is left half in place.
   */
  async close(): Promise<void> {
    for (const entry of this.#entries.values()) clearTimeout(entry.timer);
    this.#shutdown.abort();
    await this.idle();
  }

  /**
   * Runs what a request asked for and makes sure that a refusal names no folder of the
   * server: what is thrown from here is answered to whoever asked.
   */
  async #guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof MoonCGError) || error.code === 'disconnected') throw error;
      throw new MoonCGError(error.code, this.#public(error.message));
    }
  }

  /** Throws unless `name` is a bundle that is installed. */
  #installed(name: string): void {
    if (!BUNDLE_NAME_PATTERN.test(name) || !this.#options.manager.get(name)) {
      throw new MoonCGError('not_found', `There is no bundle "${name}"`);
    }
  }

  /** Throws while as many bundles are being fetched, or wait fetched, as may. */
  #assertRoom(): void {
    const fetching =
      this.#receiving +
      this.#jobs.filter((job) => job.operation === 'stage' && !isJobFinished(job.state)).length;
    if (fetching >= this.#maxStageJobs) {
      throw new MoonCGError(
        'conflict',
        `${fetching} bundles are being fetched already; wait until one of them is done`,
      );
    }
    if (fetching + this.#entries.size >= this.#maxStaged) {
      throw new MoonCGError(
        'conflict',
        `${this.#entries.size} fetched bundles wait for a decision; install or discard one first`,
      );
    }
  }

  /** Why a request names no source to fetch from, checked before anything is created. */
  #sourceProblem(source: StageSource): string | undefined {
    return sourceProblem(source, 'bundle', this.#options.git?.allowFileUrls === true);
  }

  /** Writes an uploaded archive to `file`, counting what arrives against the limit. */
  #receive(body: NodeJS.ReadableStream, file: string, declared?: number): Promise<void> {
    return receiveUpload(body, file, {
      maxBytes: this.#limits.maxArchiveBytes,
      idleMs: this.#options.uploadIdleMs ?? UPLOAD_IDLE_MS,
      ...(declared === undefined ? {} : { declared }),
    });
  }

  /** Brings the files of the bundle into `content` and says where they came from. */
  #fetch(source: StageSource, dir: string, content: string): Promise<BundleSource> {
    return fetchSource(source, dir, content, {
      limits: this.#limits,
      timeoutMs: this.#timeoutMs,
      signal: this.#shutdown.signal,
      git: this.#options.git,
      forbidden: [this.#options.bundlesDir, this.#options.dataDir],
      noun: 'bundle',
    });
  }

  /** What speaks against installing a bundle with this manifest, as things are now. */
  #problems(manifest: Manifest, target: string | undefined): string[] {
    const records = this.#options.manager.list();
    return installProblems({
      candidate: {
        name: manifest.name,
        version: manifest.version,
        dependencies: manifest.dependencies,
        engine: manifest.engine?.mooncg,
      },
      installed: records.flatMap(({ name, manifest: other }) =>
        other ? [{ name, version: other.version, dependencies: other.dependencies }] : [],
      ),
      taken: records.map(({ name }) => name),
      mooncg: this.#options.mooncgVersion,
      target,
    });
  }

  /**
   * Installs the npm packages of a staged bundle, in staging, if it needs any, and then
   * looks at the bundle again: npm wrote into its folder, so it is measured once more, and
   * its manifest must still be the one that was shown.
   */
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
        `${by} allowed the install scripts of the npm packages of ${name} ${version} to run`,
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
      // What npm says may quote an address with a token in it.
      const message = withoutCredentials(errorMessage(error));
      throw error instanceof MoonCGError
        ? new MoonCGError(error.code, message)
        : new Error(message);
    }
    try {
      await measureTree(entry.content, this.#limits);
      const { manifest } = await readManifest(entry.content);
      if (JSON.stringify(manifest) !== JSON.stringify(entry.manifest)) {
        throw refuse(
          'The bundle changed while its npm packages were installed: its manifest is not the one that was shown. Nothing was installed',
        );
      }
    } catch (error) {
      // What is in staging now is not what was fetched; it is not kept for another try.
      used.up = true;
      throw error;
    }
  }

  /**
   * Moves a folder to a place in the bundles folder where nothing is, and leaves nothing
   * there if that fails: a half bundle would be taken for a bundle at the next start.
   */
  async #place(from: string, live: string): Promise<void> {
    if (await exists(live)) throw new Error(`Cannot move to "${live}": it already exists`);
    try {
      await this.#move(from, live);
    } catch (error) {
      await removeDir(live).catch(() => {});
      throw error;
    }
  }

  async #install(
    entry: Staged,
    record: SourceRecord,
    used: { up: boolean },
    step: Progress['step'],
  ): Promise<Outcome> {
    const { manager, bundlesDir } = this.#options;
    const { name, version } = entry.summary;
    const installed = await manager.install(
      name,
      Object.keys(entry.manifest.dependencies),
      async () => {
        step('place');
        await mkdir(bundlesDir, { recursive: true });
        await this.#place(entry.content, join(bundlesDir, name));
        // Only now: until the move succeeded the fetched bundle is still whole in staging.
        used.up = true;
        step('enable');
      },
    );
    await this.#sources.set(name, record);
    this.#options.afterChange?.();
    this.#log.info(
      `${record.by} installed ${name} ${version} from ${describeSource(entry.source)}`,
    );
    if (installed.state === 'running') return succeeded;
    return {
      event: 'fail',
      error: `Bundle "${name}" was installed but does not start: ${installed.errors.join('; ')}`,
    };
  }

  async #update(
    entry: Staged,
    record: SourceRecord,
    used: { up: boolean },
    step: Progress['step'],
    forceOnAir = false,
  ): Promise<Outcome> {
    const { manager, bundlesDir } = this.#options;
    const { name, version } = entry.summary;
    const live = join(bundlesDir, name);
    const before = manager.get(name)?.manifest?.version ?? 'unknown';
    const source = await this.#sources.get(name);
    let backup: string | undefined;
    step('disable');
    const result = await manager.replace(
      name,
      {
        apply: async () => {
          step('backup');
          // Also where no backups are kept: this one is what a rollback goes back to.
          await this.#backup(name, before, 'update', source, async (folder) => {
            backup = folder;
            await this.#move(live, join(folder, 'bundle'));
          });
          step('place');
          await this.#move(entry.content, live);
          used.up = true;
          step('enable');
        },
        revert: async () => {
          step('rollback');
          if (backup === undefined) return;
          if (await exists(join(backup, 'bundle'))) {
            // The version that did not make it leaves with the rest of its staging folder.
            if (used.up && (await exists(live)))
              await this.#move(live, join(entry.dir, 'rejected'));
            await this.#move(join(backup, 'bundle'), live);
          }
          await removeDir(backup);
        },
      },
      { forceOnAir },
    );
    if (result.outcome === 'replaced') {
      await this.#sources.set(name, record);
      await this.#prune(name);
      this.#options.afterChange?.();
      this.#log.info(`${record.by} updated ${name} from ${before} to ${version}`);
      return succeeded;
    }
    return this.#notReplaced(result, `${record.by}: updating ${name} from ${before} to ${version}`);
  }

  /** The outcome of a swap that did not stay, logged with both errors. */
  #notReplaced(
    result: { outcome: string; error?: string | undefined; rollbackError?: string | undefined },
    what: string,
  ): Outcome {
    const error = result.error ?? 'The new version could not be put in place';
    if (result.outcome === 'rolled-back') {
      this.#log.warn(`${what} failed and was rolled back: ${error}`);
      return { event: 'roll-back', error };
    }
    const rollbackError = result.rollbackError ?? 'The earlier version could not be restored';
    this.#log.error(`${what} failed (${error}) and the rollback failed too (${rollbackError})`);
    return { event: 'fail', error, rollbackError };
  }

  /**
   * Creates the folder of a new backup, notes what it is, and lets `fill` move the bundle
   * into it. While that runs the folder is not whole, and no sweep touches it.
   */
  async #backup(
    name: string,
    version: string,
    reason: BackupInfo['reason'],
    source: SourceRecord | undefined,
    fill: (folder: string) => Promise<void>,
  ): Promise<void> {
    // A version the manifest could not tell still needs a name a folder can have.
    const safe = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version) ? version : 'unknown';
    let time = this.#now();
    while (await exists(join(this.#backupsRoot, name, backupId(safe, time)))) time++;
    const dir = join(this.#backupsRoot, name, backupId(safe, time));
    this.#filling.add(dir);
    try {
      await mkdir(dir, { recursive: true });
      const meta: BackupMeta = {
        name,
        version,
        time: new Date(time).toISOString(),
        reason,
        ...(source === undefined ? {} : { source }),
      };
      await writeFile(join(dir, BACKUP_META), `${JSON.stringify(meta, null, 2)}\n`);
      await fill(dir);
    } finally {
      this.#filling.delete(dir);
    }
  }

  async #backupMeta(dir: string): Promise<BackupMeta | undefined> {
    try {
      return JSON.parse(await readFile(join(dir, BACKUP_META), 'utf8')) as BackupMeta;
    } catch {
      return undefined;
    }
  }

  /**
   * Deletes the oldest backups of a bundle beyond the number that is kept. A folder without
   * a bundle in it is what an interrupted update left: it is no backup, so it does not count
   * against that number, and it is deleted.
   */
  async #prune(name: string): Promise<void> {
    const dir = join(this.#backupsRoot, name);
    const whole = [];
    const doomed: string[] = [];
    for (const entry of await readdir(dir).catch(() => [])) {
      const backup = parseBackupId(entry);
      if (!backup || this.#filling.has(join(dir, entry))) continue;
      if (await exists(join(dir, entry, 'bundle'))) whole.push(backup);
      else doomed.push(entry);
    }
    doomed.push(...backupsToPrune(whole, this.#backupsKept));
    for (const id of doomed) {
      await removeDir(join(dir, id)).catch((error) => {
        this.#log.warn(`The backup ${id} of ${name} could not be deleted: ${errorMessage(error)}`);
      });
    }
  }

  /**
   * Checks a fetched bundle as staging does, from its files, and says what it declares.
   * Throws a refusal for one that must not be staged.
   */
  async #check(given: {
    readonly id: string;
    readonly manifest: Manifest;
    readonly content: string;
    readonly stored: BundleSource;
    readonly target: string | undefined;
    readonly trusted: boolean;
    readonly by: string;
    readonly stagedAt: number;
    readonly expiresAt: number;
  }): Promise<{ summary: StagedBundle }> {
    const { id, manifest, content, stored, target, trusted, by } = given;
    const npm = await npmNeed(content, this.#options.npmRegistry);
    const steering = [...npm.config.map((file) => `it brings ${file}`), ...npm.unusual];
    if (npm.needed && !trusted && steering.length > 0) {
      throw refuse(
        `Installing this bundle would make npm do more than fetch packages from the registry: ${steering.join('; ')}. ` +
          'That can run programs on the server before the bundle is installed. ' +
          'Fetch it again with install scripts allowed if you trust it, or bring node_modules in the bundle.',
      );
    }
    const size = await measureTree(content, this.#limits);
    const summary: StagedBundle = {
      id,
      name: manifest.name,
      version: manifest.version,
      ...(manifest.title === undefined ? {} : { title: manifest.title }),
      ...(target === undefined
        ? {}
        : { target, replaces: this.#options.manager.get(target)?.manifest?.version }),
      source: publicSource(stored),
      ...(manifest.engine === undefined ? {} : { engine: manifest.engine.mooncg }),
      permissions: Object.entries(manifest.permissions).map(([name, description]) => ({
        name,
        description,
      })),
      capabilities: manifest.capabilities,
      dependencies: manifest.dependencies,
      extension: manifest.extension !== undefined,
      panels: manifest.panels.length,
      dialogs: manifest.dialogs.length,
      graphics: manifest.graphics.length,
      assets: manifest.assets.length,
      config: manifest.config !== undefined,
      npm,
      installCode: !npm.needed ? 'none' : trusted ? 'allowed' : 'on-request',
      roles: this.#options.roles?.proposed(manifest.name, manifest.defaultRoles) ?? {
        grants: manifest.defaultRoles,
        applies: false,
      },
      ...size,
      by,
      stagedAt: new Date(given.stagedAt).toISOString(),
      expiresAt: new Date(given.expiresAt).toISOString(),
    };
    return { summary };
  }

  /**
   * Takes up a staged bundle an earlier run left: `undefined` when it is kept, else why it
   * is not. The note says how it was fetched, when, by whom, with what trust and for which
   * update; the files say everything else, and pass the checks of staging once more. It is
   * kept no longer than its lifetime from when it was staged, whatever the note says.
   */
  async #takeUp(id: string, dir: string, now: number): Promise<string | undefined> {
    const text = await readFile(join(dir, STAGED_NOTE), 'utf8').catch(() => undefined);
    if (text === undefined) return 'it has no note of how it was fetched';
    let read: unknown;
    try {
      read = JSON.parse(text);
    } catch {
      return 'its note is not valid';
    }
    const note = parseNote(read, id);
    if (!note) return 'its note is not valid';
    if (note.stagedAt > now) return 'its note says it was staged in the future';
    const expiresAt = Math.min(note.expiresAt, note.stagedAt + this.#ttlMs);
    if (expiresAt <= now) return 'its time is up';
    const content = join(dir, 'bundle');
    if (note.target !== undefined && !this.#options.manager.get(note.target)) {
      return `the bundle "${note.target}" it was to update is gone`;
    }
    const { manifest, errors } = await readManifest(content);
    if (!manifest) throw refuse(errors.join('; '));
    const problems = this.#problems(manifest, note.target);
    if (problems.length > 0) throw refuse(problems.join('; '));
    const { summary } = await this.#check({
      ...note,
      expiresAt,
      target: note.target,
      manifest,
      content,
      stored: note.source,
    });
    const entry: Staged = {
      summary,
      dir,
      content,
      source: note.source,
      manifest,
      trusted: note.trusted,
      state: 'staged',
    };
    this.#entries.set(id, entry);
    this.#arm(entry, expiresAt - now);
    this.#log.info(
      `The staged ${manifest.name} ${manifest.version} (staging ${id}) was kept across the restart until ${summary.expiresAt}`,
    );
    return undefined;
  }

  /** Starts the clock after which a staged bundle nobody decided about is deleted. */
  #arm(entry: Staged, ms = this.#ttlMs): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (entry.state !== 'staged') return;
      const { name, version } = entry.summary;
      this.#log.info(`The staged ${name} ${version} expired and was deleted`);
      void this.#drop(entry);
    }, ms);
    entry.timer.unref();
    this.#publish();
  }

  /** Forgets a staged bundle and deletes its folder. */
  async #drop(entry: Staged): Promise<void> {
    clearTimeout(entry.timer);
    this.#entries.delete(entry.summary.id);
    this.#publish();
    await removeDir(entry.dir).catch((error) => {
      this.#log.warn(`A staging folder could not be deleted: ${errorMessage(error)}`);
    });
  }

  /** Runs `work` as a job. Returns the job as it is at the start. */
  #begin(
    operation: BundleOperation,
    by: string,
    bundle: string | undefined,
    work: (progress: Progress) => Promise<Outcome>,
  ): InstallJob {
    const job: Mutable<InstallJob> = {
      id: randomBytes(8).toString('hex'),
      operation,
      state: 'queued',
      ...(bundle === undefined ? {} : { bundle }),
      by,
      startedAt: new Date(this.#now()).toISOString(),
    };
    this.#jobs.unshift(job);
    this.#trim();
    const move = (event: JobEvent) => {
      job.state = nextJobState(job.state, event) ?? job.state;
    };
    const snapshot = { ...job };
    const run = async (): Promise<InstallJob> => {
      // Not in the same breath: whoever started the job has its id before it moves.
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
        const what = `${operation}${job.bundle === undefined ? '' : ` of ${job.bundle}`}`;
        this.#log.error(`${by}: ${what} failed: ${errorMessage(error)}`);
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

  /** Forgets the oldest jobs beyond the number that is kept. One that still runs stays. */
  #trim(): void {
    for (let index = this.#jobs.length - 1; index >= 0 && this.#jobs.length > JOBS_KEPT; index--) {
      const job = this.#jobs[index];
      if (job && isJobFinished(job.state)) this.#jobs.splice(index, 1);
    }
  }

  /** A message as it may be published: without the paths of the server's folders. */
  #public(message: string): string {
    return publicError(withoutCredentials(message), this.#options.bundlesDir, this.#roots);
  }

  #publish(): void {
    const value = { jobs: this.jobs(), staged: this.staged() } as unknown as Json;
    if (JSON.stringify(value) === JSON.stringify(this.#published.value)) return;
    this.#published.applyOp({ patches: [{ op: 'replace', path: '', value }] });
  }
}
