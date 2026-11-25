import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import nodePath, { join } from 'node:path';
import { MoonCGError } from '@mooncg/core';
import { validRange } from 'semver';
import { redactSecrets } from '../auth/secrets.js';
import { errorMessage } from '../kernel/logger.js';
import { refuse } from './files.js';
import { withoutCredentials } from './git.js';
import { runTool } from './process.js';

export interface NpmRequest {
  /** The folder with the `package.json`. */
  readonly dir: string;
  /** Whether the folder has a lockfile, so that exactly what it lists is installed. */
  readonly lockfile: boolean;
  /**
   * Lets the install scripts of the packages run. They are programs of whoever published
   * the packages, run with the rights of the server, before the bundle was ever started.
   */
  readonly scripts: boolean;
  readonly timeoutMs: number;
  /** Ends npm when it fires, as when the server shuts down. */
  readonly signal?: AbortSignal | undefined;
  /** Told each line npm prints. */
  log(line: string): void;
}

/** Installs the npm dependencies of a folder. Rejects when that fails. */
export type NpmInstall = (request: NpmRequest) => Promise<void>;

/** What a fetched bundle asks of npm. */
export interface NpmNeed {
  /** Whether packages have to be installed before the bundle can run. */
  readonly needed: boolean;
  readonly lockfile: boolean;
  /** The names of the packages the bundle depends on, sorted. */
  readonly dependencies: readonly string[];
  /** Whether the bundle brought a `node_modules` folder. */
  readonly installed: boolean;
  /**
   * The files at the top of the bundle that steer npm or yarn, such as `.npmrc`. One of them
   * can tell npm which program to run as `git` or where to fetch from.
   */
  readonly config: readonly string[];
  /**
   * What npm would fetch from elsewhere than the registry: dependencies given as a Git
   * address, a URL, a path or a shorthand, and lockfile entries that resolve outside the
   * registry. Fetching those runs Git or builds a package, whatever `--ignore-scripts` says.
   */
  readonly unusual: readonly string[];
}

/** Where packages come from unless the server was given another registry. */
export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org/';

/** Where npm finds its configuration and keeps its cache: files and a folder of the server. */
export interface NpmIsolation {
  readonly userconfig: string;
  readonly globalconfig: string;
  readonly cache: string;
  readonly registry?: string | undefined;
}

/** The arguments npm is run with. Development dependencies are never installed. */
export function npmArguments(
  request: Pick<NpmRequest, 'lockfile' | 'scripts'>,
  isolation?: NpmIsolation,
): string[] {
  return [
    // `ci` installs what the lockfile says and fails if `package.json` disagrees with it.
    request.lockfile ? 'ci' : 'install',
    '--omit=dev',
    ...(request.scripts ? [] : ['--ignore-scripts']),
    '--no-audit',
    '--no-fund',
    ...(isolation === undefined
      ? []
      : [
          // Not the configuration of whoever runs the server, nor of the machine.
          `--userconfig=${isolation.userconfig}`,
          `--globalconfig=${isolation.globalconfig}`,
          `--cache=${isolation.cache}`,
          ...(isolation.registry === undefined ? [] : [`--registry=${isolation.registry}`]),
        ]),
  ];
}

/**
 * The path of npm's command line program, which Node runs: `npm-cli.js` of the npm that
 * was installed with the Node this server runs on. On Windows `npm` is `npm.cmd`, a batch
 * file, and Node starts batch files through a shell only. Running the JavaScript file with
 * Node itself needs no shell on any system.
 */
