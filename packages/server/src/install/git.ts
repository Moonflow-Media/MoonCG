import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { gitRefProblem, MoonCGError } from '@mooncg/core';
import {
  ipProblem,
  type Reach,
  Refused,
  type Resolver,
  resolveChecked,
} from '../registry/network.js';
import { refuse, removeDir } from './files.js';
import { runTool } from './process.js';

export interface GitOptions {
  /** How long fetching may take in all, in milliseconds. */
  readonly timeoutMs: number;
  /**
   * For tests only: takes `file://` addresses, so that a test can fetch from a repository on
   * its own disk. It is set by whoever starts the server in code. No request, flag or
   * environment variable turns it on.
   */
  readonly allowFileUrls?: boolean | undefined;
  /** For tests: what to run instead of `git`, as a program and its first arguments. */
  readonly command?: readonly string[] | undefined;
  /** For tests: the environment git starts from instead of the server's own. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Ends git when it fires, as when the server shuts down. */
  readonly signal?: AbortSignal | undefined;
  /**
   * How many bytes the folder may hold while git fetches into it, history included. A fetch
   * that outgrows it is ended. Without it only the time bounds a fetch.
   */
  readonly maxBytes?: number | undefined;
  /** How often the folder is measured while git runs, in milliseconds. */
  readonly pollMs?: number | undefined;
  /**
   * Where git may connect: this machine only for what an index on this machine lists, and
   * the private networks the configuration allows. Without it, neither.
   */
  readonly reach?: Reach | undefined;
  /** Resolves host names instead of the system resolver. For tests. */
  readonly resolve?: Resolver | undefined;
}

export interface GitSource {
  readonly url: string;
  /** A branch, a tag or a commit. Without it, what the repository has as `HEAD`. */
  readonly ref?: string | undefined;
}

