import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchGit, gitRefProblem, gitUrlProblem, withoutCredentials } from '../src/install/git.js';

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mooncg-git-'));
  made.push(dir);
  return dir;
}

/** Whether git can be run here. Where it cannot, the tests that need it are skipped. */
const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;

describe('gitUrlProblem', () => {
  it.each([
    'https://github.com/owner/repo.git',
    'https://git.example.org:8443/group/sub/repo',
    'https://user:token@example.org/owner/repo.git',
    'ssh://git@github.com/owner/repo.git',
    'ssh://git@example.org:2222/owner/repo.git',
    'git@github.com:owner/repo.git',
    'deploy@git.example.org:group/repo',
  ])('accepts "%s"', (url) => {
    expect(gitUrlProblem(url)).toBeUndefined();
  });

  it.each([
    ['an option', '--upload-pack=touch /tmp/pwned'],
    ['an option', '-u'],
    ['an option after a space', ' --upload-pack=x'],
    ['a local file URL', 'file:///srv/repos/secret.git'],
    ['a local file URL in capitals', 'FILE:///srv/repos/secret.git'],
    ['the ext transport', 'ext::sh -c "touch /tmp/pwned"'],
    ['the fd transport', 'fd::17'],
    ['a transport helper', 'testgit::https://example.org/repo'],
    ['plain http', 'http://example.org/repo.git'],
    ['the git protocol', 'git://example.org/repo.git'],
    ['ftp', 'ftp://example.org/repo.git'],
    ['a local path', '/srv/repos/secret.git'],
    ['a relative path', '../secret.git'],
    ['a Windows path', 'C:\\repos\\secret.git'],
    ['a Windows path with slashes', 'C:/repos/secret.git'],
    ['a UNC path', '\\\\server\\share\\repo.git'],
    ['an scp address without a user', 'example.org:owner/repo.git'],
    ['an ssh host that is an option', 'ssh://-oProxyCommand=calc/x'],
    ['an ssh user that is an option', 'ssh://-oProxyCommand=calc@example.org/x'],
    ['an scp user that is an option', '-oProxyCommand=calc@example.org:x'],
    ['an scp host that is an option', 'git@-oProxyCommand=calc:x'],
    ['an scp path that is an option', 'git@example.org:-x'],
    ['a line break', 'https://example.org/repo.git\n--upload-pack=x'],
    ['a space', 'https://example.org/re po.git'],
    ['no host', 'https:///repo.git'],
    ['nothing', ''],
    ['something very long', `https://example.org/${'a'.repeat(2100)}`],
  ])('refuses %s: "%s"', (_what, url) => {
    expect(gitUrlProblem(url)).toEqual(expect.any(String));
  });

  it('refuses what is no text', () => {
    expect(gitUrlProblem(undefined)).toEqual(expect.any(String));
    expect(gitUrlProblem(['https://example.org/repo'])).toEqual(expect.any(String));
  });

  it('takes a file URL only where a test allowed it', () => {
    expect(gitUrlProblem('file:///srv/repo.git', true)).toBeUndefined();
    expect(gitUrlProblem('file:///srv/repo.git', false)).toContain('https://');
    // The allowance opens nothing else.
    expect(gitUrlProblem('ext::sh -c x', true)).toEqual(expect.any(String));
    expect(gitUrlProblem('--upload-pack=x', true)).toEqual(expect.any(String));
  });
});

describe('gitRefProblem', () => {
  it.each([
    undefined,
    'main',
    'v1.2.3',
    'release/2026-11',
    'feature/some_thing',
    '0123456789abcdef0123456789abcdef01234567',
  ])('accepts %s', (ref) => {
    expect(gitRefProblem(ref)).toBeUndefined();
  });

  it.each([
    '',
    '-x',
    '--upload-pack=x',
    'a..b',
    'a b',
    'a:b',
    '+refs/heads/*:refs/remotes/*',
    '^main',
    'main~1',
    'a\\b',
    '/main',
    'main/',
    'a//b',
    'x.lock',
    'ref\nline',
    'x'.repeat(300),
    42,
  ])('refuses %s', (ref) => {
    expect(gitRefProblem(ref)).toEqual(expect.any(String));
  });
});

