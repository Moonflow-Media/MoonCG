import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_INSTALL_LIMITS,
  entryNameProblem,
  isInside,
  isNetworkPath,
  moveDir,
  storageProblem,
} from '../src/install/files.js';
import { fetchGit, withoutCredentials } from '../src/install/git.js';
import { copyLocalPath } from '../src/install/local.js';
import { createNpmInstall, npmArguments, npmNeed, unusualSpec } from '../src/install/npm.js';
import { runTool } from '../src/install/process.js';
import { archiveError } from '../src/install/zip.js';

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
async function temp(files: Readonly<Record<string, string | object>> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mooncg-review-'));
  made.push(dir);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(
      join(dir, path),
      typeof content === 'string' ? content : JSON.stringify(content),
    );
  }
  return dir;
}
const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const errno = (code: string, path = '') =>
  Object.assign(new Error(`${code}: something failed, open '${path}'`), { code, path });

/**
 * A tool that starts a child of its own and then hangs. The child notes its process id and
 * ends by itself after a while, so that nothing is left even if a test fails.
 */
async function toolWithChild() {
  const dir = await temp();
  const pidFile = join(dir, 'child.pid');
  const script = join(dir, 'tool.mjs');
  await writeFile(
    script,
    `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 25000)'], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
console.log('started');
await new Promise((done) => setTimeout(done, 25000));
`,
  );
  const childPid = async () => {
    for (let tries = 0; tries < 100 && !existsSync(pidFile); tries++) {
      await new Promise((done) => setTimeout(done, 50));
    }
    return Number(await readFile(pidFile, 'utf8'));
  };
  /** Whether the child is gone, given a moment for the system to take it away. */
  const gone = async () => {
    const pid = await childPid();
    for (let tries = 0; tries < 60 && alive(pid); tries++) {
      await new Promise((done) => setTimeout(done, 50));
    }
    return !alive(pid);
  };
  return { script, gone };
}

