import { join } from 'node:path';
import {
  BUNDLE_NAME_PATTERN,
  type BundleEvent,
  type BundleState,
  DASHBOARD_VIEW,
  type Json,
  type Manifest,
  type MessageBus,
  MoonCGError,
  nextBundleState,
  type Replicant,
  type ReplicantRegistry,
  SYSTEM_BUNDLE,
  type Timers,
} from '@mooncg/core';
import type { ExtensionHost } from '../extension-host/extension-host.js';
import { errorMessage, type Logger } from '../kernel/logger.js';
import { declareReplicants } from '../replicants/declare.js';
import type { ReplicantPersistence } from '../replicants/persistence.js';
import type { BundleSettingsStore } from '../storage/replicant-store.js';
import { type BundleRecord, discoverBundles, readBundle } from './bundles.js';
import { type Dependable, dependencyProblem, dependentsOf, planStart } from './dependencies.js';
import { privateRoots, publicError } from './errors.js';

/**
 * Restart policy. A start someone asked for (at boot, by enable or by reload) is not retried
 * when it fails. A running extension that crashes is started again, at most this many times
 * in a row; a start that fails during such an automatic restart counts as one of them.
 */
export const RESTART_ATTEMPTS = 3;
/** The wait before the first restart. It doubles with each further attempt. */
export const RESTART_DELAY_MS = 1000;
/** A bundle that has run this long without crashing gets a fresh count of attempts. */
export const RESTART_STABLE_MS = 60_000;

/** The name of the read-only replicant that lists the bundles and their states. */
export const BUNDLES_REPLICANT = 'bundles';

export interface BundleManagerOptions {
  readonly bundlesDir: string;
  readonly registry: ReplicantRegistry;
  readonly host: ExtensionHost;
  readonly logger: Logger;
  /** Without a bus, bundles have no messages. */
  readonly bus?: MessageBus | undefined;
  /** Stores `persistent` replicants. Without it nothing is kept across restarts. */
  readonly persistence?: ReplicantPersistence | undefined;
  /** Remembers which bundles are disabled. Without it, all start enabled every time. */
  readonly settings?: BundleSettingsStore | undefined;
  /** For the restart delays. Defaults to real time. */
  readonly timers?: Timers | undefined;
}

type Mutable = { -readonly [Key in keyof BundleRecord]: BundleRecord[Key] };

interface Restart {
  attempts: number;
  /** Fires the next attempt. */
  retry?: unknown;
  /** Fires when the bundle has run long enough to forget earlier crashes. */
  stable?: unknown;
}

/**
 * Owns the bundles at run time: which exist, what state each is in, and every change of
 * state. Changes to one bundle run one after another, and a change waits for the bundles it
 * depends on or that depend on it; changes to unrelated bundles run side by side, so one slow
 * extension holds up nobody else. The states are published in the read-only replicant
 * `system:bundles`.
 */
export class BundleManager {
  readonly #options: BundleManagerOptions;
  readonly #timers: Timers;
  readonly #roots: readonly string[];
  readonly #records = new Map<string, Mutable>();
  readonly #restarts = new Map<string, Restart>();
  /** The dependents that were stopped because a bundle crashed, to start again when it is back. */
  readonly #stranded = new Map<string, string[]>();
  /** The last change queued for each bundle. A new change waits for the ones it touches. */
  readonly #tails = new Map<string, Promise<unknown>>();
  readonly #summary: Replicant;
  #bootOrder: readonly string[] = [];
  #closed = false;