describe('withoutCredentials', () => {
  it('takes the user and password out of URLs', () => {
    expect(withoutCredentials('https://user:s3cret@example.org/a/b.git')).toBe(
      'https://***@example.org/a/b.git',
    );
    expect(
      withoutCredentials("fatal: unable to access 'https://tok3n@example.org/x.git/': 403"),
    ).toBe("fatal: unable to access 'https://***@example.org/x.git/': 403");
    expect(withoutCredentials('https://example.org/a.git')).toBe('https://example.org/a.git');
    expect(withoutCredentials('git@github.com:owner/repo.git')).toBe(
      'git@github.com:owner/repo.git',
    );
  });
});

/**
 * A stand-in for git: a script that notes how it was called and answers as told. It shows
 * what the server would run without anything being fetched.
 */
async function fakeGit(behaviour = '') {
  const dir = await temp();
  const log = join(dir, 'calls.jsonl');
  const script = join(dir, 'fake-git.mjs');
  await writeFile(
    script,
    `import { appendFileSync, mkdirSync } from 'node:fs';
const args = process.argv.slice(2);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(GIT_|GCM_)/.test(key)));
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, env }) + '\\n');
${behaviour}
if (args.includes('init')) mkdirSync(args.at(-1) + '/.git', { recursive: true });
if (args.includes('rev-parse')) console.log('${'a'.repeat(40)}');
`,
  );
  const calls = async () =>
    (await readFile(log, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { args: string[]; env: Record<string, string> });
  return { command: [process.execPath, script], calls };
}

describe('fetchGit, as it calls git', () => {
  it('passes the address and the ref after "--", never through a shell', async () => {
    const git = await fakeGit();
    const dest = join(await temp(), 'bundle');
    const url = 'https://example.org/owner/repo.git';

    const result = await fetchGit({ url, ref: 'v1.2.3' }, dest, { timeoutMs: 20_000, ...git });

    expect(result).toEqual({ commit: 'a'.repeat(40) });
    const calls = await git.calls();
    const fetch = calls.find(({ args }) => args.includes('fetch'))?.args ?? [];
    expect(fetch.slice(fetch.indexOf('--'))).toEqual(['--', url, 'v1.2.3']);
    expect(fetch).toContain('--depth=1');
    expect(fetch).toContain('--no-recurse-submodules');
    const init = calls.find(({ args }) => args.includes('init'))?.args ?? [];
    expect(init.slice(init.indexOf('--'))).toEqual(['--', dest]);
    // No hook of a template runs when the files are checked out.
    expect(init).toContain('--template=');
    // Every call is `git <options> <command> ...` with each argument on its own.
    for (const { args } of calls) expect(args.every((arg) => typeof arg === 'string')).toBe(true);
  });

  it('fetches HEAD when no ref is given', async () => {
    const git = await fakeGit();
    await fetchGit({ url: 'git@example.org:o/r.git' }, join(await temp(), 'b'), {
      timeoutMs: 20_000,
      ...git,
    });
    const fetch = (await git.calls()).find(({ args }) => args.includes('fetch'))?.args ?? [];
    expect(fetch.slice(fetch.indexOf('--'))).toEqual(['--', 'git@example.org:o/r.git', 'HEAD']);
  });

  it('allows https and ssh only, and never asks for credentials', async () => {
    const git = await fakeGit();
    await fetchGit({ url: 'https://example.org/o/r.git' }, join(await temp(), 'b'), {
      timeoutMs: 20_000,
      ...git,
      env: { GIT_ALLOW_PROTOCOL: 'file:ext', GIT_TERMINAL_PROMPT: '1', PATH: process.env.PATH },
    });
    for (const { env } of await git.calls()) {
      expect(env.GIT_ALLOW_PROTOCOL).toBe('https:ssh');
      expect(env.GIT_TERMINAL_PROMPT).toBe('0');
      expect(env.GCM_INTERACTIVE).toBe('never');
      expect(env.GIT_SSH_COMMAND).toContain('BatchMode=yes');
    }
  });

  it('removes .git after the checkout', async () => {
    const git = await fakeGit();
    const dest = join(await temp(), 'bundle');
    await fetchGit({ url: 'https://example.org/o/r.git' }, dest, { timeoutMs: 20_000, ...git });
    expect(await readdir(dest)).toEqual([]);
  });

  it.each([
    '--upload-pack=touch pwned',
    'file:///srv/secret.git',
    'ext::sh -c "touch pwned"',
    'http://example.org/repo.git',
  ])('refuses "%s" before git is run at all', async (url) => {
    const git = await fakeGit();
    const dest = join(await temp(), 'bundle');
    const fetched = fetchGit({ url }, dest, { timeoutMs: 20_000, ...git });
    await expect(fetched).rejects.toMatchObject({ code: 'invalid' });
    expect(await git.calls()).toEqual([]);
    expect(existsSync(dest)).toBe(false);
  });

  it('refuses a ref that is an option before git is run at all', async () => {
    const git = await fakeGit();
    const fetched = fetchGit(
      { url: 'https://example.org/o/r.git', ref: '--upload-pack=x' },
      join(await temp(), 'b'),
      { timeoutMs: 20_000, ...git },
    );
    await expect(fetched).rejects.toMatchObject({ code: 'invalid' });
    expect(await git.calls()).toEqual([]);
  });

  it('says so clearly when git is not installed', async () => {
    const dest = join(await temp(), 'bundle');
    const fetched = fetchGit({ url: 'https://example.org/o/r.git' }, dest, {
      timeoutMs: 20_000,
      command: ['mooncg-test-no-such-git-binary'],
    });
    await expect(fetched).rejects.toThrow(/Git is not installed on the server/);
    expect(existsSync(dest)).toBe(false);
  });

  it('reports what git said, without credentials, and leaves nothing behind', async () => {
    const git = await fakeGit(
      `if (args.includes('fetch')) { console.error("fatal: unable to access 'https://bob:hunter2@example.org/o/r.git/': not found"); process.exit(128); }`,
    );
    const dest = join(await temp(), 'bundle');
    const fetched = fetchGit({ url: 'https://bob:hunter2@example.org/o/r.git' }, dest, {
      timeoutMs: 20_000,
      ...git,
    });
    await expect(fetched).rejects.toThrow(/Git could not fetch .*\*\*\*@example\.org.*not found/s);
    await expect(fetched).rejects.not.toThrow(/hunter2/);
    expect(existsSync(dest)).toBe(false);
  });

  it('gives up after the timeout and leaves nothing behind', async () => {
    const git = await fakeGit(
      `if (args.includes('fetch')) await new Promise((done) => setTimeout(done, 90_000));`,
    );
    const dest = join(await temp(), 'bundle');
    const started = Date.now();
    const fetched = fetchGit({ url: 'https://example.org/o/r.git' }, dest, {
      timeoutMs: 1500,
      ...git,
    });
    await expect(fetched).rejects.toThrow(/did not finish within/);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(existsSync(dest)).toBe(false);
  });
});

describe('fetchGit, when the server shuts down', () => {
  it('ends git and leaves nothing behind', async () => {
    const git = await fakeGit(
      `if (args.includes('fetch')) await new Promise((done) => setTimeout(done, 90_000));`,
    );
    const dest = join(await temp(), 'bundle');
    const stop = new AbortController();
    const started = Date.now();
    const fetched = fetchGit({ url: 'https://example.org/o/r.git' }, dest, {
      timeoutMs: 60_000,
      signal: stop.signal,
      ...git,
    });
    setTimeout(() => stop.abort(), 300);
    await expect(fetched).rejects.toThrow(/shutting down/);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(existsSync(dest)).toBe(false);
  }, 15_000);
});

describe.skipIf(!hasGit)('fetchGit, with real git and a local repository', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.org',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd, windowsHide: true, encoding: 'utf8' },
    ).trim();

  /** A repository with two commits: `v1` tagged at the first, `main` at the second. */
  async function repository() {
    const dir = join(await temp(), 'repo');
    await mkdir(join(dir, 'dashboard'), { recursive: true });
    git(dir, 'init', '--quiet', '--initial-branch=main');
    git(dir, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    await writeFile(join(dir, 'mooncg.json'), '{"version":"1.0.0"}');
    await writeFile(join(dir, 'dashboard', 'panel.html'), 'one');
    git(dir, 'add', '.');
    git(dir, 'commit', '--quiet', '-m', 'one');
    git(dir, 'tag', 'v1');
    const first = git(dir, 'rev-parse', 'HEAD');
    await writeFile(join(dir, 'mooncg.json'), '{"version":"2.0.0"}');
    git(dir, 'commit', '--quiet', '-am', 'two');
    return { url: pathToFileURL(dir).href, first, second: git(dir, 'rev-parse', 'HEAD') };
  }
  const options = { timeoutMs: 60_000, allowFileUrls: true };

  it('checks out the default branch, records the commit and keeps no .git', async () => {
    const { url, second } = await repository();
    const dest = join(await temp(), 'bundle');

    const result = await fetchGit({ url }, dest, options);

    expect(result).toEqual({ commit: second });
    expect(await readFile(join(dest, 'mooncg.json'), 'utf8')).toBe('{"version":"2.0.0"}');
    expect(await readFile(join(dest, 'dashboard', 'panel.html'), 'utf8')).toBe('one');
    expect((await readdir(dest)).sort()).toEqual(['dashboard', 'mooncg.json']);
  });

  it('checks out a tag, a branch or a commit', async () => {
    const { url, first, second } = await repository();
    const tagged = join(await temp(), 'tag');
    expect(await fetchGit({ url, ref: 'v1' }, tagged, options)).toEqual({ commit: first });
    expect(await readFile(join(tagged, 'mooncg.json'), 'utf8')).toBe('{"version":"1.0.0"}');
    const branch = join(await temp(), 'branch');
    expect(await fetchGit({ url, ref: 'main' }, branch, options)).toEqual({ commit: second });
    const commit = join(await temp(), 'commit');
    expect(await fetchGit({ url, ref: first }, commit, options)).toEqual({ commit: first });
  });

  it('says what is wrong with a ref that does not exist', async () => {
    const { url } = await repository();
    const dest = join(await temp(), 'bundle');
    await expect(fetchGit({ url, ref: 'no-such-branch' }, dest, options)).rejects.toThrow(
      /Git could not fetch/,
    );
    expect(existsSync(dest)).toBe(false);
  });

  it('is refused the same repository where file URLs were not allowed', async () => {
    const { url } = await repository();
    const dest = join(await temp(), 'bundle');
    await expect(fetchGit({ url }, dest, { timeoutMs: 60_000 })).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(existsSync(dest)).toBe(false);
  });

  it('is refused by git itself when only the check of the address were skipped', async () => {
    // The second lock: git is told which protocols it may use, whatever it is handed.
    const { url } = await repository();
    const dest = join(await temp(), 'bundle');
    const result = spawnSync('git', ['clone', '--depth=1', '--', url, dest], {
      windowsHide: true,
      encoding: 'utf8',
      env: { ...process.env, GIT_ALLOW_PROTOCOL: 'https:ssh', GIT_TERMINAL_PROMPT: '0' },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not allowed|not supported/);
  });
});