describe('runTool', () => {
  it('ends the tool and everything the tool started when the time is up', async () => {
    const { script, gone } = await toolWithChild();
    const started = Date.now();
    const result = await runTool(process.execPath, [script], { env: process.env, timeoutMs: 1500 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await gone()).toBe(true);
  }, 30_000);

  it('ends the whole tree when told to stop', async () => {
    const { script, gone } = await toolWithChild();
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 1000);
    const result = await runTool(process.execPath, [script], {
      env: process.env,
      timeoutMs: 60_000,
      signal: stop.signal,
    });
    expect(result.aborted).toBe(true);
    expect(await gone()).toBe(true);
  }, 30_000);

  it('hands on what the tool printed and how it ended', async () => {
    const lines: string[] = [];
    const result = await runTool(
      process.execPath,
      ['-e', 'console.log("out one\\nout two"); console.error("err"); process.exit(3)'],
      { env: process.env, timeoutMs: 20_000, onLine: (line) => lines.push(line) },
    );
    expect(result).toMatchObject({ code: 3, timedOut: false, aborted: false });
    expect(result.stdout).toContain('out two');
    expect(result.stderr).toContain('err');
    expect(lines.sort()).toEqual(['err', 'out one', 'out two']);
  });

  it('rejects when the tool cannot be started', async () => {
    await expect(
      runTool('mooncg-test-no-such-tool', [], { env: process.env, timeoutMs: 5000 }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('npm, kept away from every configuration but its own', () => {
  const isolation = {
    userconfig: '/srv/npm/user',
    globalconfig: '/srv/npm/global',
    cache: '/srv/npm/cache',
  };

  it('names its own empty configuration files and its own cache', () => {
    expect(npmArguments({ lockfile: true, scripts: false }, isolation)).toEqual([
      'ci',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--userconfig=/srv/npm/user',
      '--globalconfig=/srv/npm/global',
      '--cache=/srv/npm/cache',
    ]);
    expect(
      npmArguments(
        { lockfile: false, scripts: true },
        { ...isolation, registry: 'https://npm.example.org/' },
      ),
    ).toContain('--registry=https://npm.example.org/');
  });

  it('runs npm with them, with plain git, and with no setting from the environment', async () => {
    const dir = await temp();
    const record = join(dir, 'call.json');
    const cli = join(dir, 'fake-npm-cli.mjs');
    await writeFile(
      cli,
      `import { writeFileSync } from 'node:fs';
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^npm_/i.test(key)));
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), env }));
`,
    );
    const home = join(dir, 'home');
    const before = { ...process.env };
    Object.assign(process.env, {
      NPM_CONFIG_REGISTRY: 'https://evil.example.invalid/',
      npm_config_git: 'C:\\evil\\g.exe',
      NPM_CONFIG_USERCONFIG: 'C:\\evil\\npmrc',
      Npm_Config_Script_Shell: 'evil',
    });
    try {
      await createNpmInstall({ npmCli: cli, home })({
        dir: await temp(),
        lockfile: false,
        scripts: false,
        timeoutMs: 20_000,
        log: () => {},
      });
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    }
    const call = JSON.parse(await readFile(record, 'utf8')) as {
      args: string[];
      env: Record<string, string>;
    };
    expect(
      Object.fromEntries(
        Object.entries(call.env).map(([key, value]) => [key.toLowerCase(), value]),
      ),
    ).toEqual({
      npm_config_git: 'git',
    });
    const value = (flag: string) =>
      call.args.find((arg) => arg.startsWith(`--${flag}=`))?.slice(flag.length + 3) ?? '';
    for (const flag of ['userconfig', 'globalconfig']) {
      expect(isInside(home, value(flag))).toBe(true);
      expect(await readFile(value(flag), 'utf8')).toBe('');
    }
    expect(isInside(home, value('cache'))).toBe(true);
  });

  it('takes credentials out of what npm printed, in the log and in the error', async () => {
    const dir = await temp();
    const cli = join(dir, 'fake-npm-cli.mjs');
    await writeFile(
      cli,
      `console.error('npm error 404 https://bob:hunter2@npm.example.org/nope?authToken=s3cr3t-value'); process.exit(1);`,
    );
    const lines: string[] = [];
    const installed = createNpmInstall({ npmCli: cli, home: join(dir, 'home') })({
      dir: await temp(),
      lockfile: false,
      scripts: false,
      timeoutMs: 20_000,
      log: (line) => lines.push(line),
    });
    await expect(installed).rejects.toThrow(/npm exited with code 1/);
    const said = `${lines.join('\n')}\n${await installed.catch((error: Error) => error.message)}`;
    expect(said).toContain('npm.example.org/nope');
    expect(said).not.toMatch(/hunter2|s3cr3t-value|authToken/);
  });
});

describe('unusualSpec', () => {
  it.each([
    '^1.2.3',
    '1.2.3',
    '>=1 <3',
    '*',
    '',
    'latest',
    'next',
    '1.x',
    '~0.4',
    'npm:left-pad@^1.3.0',
    'npm:@scope/pkg@2',
  ])('takes "%s" for a version of a package of the registry', (spec) => {
    expect(unusualSpec(spec)).toBe(false);
  });

  it.each([
    'git+ssh://git@example.org/o/r.git',
    'git+https://example.org/o/r.git#v1',
    'git://example.org/o/r.git',
    'https://example.org/pkg.tgz',
    'http://example.org/pkg.tgz',
    'file:../elsewhere',
    'link:../elsewhere',
    './local',
    '../local',
    '/abs/local.tgz',
    'owner/repo',
    'owner/repo#semver:^1',
    'github:owner/repo',
    'gitlab:owner/repo',
    'bitbucket:owner/repo',
    'gist:1234',
    'workspace:*',
    'npm:left-pad@git+ssh://git@example.org/o/r.git',
    'npm:x@https://example.org/x.tgz',
    'user@host:path',
  ])('takes "%s" for something npm fetches from elsewhere', (spec) => {
    expect(unusualSpec(spec)).toBe(true);
  });

  it('takes what is no text for unusual', () => {
    expect(unusualSpec({ version: '1' })).toBe(true);
    expect(unusualSpec(undefined)).toBe(true);
  });
});

describe('npmNeed', () => {
  it('reports the files that steer npm or yarn', async () => {
    const dir = await temp({
      'package.json': { dependencies: { a: '^1' } },
      '.npmrc': 'git=./tools/g.exe',
      '.yarnrc.yml': 'x: y',
      '.yarnrc': 'x y',
      'sub/.npmrc': 'ignored: npm reads the one at the top',
    });
    expect((await npmNeed(dir)).config).toEqual(['.npmrc', '.yarnrc', '.yarnrc.yml']);
    expect(
      (await npmNeed(await temp({ 'package.json': { dependencies: { a: '^1' } } }))).config,
    ).toEqual([]);
  });

  it('reports every dependency that is not a version of a registry package', async () => {
    const dir = await temp({
      'package.json': {
        dependencies: { fine: '^1.0.0', repo: 'git+ssh://git@example.org/o/r.git' },
        optionalDependencies: { tarball: 'https://user:pw@example.org/x.tgz' },
        devDependencies: { local: 'file:../x' },
        peerDependencies: { short: 'owner/repo' },
        overrides: { fine: { deep: 'github:o/r' }, plain: '1.2.3' },
      },
    });
    expect((await npmNeed(dir)).unusual).toEqual([
      'dependencies.repo: git+ssh://***@example.org/o/r.git',
      'optionalDependencies.tarball: https://***@example.org/x.tgz',
      'devDependencies.local: file:../x',
      'peerDependencies.short: owner/repo',
      'overrides.fine.deep: github:o/r',
    ]);
  });

  it('reports what a lockfile would fetch from elsewhere than the registry', async () => {
    const lock = {
      lockfileVersion: 3,
      packages: {
        '': { name: 'bundle' },
        'node_modules/fine': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/fine/-/fine-1.0.0.tgz',
        },
        'node_modules/other': { version: '1.0.0', resolved: 'https://evil.example.org/other.tgz' },
        'node_modules/repo': { resolved: 'git+ssh://git@example.org/o/r.git#abc' },
        'node_modules/linked': { resolved: '../elsewhere', link: true },
        'node_modules/near': { resolved: 'https://registry.npmjs.org.evil.example/near.tgz' },
      },
    };
    const dir = await temp({
      'package.json': { dependencies: { fine: '^1' } },
      'package-lock.json': lock,
    });
    expect((await npmNeed(dir)).unusual).toEqual([
      'package-lock.json: node_modules/other comes from https://evil.example.org/other.tgz',
      'package-lock.json: node_modules/repo comes from git+ssh://***@example.org/o/r.git',
      'package-lock.json: node_modules/linked is a link',
      'package-lock.json: node_modules/near comes from https://registry.npmjs.org.evil.example/near.tgz',
    ]);
    // The registry the server was given is the one that counts.
    expect((await npmNeed(dir, 'https://evil.example.org/')).unusual).toContain(
      'package-lock.json: node_modules/fine comes from https://registry.npmjs.org/fine/-/fine-1.0.0.tgz',
    );
  });

  it('reads the older form of a lockfile too, and refuses one that is none', async () => {
    const old = {
      lockfileVersion: 1,
      dependencies: {
        fine: { version: '1.0.0', resolved: 'https://registry.npmjs.org/fine/-/fine-1.0.0.tgz' },
        repo: {
          version: 'git+https://example.org/o/r.git#abc',
          dependencies: { deep: { version: '1.0.0', resolved: 'http://plain.example.org/d.tgz' } },
        },
      },
    };
    const dir = await temp({
      'package.json': { dependencies: { fine: '^1' } },
      'npm-shrinkwrap.json': old,
    });
    expect((await npmNeed(dir)).unusual).toEqual([
      'npm-shrinkwrap.json: repo comes from git+https://example.org/o/r.git',
      'npm-shrinkwrap.json: deep comes from http://plain.example.org/d.tgz',
    ]);
    const broken = await temp({
      'package.json': { dependencies: { a: '1' } },
      'package-lock.json': '{ nope',
    });
    await expect(npmNeed(broken)).rejects.toThrow(/package-lock.json is not valid JSON/);
  });
});

describe('withoutCredentials', () => {
  it.each([
    ['https://user:p@ss:w@rd@example.org/o/r.git', 'https://***@example.org/o/r.git'],
    ['https://user:p%40ss%2Fword@example.org/o/r.git', 'https://***@example.org/o/r.git'],
    ['https://token@example.org/o/r.git', 'https://***@example.org/o/r.git'],
    ['https://example.org/o/r.git?token=s3cret&x=1', 'https://example.org/o/r.git'],
    ['https://example.org/o/r.git#access_token=s3cret', 'https://example.org/o/r.git'],
    [
      'https://u:p@example.org:8443/o/r.git?private_token=abc#frag',
      'https://***@example.org:8443/o/r.git',
    ],
    ['ssh://git:pw@example.org:22/o/r.git', 'ssh://***@example.org:22/o/r.git'],
    ['git+https://a:b@example.org/x.git#v1', 'git+https://***@example.org/x.git'],
    ['git@github.com:owner/repo.git', 'git@github.com:owner/repo.git'],
    ['https://example.org/plain', 'https://example.org/plain'],
  ])('shows "%s" as "%s"', (given, shown) => {
    expect(withoutCredentials(given)).toBe(shown);
  });

  it('does so for every address in a text and leaves the rest alone', () => {
    expect(
      withoutCredentials(
        "fatal: 'https://u:p@ss@a.example/x?t=1' and (https://b.example/y?k=2), done",
      ),
    ).toBe("fatal: 'https://***@a.example/x' and (https://b.example/y), done");
  });
});

describe('isInside', () => {
  const root = join(tmpdir(), 'root');
  it('takes a folder whose name starts with two dots as what it is', () => {
    expect(isInside(root, join(root, '..a', 'b'))).toBe(true);
    expect(isInside(root, join(root, '...'))).toBe(true);
    expect(isInside(root, join(root, '..'))).toBe(false);
    expect(isInside(root, join(root, '..', 'x'))).toBe(false);
    expect(isInside(root, join(root, 'a', '..', '..', 'x'))).toBe(false);
  });
});

describe('names of archive entries', () => {
  it.each(['COM¹', 'com².txt', 'x/LPT³', 'lpt¹.html', 'COM0', 'com0.log', 'LPT0'])(
    'refuses "%s", which Windows also takes for a device',
    (name) => {
      expect(entryNameProblem(name)).toContain('reserved');
    },
  );
  it('still takes names that only look alike', () => {
    for (const name of ['com10.txt', 'lpt', 'com', 'common¹/x', 'COM¹²']) {
      expect(entryNameProblem(name)).toBeUndefined();
    }
  });
});

describe('moveDir across volumes', () => {
  it('takes the copy away again when the original cannot be taken away', async () => {
    const root = await temp({ 'from/sub/file.txt': 'content' });
    const moved = moveDir(join(root, 'from'), join(root, 'to'), {
      // The other volume cannot be renamed to, and something holds the original.
      rename: async (_from, to) => {
        throw errno(to === join(root, 'to') ? 'EXDEV' : 'EBUSY');
      },
      wait: async () => {},
    });
    await expect(moved).rejects.toThrow(/in use|EBUSY/);
    // Nothing is in both places: the bundle is where it was, whole.
    expect((await readdir(root)).sort()).toEqual(['from']);
    expect(await readFile(join(root, 'from', 'sub', 'file.txt'), 'utf8')).toBe('content');
  });
});

describe('errors of the disk', () => {
  it.each(['ENOSPC', 'EPERM', 'EACCES', 'EROFS', 'EIO', 'EMFILE', 'EDQUOT'])(
    'reports %s as a problem of the server, without the path',
    (code) => {
      const error = archiveError(errno(code, 'C:\\Users\\someone\\data\\staging\\abc\\file.txt'));
      expect(error).toMatchObject({ code: 'internal' });
      expect(error.message).toMatch(/could not store/);
      expect(error.message).not.toMatch(/someone|staging|C:\\/);
      expect(storageProblem(errno(code))).toEqual(expect.any(String));
    },
  );

  it('reports what is wrong with an archive as that', () => {
    const error = archiveError(new Error('end of central directory record signature not found'));
    expect(error).toMatchObject({ code: 'invalid' });
    expect(error.message).toMatch(/not a usable ZIP archive/);
    expect(storageProblem(new Error('whatever'))).toBeUndefined();
  });

  it('takes the path of the server out of what an archive error says', () => {
    const error = archiveError(
      new Error("something odd at 'C:\\Users\\someone\\data\\staging\\abc\\x.zip'"),
    );
    expect(error.message).not.toMatch(/someone|staging\\abc/);
  });
});

describe('a folder as the source', () => {
  it.each([
    '\\\\server\\share\\bundle',
    '//server/share/bundle',
    '\\\\?\\C:\\bundle',
    '\\\\.\\C:\\bundle',
  ])('takes "%s" for a network or device path', (path) => {
    expect(isNetworkPath(path)).toBe(true);
  });

  it('takes ordinary paths for what they are', () => {
    for (const path of ['C:\\bundles\\x', '/srv/bundles/x', 'D:/x', '/a//b']) {
      expect(isNetworkPath(path)).toBe(false);
    }
  });

  it('refuses a network path before it looks at it', async () => {
    const dest = join(await temp(), 'dest');
    const copied = copyLocalPath('\\\\server\\share\\bundle', dest, {
      forbidden: [],
      limits: DEFAULT_INSTALL_LIMITS,
    });
    await expect(copied).rejects.toThrow(/network/);
    await expect(copied).rejects.toMatchObject({ code: 'invalid' });
  });

  it('knows a folder of the server under another spelling too, also one that is not there yet', async (context) => {
    // Where the temporary folder is written with a short name or through a link, the same
    // place has two spellings.
    const short = await temp({ 'source/mooncg.json': '{}', 'data/keep.txt': 'x' });
    const long = await realpath(short);
    if (short === long) return context.skip();
    // The staging folder below the data folder does not exist yet.
    const copied = copyLocalPath(long, join(short, 'dest'), {
      forbidden: [join(short, 'data', 'staging')],
      limits: DEFAULT_INSTALL_LIMITS,
    });
    await expect(copied).rejects.toThrow(/contains the bundles folder or the data folder/);
  });
});

describe.skipIf(!hasGit)('git, whatever the configuration of the machine says', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=T',
        '-c',
        'user.email=t@example.org',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd, windowsHide: true, encoding: 'utf8' },
    ).trim();
  const slashes = (path: string) => path.split(sep).join('/');

  /**
   * A repository whose `.gitattributes` asks for a filter, and a configuration of the machine
   * that defines this filter, a hook for every checkout and a file-system monitor. Each of
   * them would leave a marker if it ran.
   */
  async function hostile() {
    const root = await temp();
    const repo = join(root, 'repo');
    await mkdir(repo);
    git(repo, 'init', '--quiet', '--initial-branch=main');
    await writeFile(join(repo, 'mooncg.json'), '{"version":"1.0.0"}');
    await writeFile(join(repo, 'data.txt'), 'as committed');
    await writeFile(join(repo, '.gitattributes'), '*.txt filter=evil\n*.bin filter=lfs\n');
    await writeFile(join(repo, 'big.bin'), 'version https://git-lfs.github.com/spec/v1\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '--quiet', '-m', 'one');

    const marker = (name: string) => join(root, `${name}.ran`);
    const mark = join(root, 'mark.mjs');
    await writeFile(
      mark,
      `import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], 'ran');
process.stdin.on('data', () => {}).on('end', () => process.stdout.write('SMUDGED'));
`,
    );
    const hooks = join(root, 'hooks');
    await mkdir(hooks);
    const hook = join(hooks, 'post-checkout');
    await writeFile(hook, `#!/bin/sh\necho ran > "${slashes(marker('hook'))}"\n`);
    await chmod(hook, 0o755);
    const config = join(root, 'gitconfig');
    const set = (key: string, value: string) => git(root, 'config', '--file', config, key, value);
    const run = (name: string) => `node "${slashes(mark)}" "${slashes(marker(name))}"`;
    set('core.hooksPath', slashes(hooks));
    set('core.fsmonitor', run('fsmonitor'));
    set('filter.evil.smudge', run('smudge'));
    set('filter.evil.process', run('process'));
    set('filter.lfs.smudge', run('lfs-smudge'));
    set('filter.lfs.process', run('lfs-process'));
    set('filter.lfs.required', 'true');
    const env = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' };
    return { root, url: pathToFileURL(repo).href, env, marker };
  }

  it('runs no filter, no hook and no monitor, and checks the files out as they were committed', async () => {
    const { root, url, env, marker } = await hostile();
    const dest = join(root, 'bundle');

    await fetchGit({ url }, dest, { timeoutMs: 60_000, allowFileUrls: true, env });

    const ran = (await readdir(root)).filter((name) => name.endsWith('.ran'));
    expect(ran).toEqual([]);
    expect(existsSync(marker('hook'))).toBe(false);
    expect(await readFile(join(dest, 'data.txt'), 'utf8')).toBe('as committed');
    expect(await readFile(join(dest, 'big.bin'), 'utf8')).toContain('git-lfs');
    expect((await readdir(dest)).sort()).toEqual([
      '.gitattributes',
      'big.bin',
      'data.txt',
      'mooncg.json',
    ]);
  }, 60_000);
});

describe('git, while a repository is larger than a bundle may be', () => {
  it('stops the fetch as soon as the folder outgrows the limit', async () => {
    const dir = await temp();
    const script = join(dir, 'fat-git.mjs');
    await writeFile(
      script,
      `import { mkdirSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) console.log('git version 2.52.0');
if (args.includes('--get-url')) console.log(args.at(-1));
if (args.includes('--get-urlmatch')) process.exit(1);
if (args.includes('init')) mkdirSync(args.at(-1) + '/.git', { recursive: true });
if (args.includes('fetch')) {
  const dest = args[args.indexOf('-C') + 1];
  writeFileSync(dest + '/.git/pack.bin', Buffer.alloc(200_000));
  await new Promise((done) => setTimeout(done, 25000));
}
`,
    );
    const dest = join(await temp(), 'bundle');
    const started = Date.now();
    const fetched = fetchGit({ url: 'https://example.org/o/r.git' }, dest, {
      timeoutMs: 20_000,
      command: [process.execPath, script],
      resolve: async () => [{ address: '93.184.215.14', family: 4 }],
      maxBytes: 50_000,
      pollMs: 100,
    });
    await expect(fetched).rejects.toThrow(/larger than 50000 bytes/);
    await expect(fetched).rejects.toMatchObject({ code: 'invalid' });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(existsSync(dest)).toBe(false);
  }, 40_000);
});