const MAX_URL_LENGTH = 2048;
const ACCEPTED = 'Only https://, ssh:// and user@host:path Git addresses are accepted';
/** `user@host:path`, the short way to write an SSH address. No part may start with a dash. */
const SCP_ADDRESS =
  /^[A-Za-z0-9_][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*:[A-Za-z0-9._~/][^\s:]*$/;
const HOST = /^[A-Za-z0-9[][A-Za-z0-9.:\]-]*$/;

/**
 * Why an address is not fetched from, or `undefined` if it is. Git takes much more than
 * addresses in that place: options, local paths and `ext::` commands that it would run. So
 * only the forms that name a host over HTTPS or SSH get through.
 */
export function gitUrlProblem(url: unknown, allowFileUrls = false): string | undefined {
  if (typeof url !== 'string' || url === '') return 'The Git address is missing';
  if (url.length > MAX_URL_LENGTH) return 'The Git address is too long';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
  if (/[\s\u0000-\u001f\u007f]/.test(url)) return 'The Git address contains a space';
  if (url.startsWith('-')) return `A Git address cannot start with "-". ${ACCEPTED}`;
  if (/^[A-Za-z0-9+.-]+::/.test(url)) return ACCEPTED;
  if (SCP_ADDRESS.test(url)) return undefined;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url)?.[1]?.toLowerCase();
  const allowed = allowFileUrls ? ['https', 'ssh', 'file'] : ['https', 'ssh'];
  if (scheme === undefined || !allowed.includes(scheme) || !URL.canParse(url)) return ACCEPTED;
  if (scheme === 'file') return undefined;
  // Checked as written, not as a URL parser reads it: git and ssh see what was written.
  const authority = url.slice(scheme.length + 3).split(/[/?#]/)[0] ?? '';
  const at = authority.lastIndexOf('@');
  const user = at === -1 ? '' : authority.slice(0, at);
  const host = authority.slice(at + 1);
  if (host === '' || !HOST.test(host)) return `The Git address names no usable host. ${ACCEPTED}`;
  if (user.startsWith('-')) return `The Git address names no usable user. ${ACCEPTED}`;
  return undefined;
}

/**
 * The host a Git address names and the port it is reached on, as git and ssh read it:
 * `https://` on 443 unless a port is given, `ssh://` and `user@host:path` on 22. Only for
 * addresses `gitUrlProblem` takes; `undefined` for `file://`.
 */
export function gitHostOf(
  url: string,
): { readonly host: string; readonly port: number; readonly https: boolean } | undefined {
  const scp = SCP_ADDRESS.exec(url);
  if (scp && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url)) {
    const host = url.slice(url.indexOf('@') + 1, url.indexOf(':', url.indexOf('@')));
    return { host: host.toLowerCase(), port: 22, https: false };
  }
  if (!URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'ssh:') return undefined;
  const https = parsed.protocol === 'https:';
  const port = parsed.port === '' ? (https ? 443 : 22) : Number(parsed.port);
  return { host: parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase(), port, https };
}

/** Where a Git address leads, as it was checked: its host, port and checked addresses. */
interface CheckedTarget {
  readonly host: string;
  readonly port: number;
  readonly https: boolean;
  /** Empty when the address names an IP address itself. */
  readonly addresses: readonly { readonly address: string; readonly family: number }[];
}

/**
 * Checks where a Git address leads before git connects, by the rules of the registry: never
 * an internal address unless the configuration allows its private network, and this machine
 * only where `reach` allows it. A name is resolved here, within the time and the signal of
 * the stage (`bounded`), and every address it resolves to must be allowed. `undefined` for a
 * `file://` address of a test.
 */
async function checkReach(
  url: string,
  options: GitOptions,
  bounded: <T>(work: Promise<T>, late: () => Error) => Promise<T>,
): Promise<CheckedTarget | undefined> {
  const target = gitHostOf(url);
  if (target === undefined) return undefined;
  const reach = options.reach ?? { loopback: false };
  const shown = withoutCredentials(url);
  if (isIP(target.host) !== 0) {
    const problem = ipProblem(target.host, reach);
    if (problem !== undefined) throw refuse(`${shown}: ${problem}`);
    return { ...target, addresses: [] };
  }
  try {
    const addresses = await bounded(
      resolveChecked(target.host, reach, { resolve: options.resolve }),
      () =>
        new MoonCGError(
          'timeout',
          `${shown}: the name ${target.host} was not resolved within ${Math.round(options.timeoutMs / 1000)} s`,
        ),
    );
    return { ...target, addresses };
  } catch (error) {
    if (error instanceof MoonCGError) throw error;
    if (error instanceof Refused) throw refuse(`${shown}: ${error.message}`);
    const code = (error as NodeJS.ErrnoException).code;
    throw refuse(
      `${shown}: the name ${target.host} could not be resolved${code === undefined ? '' : ` (${code})`}`,
    );
  }
}

/**
 * The `-c` options that pin git to the addresses that were checked, so that it does not
 * resolve the name again (`http.curloptResolve`: an empty value first clears whatever the
 * configuration of the machine says for any host), and that keep it from following a redirect
 * to a host that was not checked. SSH resolves names itself and cannot be pinned this way: for
 * `ssh://` and `user@host:path` the name is checked, not pinned.
 */
function pinOptions(target: CheckedTarget | undefined): string[] {
  if (target === undefined || !target.https) return [];
  const addresses = target.addresses
    .map(({ address }) => (address.includes(':') ? `[${address}]` : address))
    .join(',');
  return [
    '-c',
    'http.curloptResolve=',
    ...(addresses === ''
      ? []
      : ['-c', `http.curloptResolve=${target.host}:${target.port}:${addresses}`]),
    '-c',
    'http.followRedirects=false',
  ];
}

/** The oldest Git that takes `http.curloptResolve`, and an empty value of it that clears it. */
const PIN_SINCE = [2, 37] as const;

/** The major and minor version in what `git --version` prints, such as `2.52.0.windows.1`. */
export function gitVersionOf(text: string): readonly [number, number] | undefined {
  const match = /^git version (\d+)\.(\d+)/m.exec(text);
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}

/** What `git --version` said, per program: it is asked once. */
const versions = new Map<string, readonly [number, number] | undefined>();

/**
 * Variables of the environment git is not started with: proxies (curl reads them, and a
 * proxy resolves and connects in place of the checked address), configuration passed through
 * the environment, which could undo every `-c` given here, TLS checks switched off, the
 * repository and work tree of another folder, and traces that would print headers with
 * credentials into what is shown.
 */
const DROPPED_ENV =
  /^(?:(?:https?|all|no|ftp)_proxy|GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)|GIT_SSL_NO_VERIFY|GIT_PROXY_COMMAND|GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_COMMON_DIR|GIT_NAMESPACE|GIT_TRACE\w*|GIT_CURL_VERBOSE)$/i;

