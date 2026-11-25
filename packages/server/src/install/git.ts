import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MoonCGError } from '@mooncg/core';
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

const MAX_REF_LENGTH = 200;
const REF = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;

/** Why a ref is not asked for, or `undefined` if it is: a plain branch, tag or commit name. */
export function gitRefProblem(ref: unknown): string | undefined {
  if (ref === undefined) return undefined;
  const usable =
    typeof ref === 'string' &&
    ref.length <= MAX_REF_LENGTH &&
    REF.test(ref) &&
    !ref.includes('..') &&
    !ref.includes('//') &&
    !ref.endsWith('/') &&
    !ref.endsWith('.') &&
    !ref.endsWith('.lock');
  return usable ? undefined : 'The ref must be the plain name of a branch, a tag or a commit';
}

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
 * machine still applies where it says how to reach a host (credential helpers, SSH,
 * `url.*.insteadOf`), but nothing of it that would run a program does: no hook, no file
 * system monitor, and no filter. Files are checked out as they were committed; a file kept
 * in Git LFS comes out as its pointer. Submodules are not fetched.
 */
export async function fetchGit(
  source: GitSource,
  dest: string,
  options: GitOptions,
): Promise<{ commit: string }> {
  const problem = gitUrlProblem(source.url, options.allowFileUrls) ?? gitRefProblem(source.ref);
  if (problem !== undefined) throw refuse(problem);

  const [program = 'git', ...first] = options.command ?? ['git'];
  const base = options.env ?? process.env;
  const env = {
    ...base,
    // Whatever the address is or redirects to, git speaks nothing else.
    GIT_ALLOW_PROTOCOL: options.allowFileUrls ? 'https:ssh:file' : 'https:ssh',
    // There is nobody to answer a prompt: a repository that needs a password fails at once.
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_SSH_COMMAND: base.GIT_SSH_COMMAND ?? 'ssh -oBatchMode=yes',
    GIT_LFS_SKIP_SMUDGE: '1',
  };
  /** Set on every call: what the machine's configuration might run is switched off. */
  const neutral = [
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
  ];

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
  const git = async (...args: string[]): Promise<string> => {
    let result: Awaited<ReturnType<typeof runTool>>;
    try {
      result = await runTool(program, [...first, ...neutral, ...args], {
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
    if (result.aborted) throw new MoonCGError('unavailable', 'The server is shutting down');
    if (result.timedOut) {
      const seconds = Math.round(options.timeoutMs / 1000);
      throw new MoonCGError('timeout', `Git did not finish within ${seconds} s`);
    }
    if (result.code !== 0) {
      const said = withoutCredentials(result.stderr.trim() || `git exited with ${result.code}`);
      throw refuse(`Git could not fetch ${withoutCredentials(source.url)}: ${said.slice(-2000)}`);
    }
    return result.stdout;
  };

  try {
    // No template: nothing of this machine's hook templates is copied into the repository.
    await git('init', '--quiet', '--template=', '--', dest);
    // What is said here wins over every `.gitattributes`: no path has a filter.
    await mkdir(join(dest, '.git', 'info'), { recursive: true });
    await writeFile(join(dest, '.git', 'info', 'attributes'), '* -filter\n');
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
