import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fetchGit,
  gitHostOf,
  gitRefProblem,
  gitUrlProblem,
  gitVersionOf,
  withoutCredentials,
} from '../src/install/git.js';
import { privateNetworks } from '../src/registry/network.js';

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
/** A resolver for tests: every name is a public address, so nothing is asked of real DNS. */
const resolvesTo =
  (...addresses: string[]) =>
  async (_hostname: string) =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
const PUBLIC = resolvesTo('93.184.215.14');

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
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(GIT_|GCM_)|_PROXY$/i.test(key)));
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, env }) + '\\n');
${behaviour}
if (args.includes('--version')) { console.log('git version 2.52.0.windows.1'); process.exit(0); }
if (args.includes('--get-url')) { console.log(args.at(-1)); process.exit(0); }
if (args.includes('--get-urlmatch')) process.exit(1);
if (args.includes('init')) mkdirSync(args.at(-1) + '/.git', { recursive: true });
if (args.includes('rev-parse')) console.log('${'a'.repeat(40)}');
`,
  );
  const calls = async () =>
    (await readFile(log, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { args: string[]; env: Record<string, string> });
  return { command: [process.execPath, script], calls, resolve: PUBLIC };
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
      resolve: PUBLIC,
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

describe('gitHostOf', () => {
  it.each([
    ['https://example.org/o/r.git', { host: 'example.org', port: 443, https: true }],
    ['https://user:t@Example.org:8443/o/r', { host: 'example.org', port: 8443, https: true }],
    ['https://[2001:db8::1]/o/r.git', { host: '2001:db8::1', port: 443, https: true }],
    ['ssh://git@example.org:2222/o/r.git', { host: 'example.org', port: 2222, https: false }],
    ['ssh://example.org/o/r.git', { host: 'example.org', port: 22, https: false }],
    ['git@example.org:o/r.git', { host: 'example.org', port: 22, https: false }],
  ])('reads %s', (url, expected) => {
    expect(gitHostOf(url)).toEqual(expected);
  });
});

describe('fetchGit, where it may connect', () => {
  const fetchArgs = async (git: Awaited<ReturnType<typeof fakeGit>>) =>
    (await git.calls()).find(({ args }) => args.includes('fetch'))?.args ?? [];

  it('pins git to the address it checked, and follows no redirect to another', async () => {
    const git = await fakeGit();
    await fetchGit({ url: 'https://example.org/o/r.git' }, join(await temp(), 'b'), {
      timeoutMs: 20_000,
      ...git,
    });
    const args = await fetchArgs(git);
    expect(args).toContain('http.curloptResolve=example.org:443:93.184.215.14');
    expect(args).toContain('http.followRedirects=false');
    // Every call is pinned, the fetch included, before its subcommand.
    expect(args.indexOf('http.curloptResolve=example.org:443:93.184.215.14')).toBeLessThan(
      args.indexOf('fetch'),
    );
  });

  it('pins every address of a name, IPv6 in brackets, on the port of the address', async () => {
    const git = await fakeGit();
    await fetchGit({ url: 'https://example.org:8443/o/r.git' }, join(await temp(), 'b'), {
      timeoutMs: 20_000,
      ...git,
      resolve: resolvesTo('93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c'),
    });
    expect(await fetchArgs(git)).toContain(
      'http.curloptResolve=example.org:8443:93.184.215.14,[2606:2800:21f:cb07:6820:80da:af6b:8b2c]',
    );
  });

  it.each([
    ['https://internal.example/o/r.git', resolvesTo('10.1.2.3'), /10\.1\.2\.3/],
    ['https://meta.example/o/r.git', resolvesTo('169.254.169.254'), /169\.254/],
    ['https://mixed.example/o/r.git', resolvesTo('93.184.215.14', '192.168.0.4'), /192\.168/],
    ['https://localhost/o/r.git', resolvesTo('127.0.0.1'), /this machine/],
    ['ssh://git@internal.example/o/r.git', resolvesTo('10.1.2.3'), /10\.1\.2\.3/],
    ['git@internal.example:o/r.git', resolvesTo('fd00::1'), /fd00::1/],
    ['https://10.0.0.1/o/r.git', PUBLIC, /10\.0\.0\.1/],
    ['https://[fe80::1]/o/r.git', PUBLIC, /fe80::1/],
    ['https://127.0.0.1/o/r.git', PUBLIC, /this machine/],
  ])('refuses %s before git is run at all', async (url, resolve, reason) => {
    const git = await fakeGit();
    const dest = join(await temp(), 'bundle');
    const fetched = fetchGit({ url }, dest, { timeoutMs: 20_000, ...git, resolve });
    await expect(fetched).rejects.toMatchObject({ code: 'invalid' });
    await expect(fetched).rejects.toThrow(reason);
    expect(await git.calls()).toEqual([]);
    expect(existsSync(dest)).toBe(false);
  });

  it('keeps the pin where Git for Windows cannot combine it with the TLS backend configured', async () => {
    // Git for Windows with `http.sslBackend=openssl` refuses that backend once a pin is set,
    // and names the one its libcurl has: the fetch is run again, pinned, with that one.
    const git = await fakeGit(
      `if (args.includes('fetch') && !args.includes('http.sslBackend=schannel')) { console.error("fatal: Unsupported SSL backend 'openssl'. Supported SSL backends:\\n\\tschannel"); console.error("fatal: remote helper 'https' aborted session"); process.exit(128); }`,
    );
    await fetchGit({ url: 'https://example.org/o/r.git' }, join(await temp(), 'b'), {
      timeoutMs: 20_000,
      ...git,
    });
    const fetches = (await git.calls()).filter(({ args }) => args.includes('fetch'));
    expect(fetches).toHaveLength(2);
    expect(fetches[1]?.args).toContain('http.sslBackend=schannel');
    expect(fetches[1]?.args).toContain('http.curloptResolve=example.org:443:93.184.215.14');
  });

  it('checks an ssh address, which ssh resolves itself, without pinning it', async () => {
    const git = await fakeGit();
    await fetchGit({ url: 'git@example.org:o/r.git' }, join(await temp(), 'b'), {
      timeoutMs: 20_000,
      ...git,
    });
    expect((await fetchArgs(git)).some((arg) => arg.startsWith('http.curloptResolve'))).toBe(false);
  });

  it('takes this machine where the reach allows it, as for an index on this machine', async () => {
    const git = await fakeGit();
    await fetchGit({ url: 'https://localhost:3000/o/r.git' }, join(await temp(), 'b'), {
      timeoutMs: 20_000,
      ...git,
      resolve: resolvesTo('127.0.0.1'),
      reach: { loopback: true },
    });
    expect(await fetchArgs(git)).toContain('http.curloptResolve=localhost:3000:127.0.0.1');
  });

  it('takes a host of a private network the configuration allows', async () => {
    const git = await fakeGit();
    const access = privateNetworks(['git.corp.example'], false);
    await fetchGit({ url: 'https://git.corp.example/o/r.git' }, join(await temp(), 'b'), {
      timeoutMs: 20_000,
      ...git,
      resolve: resolvesTo('10.8.0.2'),
      reach: { loopback: false, private: access },
    });
    expect(await fetchArgs(git)).toContain('http.curloptResolve=git.corp.example:443:10.8.0.2');
  });

  it('says so when a name cannot be resolved, before git is run', async () => {
    const git = await fakeGit();
    const fetched = fetchGit({ url: 'https://nowhere.example/o/r.git' }, join(await temp(), 'b'), {
      timeoutMs: 20_000,
      ...git,
      resolve: async () => {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND nowhere.example'), {
          code: 'ENOTFOUND',
        });
      },
    });
    await expect(fetched).rejects.toThrow(/nowhere\.example/);
    expect(await git.calls()).toEqual([]);
  });
});

describe('gitVersionOf', () => {
  it.each([
    ['git version 2.52.0.windows.1', [2, 52]],
    ['git version 2.39.5 (Apple Git-154)', [2, 39]],
    ['git version 2.37.0.rc1\n', [2, 37]],
    ['git version 3.0.0', [3, 0]],
  ])('reads "%s"', (text, expected) => {
    expect(gitVersionOf(text)).toEqual(expected);
  });

  it.each(['', 'hub version 2.14.2', 'git version two'])('reads nothing of "%s"', (text) => {
    expect(gitVersionOf(text)).toBeUndefined();
  });
});

describe('fetchGit, where the pin would not hold', () => {
  const fetches = async (git: Awaited<ReturnType<typeof fakeGit>>) =>
    (await git.calls()).filter(({ args }) => args.includes('fetch'));

  it('refuses an https address when git is older than 2.37, which ignores the pin', async () => {
    const git = await fakeGit(
      `if (args.includes('--version')) { console.log('git version 2.36.6'); process.exit(0); }`,
    );
    const dest = join(await temp(), 'bundle');
    const fetched = fetchGit({ url: 'https://example.org/o/r.git' }, dest, {
      timeoutMs: 20_000,
      ...git,
    });
    await expect(fetched).rejects.toThrow(/Git 2\.36 .*2\.37 or newer/);
    expect(await fetches(git)).toEqual([]);
    expect(existsSync(dest)).toBe(false);
  });

  it('refuses an https address when git does not say its version', async () => {
    const git = await fakeGit(`if (args.includes('--version')) process.exit(0);`);
    const fetched = fetchGit({ url: 'https://example.org/o/r.git' }, join(await temp(), 'b'), {
      timeoutMs: 20_000,
      ...git,
    });
    await expect(fetched).rejects.toThrow(/version/);
    expect(await fetches(git)).toEqual([]);
  });

  it('takes an ssh address with an older git, which is checked and never pinned', async () => {
    const git = await fakeGit(
      `if (args.includes('--version')) { console.log('git version 2.30.1'); process.exit(0); }`,
    );
    await fetchGit({ url: 'git@example.org:o/r.git' }, join(await temp(), 'b'), {
      timeoutMs: 20_000,
      ...git,
    });
    expect(await fetches(git)).toHaveLength(1);
  });

  it('asks git for its version once', async () => {
    const git = await fakeGit();
    for (const name of ['a', 'b']) {
      await fetchGit({ url: 'https://example.org/o/r.git' }, join(await temp(), name), {
        timeoutMs: 20_000,
        ...git,
      });
    }
    const asked = (await git.calls()).filter(({ args }) => args.includes('--version'));
    expect(asked).toHaveLength(1);
  });

  it('starts git without the proxies and configuration of the environment', async () => {
    const git = await fakeGit();
    await fetchGit({ url: 'https://example.org/o/r.git' }, join(await temp(), 'b'), {
      timeoutMs: 20_000,
      ...git,
      env: {
        PATH: process.env.PATH,
        HTTPS_PROXY: 'http://proxy.example:3128',
        http_proxy: 'http://proxy.example:3128',
        ALL_PROXY: 'socks5://proxy.example',
        No_Proxy: 'example.org',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'url.https://10.0.0.1/.insteadOf',
        GIT_CONFIG_VALUE_0: 'https://example.org/',
        GIT_CONFIG_PARAMETERS: "'http.proxy'='http://proxy.example:3128'",
        GIT_SSL_NO_VERIFY: '1',
        GIT_PROXY_COMMAND: 'touch pwned',
        GIT_DIR: '/srv/elsewhere.git',
        GIT_WORK_TREE: '/srv/elsewhere',
      },
    });
    const calls = await git.calls();
    expect(calls.length).toBeGreaterThan(0);
    for (const { env } of calls) {
      expect(Object.keys(env).filter((key) => /proxy$/i.test(key))).toEqual([]);
      for (const name of [
        'GIT_CONFIG_COUNT',
        'GIT_CONFIG_KEY_0',
        'GIT_CONFIG_VALUE_0',
        'GIT_CONFIG_PARAMETERS',
        'GIT_SSL_NO_VERIFY',
        'GIT_PROXY_COMMAND',
        'GIT_DIR',
        'GIT_WORK_TREE',
      ]) {
        expect(env[name]).toBeUndefined();
      }
    }
    const [fetch] = await fetches(git);
    const args = fetch?.args ?? [];
    // No proxy of the configuration, and no address of it for the host: only the one checked.
    expect(args).toContain('http.proxy=');
    expect(args.indexOf('http.curloptResolve=')).toBeGreaterThan(-1);
    expect(args.indexOf('http.curloptResolve=')).toBeLessThan(
      args.indexOf('http.curloptResolve=example.org:443:93.184.215.14'),
    );
  });

  it('checks where a url.*.insteadOf rewrite of the configuration leads', async () => {
    const git = await fakeGit(
      `if (args.includes('--get-url')) { console.log('https://internal.example/o/r.git'); process.exit(0); }`,
    );
    const dest = join(await temp(), 'bundle');
    const fetched = fetchGit({ url: 'https://example.org/o/r.git' }, dest, {
      timeoutMs: 20_000,
      ...git,
      resolve: async (host: string) =>
        host === 'internal.example'
          ? [{ address: '10.1.2.3', family: 4 }]
          : [{ address: '93.184.215.14', family: 4 }],
    });
    await expect(fetched).rejects.toMatchObject({ code: 'invalid' });
    await expect(fetched).rejects.toThrow(/internal\.example.*10\.1\.2\.3/s);
    expect(await fetches(git)).toEqual([]);
    expect(existsSync(dest)).toBe(false);
    // Asked in the new repository, so that what git reads there is what the fetch reads.
    const asked = (await git.calls()).find(({ args }) => args.includes('--get-url'))?.args ?? [];
    expect(asked[asked.indexOf('-C') + 1]).toBe(dest);
  });

  it('pins git to where a rewrite leads, when that is allowed', async () => {
    const git = await fakeGit(
      `if (args.includes('--get-url')) { console.log('https://mirror.example:8443/o/r.git'); process.exit(0); }`,
    );
    await fetchGit({ url: 'https://example.org/o/r.git' }, join(await temp(), 'b'), {
      timeoutMs: 20_000,
      ...git,
      resolve: resolvesTo('93.184.215.20'),
    });
    const args = (await fetches(git))[0]?.args ?? [];
    expect(args).toContain('http.curloptResolve=mirror.example:8443:93.184.215.20');
    expect(args.some((arg) => arg.startsWith('http.curloptResolve=example.org'))).toBe(false);
  });

  it('refuses a rewrite to an address that is not accepted', async () => {
    const git = await fakeGit(
      `if (args.includes('--get-url')) { console.log('http://mirror.example/o/r.git'); process.exit(0); }`,
    );
    const fetched = fetchGit({ url: 'git@example.org:o/r.git' }, join(await temp(), 'b'), {
      timeoutMs: 20_000,
      ...git,
    });
    await expect(fetched).rejects.toMatchObject({ code: 'invalid' });
    expect(await fetches(git)).toEqual([]);
  });

  it('refuses an address the configuration sends through a proxy', async () => {
    const git = await fakeGit(
      `if (args.includes('--get-urlmatch')) { console.log('http://proxy.example:3128'); process.exit(0); }`,
    );
    const fetched = fetchGit({ url: 'https://example.org/o/r.git' }, join(await temp(), 'b'), {
      timeoutMs: 20_000,
      ...git,
    });
    await expect(fetched).rejects.toThrow(/proxy/);
    expect(await fetches(git)).toEqual([]);
  });

  it('says a repository that redirects must be given by its new address', async () => {
    const git = await fakeGit(
      `if (args.includes('fetch')) { console.error("fatal: unable to access 'https://example.org/o/r.git/': The requested URL returned error: 301"); process.exit(128); }`,
    );
    const fetched = fetchGit({ url: 'https://example.org/o/r.git' }, join(await temp(), 'b'), {
      timeoutMs: 20_000,
      ...git,
    });
    await expect(fetched).rejects.toThrow(
      /answered with a redirect \(HTTP 301\); give its new address/,
    );
  });

  it('switches the TLS backend only for what git itself says, and only when it failed', async () => {
    const unsupported = "Unsupported SSL backend 'openssl'. Supported SSL backends:\\n\\tschannel";
    // The server's own words, passed on by git, change nothing.
    const remote = await fakeGit(
      `if (args.includes('fetch')) { console.error("remote: fatal: ${unsupported}"); process.exit(128); }`,
    );
    await expect(
      fetchGit({ url: 'https://example.org/o/r.git' }, join(await temp(), 'b'), {
        timeoutMs: 20_000,
        ...remote,
      }),
    ).rejects.toThrow(/Git could not fetch/);
    expect(await fetches(remote)).toHaveLength(1);
    // A fetch that went well is not run again, whatever it printed.
    const fine = await fakeGit(
      `if (args.includes('fetch')) { console.error("error: ${unsupported}"); process.exit(0); }`,
    );
    await fetchGit({ url: 'https://example.org/o/r.git' }, join(await temp(), 'c'), {
      timeoutMs: 20_000,
      ...fine,
    });
    expect(await fetches(fine)).toHaveLength(1);
  });
});

describe('fetchGit, while a name is resolved', () => {
  const never = () => new Promise<never>(() => {});

  it('gives up when the time of the stage is up', async () => {
    const git = await fakeGit();
    const dest = join(await temp(), 'bundle');
    const started = Date.now();
    const fetched = fetchGit({ url: 'https://example.org/o/r.git' }, dest, {
      timeoutMs: 300,
      ...git,
      resolve: never,
    });
    await expect(fetched).rejects.toMatchObject({ code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await git.calls()).toEqual([]);
    expect(existsSync(dest)).toBe(false);
  });

  it('gives up when the server shuts down', async () => {
    const git = await fakeGit();
    const stop = new AbortController();
    const fetched = fetchGit({ url: 'https://example.org/o/r.git' }, join(await temp(), 'b'), {
      timeoutMs: 60_000,
      ...git,
      resolve: never,
      signal: stop.signal,
    });
    setTimeout(() => stop.abort(), 100);
    await expect(fetched).rejects.toThrow(/shutting down/);
    expect(await git.calls()).toEqual([]);
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