export function findNpmCli(
  execPath: string = process.execPath,
  exists: (path: string) => boolean = existsSync,
  path: Pick<typeof nodePath, 'dirname' | 'join'> = nodePath,
): string | undefined {
  const bin = path.dirname(execPath);
  const candidates = [
    // Windows: beside node.exe.
    path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    // Elsewhere: <prefix>/bin/node and <prefix>/lib/node_modules.
    path.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidates.find(exists);
}

/**
 * Whether a dependency is given as anything but a version of a package of the registry: a
 * range, a tag, or an alias (`npm:other@range`) for one. Everything else is fetched from a
 * place the bundle names, with Git or as an archive.
 */
export function unusualSpec(spec: unknown): boolean {
  if (typeof spec !== 'string') return true;
  let version = spec.trim();
  if (version.startsWith('npm:')) {
    const at = version.lastIndexOf('@');
    // `npm:name` and `npm:@scope/name` name no version: the latest.
    if (at <= 4) return /[\s:]/.test(version.slice(4));
    version = version.slice(at + 1);
  }
  if (version === '' || validRange(version) !== null) return false;
  // What is left may be a tag, which is a plain word.
  return !/^[A-Za-z0-9._-]+$/.test(version);
}

const isFile = (path: string) =>
  stat(path).then(
    (stats) => stats.isFile(),
    () => false,
  );
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const CONFIG_FILES = ['.npmrc', '.yarnrc', '.yarnrc.yml'];
const SPEC_SECTIONS = [
  'dependencies',
  'optionalDependencies',
  'devDependencies',
  'peerDependencies',
];
const LOCKFILES = ['npm-shrinkwrap.json', 'package-lock.json'];
/** More than this is not listed: the first few say what is going on. */
const MAX_UNUSUAL = 20;

/** The dependencies of a `package.json` that are no versions of registry packages. */
function unusualSpecs(json: Record<string, unknown>): string[] {
  const found: string[] = [];
  for (const section of SPEC_SECTIONS) {
    const listed = json[section];
    if (!isObject(listed)) continue;
    for (const [name, spec] of Object.entries(listed)) {
      if (unusualSpec(spec)) found.push(`${section}.${name}: ${withoutCredentials(String(spec))}`);
    }
  }
  const walk = (value: unknown, path: string, depth: number) => {
    if (typeof value === 'string') {
      // `$name` points at the version of a direct dependency.
      if (!value.startsWith('$') && unusualSpec(value)) {
        found.push(`${path}: ${withoutCredentials(value)}`);
      }
    } else if (isObject(value) && depth < 20) {
      for (const [key, inner] of Object.entries(value)) walk(inner, `${path}.${key}`, depth + 1);
    }
  };
  walk(json.overrides, 'overrides', 0);
  return found;
}

/** The entries of a lockfile that npm would fetch from elsewhere than `registry`. */
function unusualLocks(file: string, lock: unknown, registry: string): string[] {
  const origin = `${new URL(registry).origin}/`;
  const found: string[] = [];
  const check = (name: string, entry: unknown) => {
    if (!isObject(entry)) return;
    if (entry.link === true) return void found.push(`${file}: ${name} is a link`);
    const { resolved, version } = entry;
    const source =
      typeof resolved === 'string'
        ? resolved
        : typeof version === 'string' && /[:/]/.test(version)
          ? version
          : undefined;
    if (source !== undefined && !source.startsWith(origin)) {
      found.push(`${file}: ${name} comes from ${withoutCredentials(source)}`);
    }
  };
  if (!isObject(lock)) return [`${file}: it is no lockfile`];
  if (isObject(lock.packages)) {
    for (const [name, entry] of Object.entries(lock.packages)) if (name !== '') check(name, entry);
  }
  const older = (dependencies: unknown, depth: number) => {
    if (!isObject(dependencies) || depth > 50) return;
    for (const [name, entry] of Object.entries(dependencies)) {
      check(name, entry);
      if (isObject(entry)) older(entry.dependencies, depth + 1);
    }
  };
  older(lock.dependencies, 0);
  return found;
}

/**
 * Reads what a fetched bundle asks of npm, and what in it would make npm do more than fetch
 * packages from `registry`. Rejects for a `package.json` or a lockfile that is none.
 */
export async function npmNeed(dir: string, registry = DEFAULT_NPM_REGISTRY): Promise<NpmNeed> {
  const none: NpmNeed = {
    needed: false,
    lockfile: false,
    dependencies: [],
    installed: false,
    config: [],
    unusual: [],
  };
  const parse = async (name: string): Promise<unknown> => {
    const text = await readFile(join(dir, name), 'utf8');
    try {
      return JSON.parse(text);
    } catch (error) {
      throw refuse(`${name} is not valid JSON: ${errorMessage(error)}`);
    }
  };
  if (!(await isFile(join(dir, 'package.json')))) return none;
  const json = await parse('package.json');
  if (!isObject(json)) throw refuse('package.json must be an object');
  const names = new Set<string>();
  for (const key of ['dependencies', 'optionalDependencies'] as const) {
    const listed = json[key];
    if (listed === undefined) continue;
    if (!isObject(listed)) throw refuse(`package.json: "${key}" must be an object`);
    for (const name of Object.keys(listed)) names.add(name);
  }
  const dependencies = [...names].sort();
  const installed = await stat(join(dir, 'node_modules')).then(
    (stats) => stats.isDirectory(),
    () => false,
  );
  const config: string[] = [];
  for (const name of CONFIG_FILES) if (existsSync(join(dir, name))) config.push(name);
  const unusual = unusualSpecs(json);
  let lockfile = false;
  for (const name of LOCKFILES) {
    if (!(await isFile(join(dir, name)))) continue;
    lockfile = true;
    unusual.push(...unusualLocks(name, await parse(name), registry));
  }
  return {
    needed: dependencies.length > 0 && !installed,
    lockfile,
    dependencies,
    installed,
    config,
    unusual: unusual.slice(0, MAX_UNUSUAL),
  };
}

/** How many of the last lines npm printed are kept for the error message. */
const KEPT_LINES = 15;

export interface NpmInstallOptions {
  /** The path of `npm-cli.js`; without it, the one that came with Node. */
  readonly npmCli?: string | undefined;
  /**
   * A folder of the server for npm: two empty configuration files and the cache are kept
   * there, so that npm reads neither the configuration of the account the server runs as
   * nor that of the machine.
   */
  readonly home: string;
  /** The registry packages are fetched from. Without it, npm's own. */
  readonly registry?: string | undefined;
}

/**
 * Makes the function that installs npm dependencies by running npm. npm is kept away from
 * every configuration but the one the server gives it: its user and global configuration
 * are empty files, its settings in the environment are taken out, and the program it runs as
 * Git is plain `git` whatever a file says. A `.npmrc` in the folder itself is still read by
 * npm, which is why a bundle that brings one is not installed without being trusted first.
 */
export function createNpmInstall(options: NpmInstallOptions): NpmInstall {
  return async (request) => {
    const cli = options.npmCli ?? findNpmCli();
    if (cli === undefined || !existsSync(cli)) {
      throw new MoonCGError(
        'unavailable',
        'npm was not found beside the Node.js the server runs on. Install the dependencies yourself and put node_modules into the bundle.',
      );
    }
    const isolation: NpmIsolation = {
      userconfig: join(options.home, 'user-npmrc'),
      globalconfig: join(options.home, 'global-npmrc'),
      cache: join(options.home, 'cache'),
      registry: options.registry,
    };
    await mkdir(isolation.cache, { recursive: true });
    await writeFile(isolation.userconfig, '');
    await writeFile(isolation.globalconfig, '');
    // Whatever started the server, or whoever runs it, left settings for npm in the
    // environment, in any spelling. None of them is meant for this npm.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^npm_/i.test(key)),
    );
    // The environment wins over every file: `git` is Git, not a program a file names.
    env.npm_config_git = 'git';

    const safe = (text: string) => withoutCredentials(redactSecrets(text));
    const last: string[] = [];
    // Node runs the file itself. No shell is involved, so no name is taken apart by one.
    const result = await runTool(process.execPath, [cli, ...npmArguments(request, isolation)], {
      cwd: request.dir,
      env,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
      onLine: (line) => {
        const text = safe(line);
        last.push(text);
        if (last.length > KEPT_LINES) last.shift();
        request.log(text);
      },
    }).catch((error) => {
      throw new Error(`npm could not be started: ${errorMessage(error)}`);
    });
    if (result.aborted) throw new MoonCGError('unavailable', 'The server is shutting down');
    if (result.timedOut) {
      const seconds = Math.round(request.timeoutMs / 1000);
      throw new MoonCGError('timeout', `npm did not finish within ${seconds} s`);
    }
    if (result.code !== 0) throw refuse(`npm exited with code ${result.code}: ${last.join('\n')}`);
  };
}