/** The environment git is started with. */
function gitEnv(options: GitOptions): Record<string, string | undefined> {
  const base = options.env ?? process.env;
  const kept = Object.fromEntries(Object.entries(base).filter(([key]) => !DROPPED_ENV.test(key)));
  return {
    ...kept,
    // Whatever the address is or redirects to, git speaks nothing else.
    GIT_ALLOW_PROTOCOL: options.allowFileUrls ? 'https:ssh:file' : 'https:ssh',
    // There is nobody to answer a prompt: a repository that needs a password fails at once.
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_SSH_COMMAND: kept.GIT_SSH_COMMAND ?? 'ssh -oBatchMode=yes',
    GIT_LFS_SKIP_SMUDGE: '1',
  };
}

/** The rule of a ref is the one of an index entry: kept in `@mooncg/core`. */
export { gitRefProblem };

/**
 * Takes what may be a secret out of every URL in a text, for whatever is shown, logged or
 * answered: everything before the last `@` of the host part, which is where a user name, a
 * password or a token goes, and the query and the fragment, where tokens are passed too.
 * `user@host:path` holds no secret and stays.
 */
export function withoutCredentials(text: string): string {
  return text.replace(
    /([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s'"<>()]*)/g,
    (_all, scheme: string, rest: string) => {
      const slash = rest.indexOf('/');
      const authority = slash === -1 ? rest : rest.slice(0, slash);
      const host = authority.slice(authority.lastIndexOf('@') + 1).replace(/[?#].*$/, '');
      const path = slash === -1 ? '' : rest.slice(slash).replace(/[?#].*$/, '');
      return `${scheme}${authority.includes('@') ? '***@' : ''}${host}${path}`;
    },
  );
}

const COMMIT = /^[0-9a-f]{40,64}$/;
const DEFAULT_POLL_MS = 1000;

/** How many bytes the files below a folder take. What cannot be read counts as nothing. */
async function folderBytes(dir: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) bytes += await folderBytes(path);
    else
      bytes += await stat(path).then(
        (stats) => stats.size,
        () => 0,
      );
  }
  return bytes;
}

/**
 * Fetches one commit of a repository into `dest`, which must not exist yet, and removes the
 * `.git` folder, so that what is left is the files alone. Answers with the commit that was
 * checked out. Whatever fails leaves no `dest` behind.
 *
 * Git is run directly, never through a shell, with the address behind `--`, a list of
 * protocols it may use, and no way to ask anyone for a password. The configuration of the
 * machine still applies where it says how to reach a host (credential helpers, SSH, TLS,
 * `url.*.insteadOf`, whose result is checked and pinned like the address), but nothing of it
 * that would run a program does: no hook, no file system monitor, and no filter. No proxy is
 * used, and an `https://` address needs a Git that can be pinned (2.37 or newer). Files are checked out as they were committed; a file kept
 * in Git LFS comes out as its pointer. Submodules are not fetched.
 */
export async function fetchGit(
  source: GitSource,
  dest: string,
  options: GitOptions,
): Promise<{ commit: string }> {
  const problem = gitUrlProblem(source.url, options.allowFileUrls) ?? gitRefProblem(source.ref);
  if (problem !== undefined) throw refuse(problem);
  const shown = withoutCredentials(source.url);

  const [program = 'git', ...first] = options.command ?? ['git'];
  const env = gitEnv(options);
  /** Set once where the address leads was checked: holds git to the checked addresses. */
  let pinned: string[] = [];
  /** Set on every call: what the machine's configuration might run is switched off. */
  const neutral = () => [
    '-c',
    'core.fsmonitor=false',
    // A folder that never exists: no hook is found there.
    '-c',
    `core.hooksPath=${join(dest, '.git', 'no-hooks')}`,
    '-c',
    'filter.lfs.required=false',
    '-c',
    'filter.lfs.process=',
    '-c',
    'filter.lfs.smudge=',
    '-c',
    'filter.lfs.clean=',
    '-c',
    `protocol.file.allow=${options.allowFileUrls ? 'always' : 'never'}`,
    // Links are written as plain files, so nothing checked out points out of the folder.
    '-c',
    'core.symlinks=false',
    '-c',
    'advice.detachedHead=false',
    // A proxy would resolve and connect in place of the checked address: none is used.
    '-c',
    'http.proxy=',
    ...pinned,
  ];
  /**
   * Git for Windows cannot use a pin with the TLS backend its configuration names when that is
   * not the one its libcurl started with (`http.sslBackend=openssl`, the default of its
   * installer): it fails with "Unsupported SSL backend" and names the one it has. The fetch is
   * then run again, still pinned, with that backend. Nothing else of the configuration changes.
   */
  let backend: string[] = [];

  const stop = new AbortController();
  const shutDown = () => stop.abort();
  options.signal?.addEventListener('abort', shutDown, { once: true });
  if (options.signal?.aborted) stop.abort();
  let tooLarge = false;
  let measuring = false;
  const { maxBytes } = options;
  const watch =
    maxBytes === undefined
      ? undefined
      : setInterval(() => {
          if (measuring) return;
          measuring = true;
          void folderBytes(dest).then((bytes) => {
            measuring = false;
            if (bytes <= maxBytes) return;
            tooLarge = true;
            stop.abort();
          });
        }, options.pollMs ?? DEFAULT_POLL_MS);

  const deadline = Date.now() + options.timeoutMs;
  const seconds = Math.round(options.timeoutMs / 1000);
  const shuttingDown = () => new MoonCGError('unavailable', 'The server is shutting down');
  /** Waits for `work` within the time of the stage, and not past the end of the server. */
  const bounded = <T>(work: Promise<T>, late: () => Error): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(late()), Math.max(1, deadline - Date.now()));
      const ended = () => reject(shuttingDown());
      stop.signal.addEventListener('abort', ended, { once: true });
      if (stop.signal.aborted) ended();
      work.then(resolve, reject).finally(() => {
        clearTimeout(timer);
        stop.signal.removeEventListener('abort', ended);
      });
    });
  /** Runs git once and answers how it ended, unless it could not finish at all. */
  const run = async (args: readonly string[]) => {
    let result: Awaited<ReturnType<typeof runTool>>;
    try {
      result = await runTool(program, [...first, ...neutral(), ...backend, ...args], {
        env,
        timeoutMs: Math.max(1, deadline - Date.now()),
        signal: stop.signal,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      throw new MoonCGError(
        'unavailable',
        'Git is not installed on the server, or not on its PATH. Install Git, or install the bundle from a ZIP archive.',
      );
    }
    if (tooLarge) throw refuse(`The repository is larger than ${maxBytes} bytes`);
    if (result.aborted) throw shuttingDown();
    if (result.timedOut) throw new MoonCGError('timeout', `Git did not finish within ${seconds} s`);
    return result;
  };
  const git = async (...args: string[]): Promise<string> => {
    const result = await run(args);
    if (result.code === 0) return result.stdout;
    // Only git's own line counts, not what a server passes on through it (`remote: …`).
    const supported =
      pinned.length > 0 && backend.length === 0
        ? /^(?:fatal|error): Unsupported SSL backend '[^']*'\. Supported SSL backends:\s+([a-z][a-z0-9-]*)\s*$/m.exec(
            result.stderr,
          )?.[1]
        : undefined;
    if (supported !== undefined) {
      backend = ['-c', `http.sslBackend=${supported}`];
      return git(...args);
    }
    // `http.followRedirects=false`: a repository that moved answers with a redirect.
    const redirect =
      /^fatal: unable to access '[^']*': The requested URL returned error: (30\d)\b/m.exec(
        result.stderr,
      )?.[1];
    if (redirect !== undefined) {
      throw refuse(
        `Git could not fetch ${shown}: the repository answered with a redirect (HTTP ${redirect}); give its new address`,
      );
    }
    const said = withoutCredentials(result.stderr.trim() || `git exited with ${result.code}`);
    throw refuse(`Git could not fetch ${shown}: ${said.slice(-2000)}`);
  };
  /** Whether this git can be pinned at all: asked once per program. */
  const pinnable = async () => {
    const key = [program, ...first].join('\0');
    if (!versions.has(key)) versions.set(key, gitVersionOf(await git('--version')));
    const version = versions.get(key);
    if (version === undefined) {
      throw new MoonCGError(
        'unavailable',
        'Git did not say its version, so it is not known whether it can be held to the checked address. Install a current Git, or install the bundle from a ZIP archive.',
      );
    }
    const [major, minor] = version;
    if (major < PIN_SINCE[0] || (major === PIN_SINCE[0] && minor < PIN_SINCE[1])) {
      throw new MoonCGError(
        'unavailable',
        `Git ${major}.${minor} cannot be held to the checked address of an https:// source: that needs Git ${PIN_SINCE.join('.')} or newer (http.curloptResolve). Update Git on the server, or install the bundle from a ZIP archive.`,
      );
    }
  };

  try {
    // Where the address leads is checked before anything is created.
    let target = await checkReach(source.url, options, bounded);
    // No template: nothing of this machine's hook templates is copied into the repository.
    await git('init', '--quiet', '--template=', '--', dest);
    // What is said here wins over every `.gitattributes`: no path has a filter.
    await mkdir(join(dest, '.git', 'info'), { recursive: true });
    await writeFile(join(dest, '.git', 'info', 'attributes'), '* -filter\n');
    if (target !== undefined) {
      // The configuration of the machine can rewrite an address (`url.*.insteadOf`). Git says
      // what it makes of it, in the new repository, where the fetch reads the same: where
      // that leads is what is checked and pinned.
      const effective = (await git('-C', dest, 'ls-remote', '--get-url', '--', source.url)).trim();
      if (effective === '') throw refuse(`Git did not say where ${shown} leads`);
      if (effective !== source.url) {
        const rewritten = `${shown} is rewritten by the Git configuration of the server (url.*.insteadOf) to ${withoutCredentials(effective)}`;
        const wrong = gitUrlProblem(effective, options.allowFileUrls);
        if (wrong !== undefined) throw refuse(`${rewritten}: ${wrong}`);
        try {
          target = await checkReach(effective, options, bounded);
        } catch (error) {
          if (error instanceof MoonCGError && error.code === 'invalid') {
            throw refuse(`${rewritten}. ${error.message}`);
          }
          throw error;
        }
      }
      if (target?.https) {
        await pinnable();
        // A proxy the configuration names for this address would be used in place of the
        // checked address; `-c http.proxy=` clears only the one for every address.
        const proxy = await run(['-C', dest, 'config', '--get-urlmatch', 'http.proxy', effective]);
        // 1: nothing is set. Anything else: the configuration could not be read.
        if (proxy.code !== 0 && proxy.code !== 1) {
          const said = withoutCredentials(proxy.stderr.trim() || `git exited with ${proxy.code}`);
          throw refuse(`Git could not read its configuration: ${said.slice(-2000)}`);
        }
        if (proxy.code === 0 && proxy.stdout.trim() !== '') {
          throw refuse(
            `${shown}: the Git configuration of the server names a proxy for this address (http.<url>.proxy). Git sources are fetched without a proxy, from the checked address only; remove that setting`,
          );
        }
      }
      pinned = pinOptions(target);
    }
    await git(
      '-C',
      dest,
      'fetch',
      '--quiet',
      '--depth=1',
      '--no-tags',
      '--no-recurse-submodules',
      '--',
      source.url,
      source.ref ?? 'HEAD',
    );
    await git('-C', dest, 'checkout', '--quiet', '--detach', 'FETCH_HEAD');
    const commit = (await git('-C', dest, 'rev-parse', '--verify', 'HEAD')).trim();
    if (!COMMIT.test(commit)) throw refuse('Git did not say which commit it checked out');
    clearInterval(watch);
    await removeDir(join(dest, '.git'));
    return { commit };
  } catch (error) {
    clearInterval(watch);
    await removeDir(dest).catch(() => {});
    throw error;
  } finally {
    clearInterval(watch);
    options.signal?.removeEventListener('abort', shutDown);
  }
}
