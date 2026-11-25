import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BUNDLE_NAME_PATTERN,
  HTTP_METHODS,
  type HttpMethod,
  isRoutePattern,
  type Json,
  type Manifest,
  MoonCGError,
  modulePermission,
  parseManifest,
  type Route,
  RouteTable,
  SYSTEM_PERMISSIONS,
} from '@mooncg/core';
import type {
  AuthProvider,
  ModuleContext,
  ModuleDispose,
  ModuleRoute,
  ModuleSetup,
} from '@mooncg/sdk/module';
import { redactSecrets } from '../auth/secrets.js';
import { engineProblem } from '../bundles/dependencies.js';
import type { BundleConfigs } from '../config/bundle-config.js';
import { errorMessage, type Logger } from '../kernel/logger.js';
import type { PasswordProvider, ProviderRegistry } from './providers.js';

const MANIFEST_FILE = 'mooncg.json';
/** The file a module is loaded from when its manifest names none. */
const DEFAULT_MAIN = 'index.js';
/** How long the setup of a module may take, unless configured otherwise. */
const SETUP_TIMEOUT_MS = 10_000;
/** How long a module may take to stop before the server goes on without it. */
const DISPOSE_TIMEOUT_MS = 5000;
const MAX_DESCRIPTION_LENGTH = 200;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

const MAX_SHOWN_FOLDER_NAME = 80;

/**
 * The name of a folder that cannot be a module, as it may be listed and logged. Characters
 * that draw nothing or reorder what is drawn (control and format characters) are written
 * out as their code, so that the name reads as what it is and as no other name.
 */
export function shownFolderName(name: string): string {
  return name
    .replace(/[\p{Cc}\p{Cf}]/gu, (hidden) => `\\u{${(hidden.codePointAt(0) ?? 0).toString(16)}}`)
    .slice(0, MAX_SHOWN_FOLDER_NAME);
}

/** `running`, or why not: `disabled` by choice, `failed` with an error. */
export type ModuleState = 'running' | 'disabled' | 'failed';

/** A permission a module defined. */
export interface DefinedPermission {
  readonly permission: string;
  readonly description: string;
}

/** A module as the server knows it at this moment. */
export interface ModuleRecord {
  readonly name: string;
  readonly title?: string | undefined;
  readonly version?: string | undefined;
  /** Shipped with MoonCG, not found in the modules folder. */
  readonly builtin: boolean;
  /** Part of the server itself: it always runs and cannot be disabled. */
  readonly internal: boolean;
  /** Whether an administrator has turned it on. That choice survives a restart. */
  readonly enabled: boolean;
  readonly state: ModuleState;
  /** Why it failed. */
  readonly error?: string | undefined;
  /** Whether it has a configuration to edit. */
  readonly config: boolean;
  /** The ids of the login providers it registered. */
  readonly providers: readonly string[];
  readonly permissions: readonly DefinedPermission[];
  /** How many HTTP routes it registered. */
  readonly routes: number;
}

/** A module that is shipped with the server: a folder with a manifest somewhere on disk. */
export interface BuiltinModule {
  readonly dir: string;
  /** For tests: loads the main file in place of importing what the manifest names. */
  readonly load?: (() => Promise<unknown>) | undefined;
}

/** What only the modules inside the server get, besides the public context. */
export interface InternalHooks {
  /** Registers a way to sign in with a password. */
  registerPasswordProvider(provider: PasswordProvider): void;
}

/** A module that is part of the server itself, written against the same context. */
export interface InternalModule {
  readonly name: string;
  readonly title: string;
  setup(ctx: ModuleContext, internal: InternalHooks): ReturnType<ModuleSetup>;
}

/** Remembers which modules an administrator has turned on. */
export interface ModuleSettingsStore {
  /** The names of the enabled modules, sorted. */
  enabled(): Promise<string[]>;
  setEnabled(module: string, enabled: boolean): Promise<void>;
}

/** A route of a module as the HTTP layer needs it. */
export interface MatchedModuleRoute {
  readonly route: ModuleRoute;
  readonly params: Readonly<Record<string, string>>;
}

export interface ModuleManagerOptions {
  /** The folder with one folder per module. It need not exist. */
  readonly modulesDir: string;
  readonly builtin?: readonly BuiltinModule[] | undefined;
  readonly internal?: readonly InternalModule[] | undefined;
  readonly store: ModuleSettingsStore;
  /** The configuration of the modules: `<data-dir>/config/modules/<name>.json`. */
  readonly configs: Pick<BundleConfigs, 'load' | 'scrub'>;
  readonly providers: ProviderRegistry;
  readonly logger: Logger;
  readonly mooncgVersion: string;
  readonly setupTimeoutMs?: number | undefined;
}