  constructor(options: BundleManagerOptions) {
    this.#options = options;
    this.#timers = options.timers ?? { setTimeout, clearTimeout };
    this.#roots = [options.bundlesDir, ...privateRoots()];
    this.#summary = options.registry.declare(SYSTEM_BUNDLE, BUNDLES_REPLICANT, {
      initial: [],
      readPermission: DASHBOARD_VIEW,
      readOnly: true,
    }).replicant;
    options.host.onCrash((bundle, error) => {
      void this.#locked(this.#withDependents(bundle), () => this.#crashed(bundle, error));
    });
  }

  /** Discovers the bundles and starts those that are not disabled. Resolves when all are done. */
  async start(): Promise<void> {
    await this.load();
    await this.startAll();
  }

  /**
   * Discovers the bundles and settles what can be settled without running anything: disabled
   * bundles are `disabled`, unusable ones `failed`, and the rest `enabling` until `startAll`
   * has started them.
   */
  async load(): Promise<void> {
    const disabled = new Set(await this.#options.settings?.disabled());
    for (const found of await discoverBundles(this.#options.bundlesDir)) {
      this.#records.set(found.name, { ...found, state: 'installed' });
    }
    const enabled = [...this.#records.values()].filter((record) => !disabled.has(record.name));
    const plan = planStart(enabled.flatMap((record) => this.#dependable(record) ?? []));
    this.#bootOrder = plan.order;
    for (const record of this.#records.values()) {
      if (disabled.has(record.name)) {
        this.#move(record, 'disable');
        this.#move(record, 'stopped');
        continue;
      }
      this.#move(record, 'enable');
      if (plan.order.includes(record.name)) continue;
      const problem = plan.problems.get(record.name);
      this.#fail(record, problem === undefined ? record.errors : [problem]);
    }
    this.#publish();
  }

  /**
   * Starts the bundles `load` left `enabling`: each after the bundles it depends on, and
   * bundles that do not depend on each other at the same time.
   */
  async startAll(): Promise<void> {
    const order = this.#bootOrder;
    this.#bootOrder = [];
    await Promise.all(
      order.map((name) =>
        this.#locked([name, ...this.#dependencies(name)], async () => {
          const record = this.#records.get(name);
          if (record?.state === 'enabling') await this.#run(record);
        }),
      ),
    );
  }

  list(): readonly BundleRecord[] {
    return [...this.#records.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): BundleRecord | undefined {
    return this.#records.get(name);
  }

  isRunning(name: string): boolean {
    return this.#records.get(name)?.state === 'running';
  }

  /** Starts a bundle from what is on disk now. A bundle that cannot start ends up `failed`. */
  enable(name: string): Promise<BundleRecord> {
    return this.#change(
      name,
      [name, ...this.#dependencies(name), ...this.#dependents(name)],
      async () => {
        const existing = this.#records.get(name);
        if (existing) this.#assertCan(existing, 'enable');
        this.#forgetRestarts(name);
        const record = await this.#enable(name);
        await this.#options.settings?.setDisabled(name, false);
        if (record.state === 'running') await this.#startStranded(name, 'came back');
        return record;
      },
    );
  }

  /**
   * Stops a bundle and removes what it exposed. Refused while running bundles depend on it:
   * taking a dependency away under them would break them without anyone having asked.
   */
  disable(name: string): Promise<BundleRecord> {
    return this.#change(name, this.#withDependents(name), async () => {
      const record = this.#known(name);
      this.#assertCan(record, 'disable');
      const dependents = this.#runningDependents(name);
      if (dependents.length > 0) {
        throw new MoonCGError(
          'conflict',
          `Bundle "${name}" is needed by ${dependents.join(', ')}; disable those first`,
        );
      }
      this.#forgetRestarts(name);
      this.#stranded.delete(name);
      await this.#disable(record);
      await this.#options.settings?.setDisabled(name, true);
      return record;
    });
  }

  /**
   * Stops and starts a bundle, picking up its manifest and extension code from disk. Running
   * bundles that depend on it are stopped first and started again afterwards. A dependent
   * that does not come back stays `failed`, with an error that says so.
   */
  reload(name: string): Promise<BundleRecord> {
    const scope = [name, ...this.#dependencies(name), ...this.#dependents(name)];
    return this.#change(name, scope, async () => {
      const record = this.#known(name);
      if (record.state === 'disabled') {
        throw new MoonCGError('conflict', `Bundle "${name}" is disabled`);
      }
      this.#forgetRestarts(name);
      const dependents = this.#runningDependents(name);
      for (const dependent of [...dependents].reverse()) {
        await this.#disable(this.#known(dependent));
      }
      await this.#disable(record);
      await this.#enable(name);
      const stranded = this.#stranded.get(name) ?? [];
      this.#stranded.set(name, [...new Set([...dependents, ...stranded])]);
      if (record.state === 'running') await this.#startStranded(name, 'was reloaded');
      else this.#failStranded(name, `Not started: bundle "${name}" failed to reload`);
      return record;
    });
  }

  /** Resolves once no change of state is running or waiting. */
  async idle(): Promise<void> {
    for (let seen: unknown[] = []; ; ) {
      const tails = [...this.#tails.values()];
      if (tails.length === seen.length && tails.every((tail, index) => tail === seen[index])) {
        return;
      }
      seen = tails;
      await Promise.all(tails);
    }
  }

  /**
   * Stops every extension, at the same time and without waiting for changes that are still
   * under way: a bundle that is still starting is aborted. For shutdown.
   */
  async close(): Promise<void> {
    this.#closed = true;
    for (const name of [...this.#restarts.keys()]) this.#forgetRestarts(name);
    await this.#options.host.close();
    await this.#options.persistence?.flush();
  }

  /** A change someone asked for. The name is checked before anything is touched. */
  #change<T>(name: string, scope: readonly string[], work: () => Promise<T>): Promise<T> {
    if (!BUNDLE_NAME_PATTERN.test(name)) {
      return Promise.reject(new MoonCGError('not_found', `There is no bundle "${name}"`));
    }
    return this.#locked(scope, work);
  }

  /** Runs `work` once every earlier change to one of the `names` has finished. */
  #locked<T>(names: readonly string[], work: () => Promise<T>): Promise<T> {
    const unique = [...new Set(names)];
    const earlier = unique.map((name) => this.#tails.get(name));
    const result = Promise.all(earlier).then(work);
    const tail = result.catch(() => {});
    for (const name of unique) this.#tails.set(name, tail);
    return result;
  }

  #known(name: string): Mutable {
    const record = this.#records.get(name);
    if (!record) throw new MoonCGError('not_found', `There is no bundle "${name}"`);
    return record;
  }

  #assertCan(record: BundleRecord, event: BundleEvent): void {
    if (nextBundleState(record.state, event) === undefined) {
      throw new MoonCGError('conflict', `Bundle "${record.name}" is ${record.state}`);
    }
  }

  #move(record: Mutable, event: BundleEvent): void {
    this.#assertCan(record, event);
    record.state = nextBundleState(record.state, event) as BundleState;
  }

  /** The full error goes to the log; what is published has its file paths taken out. */
  #fail(record: Mutable, errors: readonly string[]): Mutable {
    this.#move(record, 'fail');
    const log = this.#options.logger.child(`bundle:${record.name}`);
    for (const error of errors) log.error(error);
    record.errors = errors.map((error) => publicError(error, record.dir, this.#roots));
    record.lastError = record.errors[0];
    this.#publish();
    return record;
  }

  /** Brings a bundle from wherever it rests to `enabling` and starts it. */
  async #enable(name: string): Promise<Mutable> {
    let record = this.#records.get(name);
    if (!record) {
      // Only a real folder directly inside the bundles directory becomes a bundle.
      const found = await readBundle(this.#options.bundlesDir, name);
      if (!found) throw new MoonCGError('not_found', `There is no bundle "${name}"`);
      record = { ...found, state: 'installed' };
      this.#records.set(name, record);
    }
    this.#move(record, 'enable');
    this.#publish();
    return this.#run(record);
  }

  /** Starts a bundle that is `enabling`, from what is on disk now. */
  async #run(record: Mutable): Promise<Mutable> {
    const { bundlesDir, registry, bus, host, persistence, logger } = this.#options;
    const { name } = record;
    const found = await readBundle(bundlesDir, name);
    record.manifest = found?.manifest;
    record.errors = found?.errors ?? ['mooncg.json not found'];
    const { manifest } = record;
    if (!manifest) return this.#fail(record, record.errors);

    const problems = Object.entries(manifest.dependencies).flatMap(([dependency, range]) => {
      const other = this.#records.get(dependency);
      const problem = dependencyProblem(dependency, range, other && this.#dependable(other));
      if (problem !== undefined) return problem;
      return other?.state === 'running'
        ? []
        : `dependencies.${dependency}: bundle "${dependency}" is not running`;
    });
    if (problems.length > 0) return this.#fail(record, problems);

    const replicants = await declareReplicants(
      { name, dir: record.dir, manifest },
      { registry, persistence, logger: logger.child(`bundle:${name}`) },
    );
    if (replicants.errors.length > 0) return this.#fail(record, replicants.errors);
    for (const [topic, permissions] of Object.entries(manifest.messages)) {
      bus?.declare(name, topic, permissions);
    }
    try {
      if (manifest.extension !== undefined) {
        await host.start({
          bundle: name,
          version: manifest.version,
          entry: join(record.dir, manifest.extension),
          capabilities: manifest.capabilities,
          permissions: Object.keys(manifest.permissions),
        });
      }
    } catch (error) {
      // Nothing of this bundle is being saved yet, so what its extension wrote is dropped.
      this.#retract(name);
      return this.#fail(record, [`Extension failed to start: ${errorMessage(error)}`]);
    }
    replicants.startSaving();
    this.#move(record, 'started');
    record.errors = [];
    record.lastError = undefined;
    this.#publish();
    return record;
  }

  async #disable(record: Mutable): Promise<void> {
    const wasRunning = record.state === 'running';
    this.#move(record, 'disable');
    if (wasRunning) await this.#stop(record.name);
    this.#move(record, 'stopped');
    record.errors = [];
    this.#publish();
  }

  /** Stops a running bundle's extension and takes away what the bundle exposes. */
  async #stop(name: string): Promise<void> {
    await this.#options.host.stop(name);
    await this.#options.persistence?.flush();
    this.#retract(name);
  }

  /** Removes what a bundle exposes. Clients subscribed to it are told that it is gone. */
  #retract(name: string): void {
    this.#options.registry.undeclare(name);
    this.#options.bus?.undeclare(name);
  }

  /**
   * The host has already released what the crashed extension itself had registered. The
   * bundles that depend on it are stopped: they would be left holding on to replicants and
   * messages that are gone. They start again when the bundle is back.
   */
  async #crashed(name: string, error: Error): Promise<void> {
    const record = this.#records.get(name);
    if (this.#closed || record?.state !== 'running') return;
    const dependents = this.#runningDependents(name);
    for (const dependent of [...dependents].reverse()) {
      await this.#stop(dependent);
      this.#fail(this.#known(dependent), [`Stopped because bundle "${name}" crashed`]);
    }
    this.#stranded.set(name, [...new Set([...dependents, ...(this.#stranded.get(name) ?? [])])]);
    await this.#options.persistence?.flush();
    this.#retract(name);
    this.#fail(record, [`Extension crashed: ${error.message}`]);
    this.#scheduleRestart(name);
  }

  #scheduleRestart(name: string): void {
    const restart = this.#restarts.get(name) ?? { attempts: 0 };
    this.#restarts.set(name, restart);
    this.#timers.clearTimeout(restart.stable);
    if (restart.attempts >= RESTART_ATTEMPTS) {
      this.#options.logger
        .child(`bundle:${name}`)
        .error(`Failed ${RESTART_ATTEMPTS} restarts in a row; it is not restarted again`);
      this.#failStranded(name, `Bundle "${name}" crashed and was not restarted`, true);
      return;
    }
    const delay = RESTART_DELAY_MS * 2 ** restart.attempts;
    restart.attempts++;
    restart.retry = this.#timers.setTimeout(() => {
      void this.#locked(this.#withDependents(name), async () => {
        if (this.#closed || this.#records.get(name)?.state !== 'failed') return;
        const record = await this.#enable(name);
        if (record.state !== 'running') {
          this.#scheduleRestart(name);
          return;
        }
        restart.stable = this.#timers.setTimeout(
          () => this.#restarts.delete(name),
          RESTART_STABLE_MS,
        );
        await this.#startStranded(name, 'recovered');
      });
    }, delay);
  }

  /** A person has taken over: pending restarts and the count of attempts no longer apply. */
  #forgetRestarts(name: string): void {
    const restart = this.#restarts.get(name);
    this.#timers.clearTimeout(restart?.retry);
    this.#timers.clearTimeout(restart?.stable);
    this.#restarts.delete(name);
  }

  /**
   * Starts the dependents that were stopped for `name`, in dependency order. One that fails
   * stays failed: this start was not its own crash, so it is not retried.
   */
  async #startStranded(name: string, event: string): Promise<void> {
    const dependents = this.#stranded.get(name) ?? [];
    this.#stranded.delete(name);
    for (const dependent of dependents) {
      const record = this.#records.get(dependent);
      if (!record || (record.state !== 'failed' && record.state !== 'disabled')) continue;
      const started = await this.#enable(dependent);
      if (started.state === 'running') continue;
      const reason =
        event === 'was reloaded'
          ? `Restart after the reload of "${name}" failed`
          : `Restart after "${name}" ${event} failed`;
      record.errors = record.errors.map((error) => `${reason}: ${error}`);
      record.lastError = record.errors[0];
      this.#publish();
    }
  }

  /** Marks the dependents that wait for `name` as failed for that reason. */
  #failStranded(name: string, reason: string, keep = false): void {
    for (const dependent of this.#stranded.get(name) ?? []) {
      const record = this.#records.get(dependent);
      if (!record) continue;
      if (record.state === 'disabled') this.#move(record, 'enable');
      if (record.state === 'enabling') this.#move(record, 'fail');
      if (record.state !== 'failed') continue;
      record.errors = [reason];
      record.lastError = reason;
    }
    // Kept after the automatic restarts ran out, so a later enable still brings them back.
    if (!keep) this.#stranded.delete(name);
    this.#publish();
  }

  #dependable(record: BundleRecord): Dependable | undefined {
    return record.manifest && { name: record.name, ...pick(record.manifest) };
  }

  #dependencies(name: string): string[] {
    return Object.keys(this.#records.get(name)?.manifest?.dependencies ?? {});
  }

  /** Every bundle that depends on `name`, directly or not, each after what it depends on. */
  #dependents(name: string): string[] {
    const bundles = [...this.#records.values()].flatMap((record) => this.#dependable(record) ?? []);
    return dependentsOf(name, bundles);
  }

  #withDependents(name: string): string[] {
    return [name, ...this.#dependents(name)];
  }

  #runningDependents(name: string): string[] {
    return this.#dependents(name).filter((dependent) => this.isRunning(dependent));
  }

  #publish(): void {
    const value: Json = this.list().map(({ name, state, manifest, errors, lastError }) => ({
      name,
      state,
      ...(manifest?.title === undefined ? {} : { title: manifest.title }),
      ...(manifest === undefined ? {} : { version: manifest.version }),
      errors: [...errors],
      ...(lastError === undefined ? {} : { lastError }),
    }));
    if (JSON.stringify(value) === JSON.stringify(this.#summary.value)) return;
    this.#summary.applyOp({ patches: [{ op: 'replace', path: '', value }] });
  }
}

const pick = ({ version, dependencies }: Manifest) => ({ version, dependencies });