interface Found {
  readonly name: string;
  readonly dir: string;
  readonly builtin: boolean;
  readonly manifest: Manifest | undefined;
  readonly errors: readonly string[];
  readonly load?: (() => Promise<unknown>) | undefined;
  readonly internal?: InternalModule | undefined;
}

/** What a running module registered, so that all of it can be taken away again. */
interface Running {
  readonly permissions: Map<string, string>;
  readonly routes: Set<Route>;
  /** Takes away what was registered elsewhere, such as a provider. */
  readonly undo: (() => void)[];
  /** What the module asked to be run when it stops, in the order it asked. */
  readonly disposers: ModuleDispose[];
  /** Set once the module has stopped: its context registers nothing any more. */
  closed: boolean;
}

interface Entry {
  found: Found;
  enabled: boolean;
  state: ModuleState;
  error?: string | undefined;
  running?: Running | undefined;
}

/** Reads and checks the manifest in a module folder. `folder` is the name the folder has. */
export async function readModuleManifest(
  dir: string,
  folder?: string,
): Promise<{ manifest: Manifest | undefined; errors: string[] }> {
  const failed = (...errors: string[]) => ({ manifest: undefined, errors });
  let text: string;
  try {
    text = await readFile(join(dir, MANIFEST_FILE), 'utf8');
  } catch (error) {
    return failed(
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? `${MANIFEST_FILE} not found`
        : `${MANIFEST_FILE} could not be read: ${errorMessage(error)}`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return failed(`${MANIFEST_FILE} is not valid JSON: ${errorMessage(error)}`);
  }
  const result = parseManifest(json);
  if (!result.ok) {
    return failed(
      ...result.errors.map(({ path, message }) => (path ? `${path}: ${message}` : message)),
    );
  }
  const { manifest } = result;
  if (manifest.kind !== 'module') {
    return failed(`kind: Expected a module, found a ${manifest.kind}`);
  }
  if (folder !== undefined && manifest.name !== folder) {
    return failed(`name: Module "${manifest.name}" must live in a folder of the same name`);
  }
  return { manifest, errors: [] };
}

/**
 * The modules of an installation: those shipped with the server and those in the modules
 * folder. A module is trusted code that runs inside this process, so none runs until an
 * administrator has enabled it, and that choice is remembered.
 *
 * Whatever a module registers through its context is tracked here and taken away when the
 * module is disabled or fails. A module that cannot be loaded, or whose setup throws, shows
 * as `failed` with the reason; the server and the other modules run on.
 */
export class ModuleManager {
  readonly #options: ModuleManagerOptions;
  readonly #entries = new Map<string, Entry>();
  /** The routes of all running modules, by module in the place of the bundle. */
  readonly #routes = new RouteTable();
  readonly #handlers = new Map<Route, ModuleRoute>();
  /** One change at a time: the next waits for the one before. */
  #queue: Promise<unknown> = Promise.resolve();
  /** Counts the loads, so that a main file is read again after it was repaired. */
  #loads = 0;

  constructor(options: ModuleManagerOptions) {
    this.#options = options;
  }

  /** Finds the modules and starts those that are enabled. Never rejects over a module. */
  load(): Promise<void> {
    return this.#serialized(async () => {
      const { modulesDir, builtin = [], internal = [], store } = this.#options;
      const enabled = new Set(await store.enabled());
      const found: Found[] = internal.map((module) => ({
        name: module.name,
        dir: '',
        builtin: true,
        manifest: undefined,
        errors: [],
        internal: module,
      }));
      for (const { dir, load } of builtin) {
        const read = await readModuleManifest(dir);
        // A built-in module that cannot even say its name is a broken installation.
        if (!read.manifest) {
          this.#options.logger.error(
            `The built-in module in ${dir} is unusable: ${read.errors.join('; ')}`,
          );
          continue;
        }
        found.push({ name: read.manifest.name, dir, builtin: true, load, ...read });
      }
      /** Folders whose name no module can have. */
      const invalid: Found[] = [];
      const folders = await readdir(modulesDir, { withFileTypes: true }).catch(() => []);
      for (const folder of folders.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (!folder.isDirectory() || folder.name.startsWith('.')) continue;
        const dir = join(modulesDir, folder.name);
        if (!BUNDLE_NAME_PATTERN.test(folder.name)) {
          // Listed, like a bundle folder that cannot be a bundle, so that it is seen why
          // nothing comes of it; by a name that can be shown, and never read or started.
          const name = shownFolderName(folder.name);
          const error =
            'Invalid name: a module folder is named in lowercase letters, digits and single dashes, like the module in it';
          this.#options.logger.warn(`The folder "${name}" in ${modulesDir} is no module. ${error}`);
          invalid.push({ name, dir, builtin: false, manifest: undefined, errors: [error] });
          continue;
        }
        found.push({
          name: folder.name,
          dir,
          builtin: false,
          ...(await readModuleManifest(dir, folder.name)),
        });
      }
      for (const module of found) {
        if (this.#entries.has(module.name)) {
          // The name is taken by a module shipped with the server, which stays what it is.
          this.#options.logger.error(
            `The module folder ${module.dir} is ignored: MoonCG ships a module called "${module.name}"`,
          );
          continue;
        }
        const on = module.internal !== undefined || enabled.has(module.name);
        this.#entries.set(module.name, { found: module, enabled: on, state: 'disabled' });
      }
      // No name of a module is like these, so none of them is in the way of one, and no
      // request reaches them: whatever asks for a module asks by a name a module can have.
      for (const module of invalid) {
        this.#entries.set(module.name, {
          found: module,
          enabled: false,
          state: 'failed',
          error: module.errors.join('; '),
        });
      }
      for (const entry of this.#entries.values()) {
        if (entry.enabled) await this.#start(entry);
      }
    });
  }

  list(): ModuleRecord[] {
    return [...this.#entries.values()]
      .map((entry) => this.#describe(entry))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  get(name: string): ModuleRecord | undefined {
    const entry = this.#entries.get(name);
    return entry && this.#describe(entry);
  }

  /** The folder and manifest of a module that has a configuration, for the settings. */
  configurable(
    name: string,
  ): { name: string; dir: string; manifest: Pick<Manifest, 'config'> } | undefined {
    const found = this.#entries.get(name)?.found;
    return found?.manifest?.config === undefined
      ? undefined
      : { name, dir: found.dir, manifest: found.manifest };
  }

  /**
   * Turns a module on, remembers that, and starts it. A module that is on already is started
   * again if it had failed, which is how a repaired module is tried without a restart.
   * Resolves with the module as it is then, which may be `failed`.
   */
  enable(name: string): Promise<ModuleRecord> {
    return this.#serialized(async () => {
      const entry = this.#existing(name);
      if (!entry.enabled) {
        await this.#options.store.setEnabled(name, true);
        entry.enabled = true;
      }
      if (entry.state !== 'running') {
        // The folder may have changed since it was looked at: its manifest is read again.
        await this.#refresh(entry);
        await this.#start(entry);
      }
      return this.#describe(entry);
    });
  }

  /** Stops a module, takes away everything it registered, and remembers that it is off. */
  disable(name: string): Promise<ModuleRecord> {
    return this.#serialized(async () => {
      const entry = this.#existing(name);
      if (entry.found.internal) {
        throw new MoonCGError(
          'conflict',
          `The module "${name}" is part of the server and cannot be disabled`,
        );
      }
      await this.#options.store.setEnabled(name, false);
      entry.enabled = false;
      await this.#stop(entry);
      entry.state = 'disabled';
      entry.error = undefined;
      return this.#describe(entry);
    });
  }

  /** Starts an enabled module again, with its configuration as it is now. */
  restart(name: string): Promise<ModuleRecord> {
    return this.#serialized(async () => {
      const entry = this.#existing(name);
      if (entry.enabled) {
        await this.#stop(entry);
        await this.#refresh(entry);
        await this.#start(entry);
      }
      return this.#describe(entry);
    });
  }

  /** Every system permission there is: the built-in ones, then what running modules defined. */
  permissions(): (DefinedPermission & { readonly module?: string })[] {
    return [
      ...Object.entries(SYSTEM_PERMISSIONS).map(([permission, description]) => ({
        permission,
        description,
      })),
      ...this.list().flatMap((module) =>
        module.permissions.map((defined) => ({ ...defined, module: module.name })),
      ),
    ];
  }

  /** The route of a module that answers a request, if there is one. */
  match(module: string, method: string, path: string): MatchedModuleRoute | undefined {
    const match = this.#routes.match(module, method, path);
    const route = match && this.#handlers.get(match.route);
    return match && route ? { route, params: match.params } : undefined;
  }

  /** The routes of each method that would answer a path, to say what is allowed there. */
  methods(module: string, path: string): ModuleRoute[] {
    return this.#routes.methods(module, path).flatMap((route) => this.#handlers.get(route) ?? []);
  }

  /** Stops every module, the last started first. */
  close(): Promise<void> {
    return this.#serialized(async () => {
      for (const entry of [...this.#entries.values()].reverse()) await this.#stop(entry);
    });
  }

  #serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(work);
    this.#queue = result.catch(() => {});
    return result;
  }

  #existing(name: string): Entry {
    const entry = BUNDLE_NAME_PATTERN.test(name) ? this.#entries.get(name) : undefined;
    if (!entry) throw new MoonCGError('not_found', `There is no module "${name}"`);
    return entry;
  }

  #describe(entry: Entry): ModuleRecord {
    const { found, enabled, state, error, running } = entry;
    return {
      name: found.name,
      title: found.internal?.title ?? found.manifest?.title,
      version: found.internal ? this.#options.mooncgVersion : found.manifest?.version,
      builtin: found.builtin,
      internal: found.internal !== undefined,
      enabled,
      state,
      ...(error === undefined ? {} : { error }),
      config: found.manifest?.config !== undefined,
      providers: this.#options.providers.of(found.name),
      permissions: [...(running?.permissions ?? [])].map(([permission, description]) => ({
        permission,
        description,
      })),
      routes: running?.routes.size ?? 0,
    };
  }

  /** Reads the manifest of a module in the modules folder again. */
  async #refresh(entry: Entry): Promise<void> {
    const { found } = entry;
    if (found.internal) return;
    const isDirectory = await stat(found.dir).then(
      (stats) => stats.isDirectory(),
      () => false,
    );
    const read = isDirectory
      ? await readModuleManifest(found.dir, found.builtin ? undefined : found.name)
      : { manifest: undefined, errors: ['The folder of the module is gone'] };
    entry.found = { ...found, ...read };
  }

  /** Starts a module. Whatever goes wrong ends in `failed`, never in a rejection. */
  async #start(entry: Entry): Promise<void> {
    const { found } = entry;
    const { logger, configs } = this.#options;
    const running: Running = {
      permissions: new Map(),
      routes: new Set(),
      undo: [],
      disposers: [],
      closed: false,
    };
    try {
      let setup: unknown;
      let config: Record<string, Json> = {};
      if (found.internal) {
        const { internal } = found;
        setup = (ctx: ModuleContext) => internal.setup(ctx, this.#internalHooks(found, running));
      } else {
        if (!found.manifest) throw new Error(found.errors.join('; '));
        const engine = engineProblem(found.manifest.engine?.mooncg, this.#options.mooncgVersion);
        if (engine !== undefined) throw new Error(engine);
        const loaded = await configs.load({
          name: found.name,
          dir: found.dir,
          manifest: found.manifest,
        });
        if (!loaded.ok) throw new Error(loaded.errors.join('; '));
        config = loaded.values;
        setup = setupOf(await this.#import(found));
      }
      if (typeof setup !== 'function') {
        throw new Error(
          'The main file has no setup: its default export must be a function, or an object with a function "setup"',
        );
      }
      entry.running = running;
      const context = this.#context(found, running, config);
      const returned = await bounded(
        Promise.resolve().then(() => (setup as ModuleSetup)(context)),
        this.#options.setupTimeoutMs ?? SETUP_TIMEOUT_MS,
        'The setup did not finish',
      );
      // What the setup returns stops the module first, before what it registered.
      if (typeof returned === 'function') running.disposers.push(returned);
      entry.state = 'running';
      entry.error = undefined;
      if (!found.internal) logger.info(`Module "${found.name}" is running`);
    } catch (error) {
      entry.running = running;
      await this.#stop(entry);
      entry.state = 'failed';
      // No message is kept or shown with a secret of a configuration or a token in it.
      entry.error = redactSecrets(configs.scrub(errorMessage(error)));
      logger.error(`Module "${found.name}" failed: ${entry.error}`);
    }
  }

  /** Stops a module and takes away everything it registered. */
  async #stop(entry: Entry): Promise<void> {
    const { running, found } = entry;
    if (!running) return;
    entry.running = undefined;
    running.closed = true;
    const { logger } = this.#options;
    for (const dispose of running.disposers.reverse()) {
      try {
        await bounded(
          Promise.resolve().then(dispose),
          DISPOSE_TIMEOUT_MS,
          'Stopping did not finish',
        );
      } catch (error) {
        logger.error(`Module "${found.name}" failed while it stopped: ${errorMessage(error)}`);
      }
    }
    for (const undo of running.undo.reverse()) undo();
    for (const route of running.routes) this.#handlers.delete(route);
    running.routes.clear();
    running.permissions.clear();
  }

  async #import(found: Found): Promise<unknown> {
    if (found.load) return found.load();
    const file = join(found.dir, found.manifest?.main ?? DEFAULT_MAIN);
    const isFile = await stat(file).then(
      (stats) => stats.isFile(),
      () => false,
    );
    if (!isFile)
      throw new Error(`The main file "${found.manifest?.main ?? DEFAULT_MAIN}" is missing`);
    // Node keeps what it has loaded, also a file that failed to load. The query makes each
    // load a new one, so a repaired main file is read again. Files it imports are not.
    return import(`${pathToFileURL(file).href}?load=${++this.#loads}`);
  }

  #internalHooks(found: Found, running: Running): InternalHooks {
    return {
      registerPasswordProvider: (provider) => {
        this.#open(found, running);
        running.undo.push(this.#options.providers.addPassword(provider));
      },
    };
  }

  #open(found: Found, running: Running): void {
    if (running.closed) {
      throw new MoonCGError(
        'conflict',
        `The module "${found.name}" has stopped and cannot register anything`,
      );
    }
  }

  /** The context of one start of a module. Everything it registers lands in `running`. */
  #context(found: Found, running: Running, config: Record<string, Json>): ModuleContext {
    const { providers } = this.#options;
    const log = this.#options.logger.child(`module:${found.name}`);
    const wrong = (problem: string) => new MoonCGError('invalid', problem);
    const open = () => this.#open(found, running);
    return {
      name: found.name,
      dir: found.dir,
      config: deepFreeze(structuredClone(config)),
      logger: {
        info: (message) => log.info(String(message)),
        warn: (message) => log.warn(String(message)),
        error: (message) => log.error(String(message)),
      },
      auth: {
        registerProvider: (provider: AuthProvider) => {
          open();
          running.undo.push(providers.add(found.name, found.dir, provider));
        },
      },
      http: {
        register: (route: ModuleRoute) => {
          open();
          const given = (typeof route === 'object' && route !== null ? route : {}) as ModuleRoute;
          const { method, path, permission, handler } = given;
          if (!HTTP_METHODS.includes(method as HttpMethod)) {
            throw wrong(`A route needs a method: ${HTTP_METHODS.join(', ')}`);
          }
          if (typeof path !== 'string' || !isRoutePattern(path)) {
            throw wrong(`"${String(path)}" is not a route path such as /items/:id`);
          }
          if (typeof handler !== 'function') throw wrong(`The route ${path} needs a handler`);
          const isPublic = given.public === true;
          if ((permission === undefined) === !isPublic) {
            throw wrong(
              `The route ${method} ${path} must say who may call it: either a "permission" or "public: true"`,
            );
          }
          // A route asks for a permission the server knows or the module itself defined:
          // never a wildcard, and never a text that only looks like a permission.
          if (
            permission !== undefined &&
            !Object.hasOwn(SYSTEM_PERMISSIONS, permission) &&
            !running.permissions.has(permission)
          ) {
            throw wrong(
              `The route ${method} ${path} asks for "${String(permission)}", which is neither a system permission nor one this module defined`,
            );
          }
          const entry: Route = {
            bundle: found.name,
            method,
            pattern: path,
            permission: permission ?? '',
            // The table is used for matching only; the handler is called by the HTTP layer.
            invoke: () => Promise.reject(new MoonCGError('internal', 'Not a bundle route')),
          };
          const remove = this.#routes.add(entry);
          this.#handlers.set(entry, { ...given, public: isPublic ? true : undefined });
          running.routes.add(entry);
          running.undo.push(remove);
        },
      },
      permissions: {
        define: (name: string, description: string) => {
          open();
          let permission: string;
          try {
            permission = modulePermission(found.name, name);
          } catch (error) {
            throw wrong(errorMessage(error));
          }
          if (
            typeof description !== 'string' ||
            description.length > MAX_DESCRIPTION_LENGTH ||
            CONTROL.test(description)
          ) {
            throw wrong(
              `The description of "${name}" must be a text of at most ${MAX_DESCRIPTION_LENGTH} characters`,
            );
          }
          running.permissions.set(permission, description);
          return permission;
        },
      },
      onDispose: (dispose: ModuleDispose) => {
        open();
        if (typeof dispose !== 'function') throw wrong('onDispose takes a function');
        running.disposers.push(dispose);
      },
    };
  }
}

/** The setup a main file exports: its default export, or the `setup` of that. */
function setupOf(loaded: unknown): unknown {
  const exported = (loaded as { default?: unknown } | undefined)?.default;
  if (typeof exported === 'function') return exported;
  return (exported as { setup?: unknown } | undefined)?.setup;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Waits for `work`, but not longer than `ms`. */
function bounded<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} within ${ms} ms`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
