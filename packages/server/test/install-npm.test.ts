import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNpmInstall, findNpmCli, npmArguments, npmNeed } from '../src/install/npm.js';

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function temp(files: Readonly<Record<string, string | object>> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mooncg-npm-'));
  made.push(dir);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(
      join(dir, path),
      typeof content === 'string' ? content : JSON.stringify(content),
    );
  }
  return dir;
}

describe('npmArguments', () => {
  it('installs exactly what the lockfile says, without development packages or scripts', () => {
    expect(npmArguments({ lockfile: true, scripts: false })).toEqual([
      'ci',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ]);
  });

  it('resolves the dependencies when there is no lockfile', () => {
    expect(npmArguments({ lockfile: false, scripts: false })).toEqual([
      'install',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ]);
  });

  it('lets scripts run only when that was asked for', () => {
    expect(npmArguments({ lockfile: true, scripts: true })).not.toContain('--ignore-scripts');
    expect(npmArguments({ lockfile: false, scripts: true })).not.toContain('--ignore-scripts');
    expect(npmArguments({ lockfile: true, scripts: true })).toContain('--omit=dev');
  });
});

describe('findNpmCli', () => {
  it('finds the npm that comes with Node on Windows', () => {
    const exec = 'C:\\Program Files\\nodejs\\node.exe';
    const cli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
    expect(findNpmCli(exec, (path) => path === cli, win32)).toBe(cli);
  });

  it('finds the npm that comes with Node elsewhere', () => {
    const cli = '/usr/local/lib/node_modules/npm/bin/npm-cli.js';
    expect(
      findNpmCli('/usr/local/bin/node', (path) => path.replaceAll('\\', '/').endsWith(cli)),
    ).toMatch(/lib[\\/]node_modules[\\/]npm[\\/]bin[\\/]npm-cli\.js$/);
  });

  it('is undefined when there is no npm beside Node', () => {
    expect(findNpmCli('/opt/node/bin/node', () => false)).toBeUndefined();
  });

  it('finds the npm of the Node these tests run on', () => {
    expect(findNpmCli()).toMatch(/npm-cli\.js$/);
  });
});

describe('npmNeed', () => {
  it('needs nothing without a package.json or without dependencies', async () => {
    const none = {
      needed: false,
      lockfile: false,
      dependencies: [],
      installed: false,
      config: [],
      unusual: [],
    };
    expect(await npmNeed(await temp())).toEqual(none);
    expect(await npmNeed(await temp({ 'package.json': { name: 'x' } }))).toEqual(none);
    expect(
      await npmNeed(await temp({ 'package.json': { devDependencies: { vitest: '^5' } } })),
    ).toEqual(none);
  });

  it('needs an installation for dependencies that are not there yet', async () => {
    const dir = await temp({
      'package.json': { dependencies: { 'obs-websocket-js': '^5.0.0', zod: '^4' } },
    });
    expect(await npmNeed(dir)).toMatchObject({
      needed: true,
      lockfile: false,
      dependencies: ['obs-websocket-js', 'zod'],
      installed: false,
    });
  });

  it('counts optional dependencies and sees a lockfile', async () => {
    const dir = await temp({
      'package.json': { optionalDependencies: { sharp: '*' } },
      'package-lock.json': {},
    });
    expect(await npmNeed(dir)).toMatchObject({
      needed: true,
      lockfile: true,
      dependencies: ['sharp'],
    });
    const shrinkwrap = await temp({
      'package.json': { dependencies: { a: '1' } },
      'npm-shrinkwrap.json': {},
    });
    expect(await npmNeed(shrinkwrap)).toMatchObject({ lockfile: true });
  });

  it('needs nothing when the bundle brought its node_modules', async () => {
    const dir = await temp({
      'package.json': { dependencies: { zod: '^4' } },
      'node_modules/zod/package.json': {},
    });
    expect(await npmNeed(dir)).toMatchObject({
      needed: false,
      lockfile: false,
      dependencies: ['zod'],
      installed: true,
    });
  });

  it('refuses a package.json that cannot be read as one', async () => {
    await expect(npmNeed(await temp({ 'package.json': '{ not json' }))).rejects.toThrow(
      /package.json is not valid JSON/,
    );
    await expect(npmNeed(await temp({ 'package.json': '[]' }))).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(
      npmNeed(await temp({ 'package.json': { dependencies: ['zod'] } })),
    ).rejects.toThrow(/dependencies/);
  });
});

/** A stand-in for npm's command line: notes how it was called and answers as told. */
async function fakeNpm(behaviour = '') {
  const dir = await temp();
  const script = join(dir, 'fake-npm-cli.mjs');
  const record = join(dir, 'call.json');
  await writeFile(
    script,
    `import { writeFileSync } from 'node:fs';
const npmEnv = Object.keys(process.env).filter((key) => /^npm_/i.test(key));
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), npmEnv }));
console.log('added 3 packages');
console.error('npm warn something');
${behaviour}
`,
  );
  const call = async () =>
    JSON.parse(await readFile(record, 'utf8')) as { args: string[]; cwd: string; npmEnv: string[] };
  return { install: createNpmInstall({ npmCli: script, home: join(dir, 'home') }), call };
}

describe('createNpmInstall', () => {
  it('runs npm in the folder, without a shell, and hands on what it prints', async () => {
    const npm = await fakeNpm();
    // A folder name a shell would take apart.
    const dir = join(await temp(), 'a b & c;d');
    await mkdir(dir);
    const lines: string[] = [];

    await npm.install({
      dir,
      lockfile: true,
      scripts: false,
      timeoutMs: 20_000,
      log: (line) => lines.push(line),
    });

    const call = await npm.call();
    expect(call.args.slice(0, 5)).toEqual([
      'ci',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ]);
    expect(call.cwd.toLowerCase()).toBe(dir.toLowerCase());
    expect(lines).toEqual(expect.arrayContaining(['added 3 packages', 'npm warn something']));
  });

  it('does not pass the settings of the package manager the server was started with', async () => {
    const npm = await fakeNpm();
    process.env.npm_config_registry = 'https://registry.example.invalid/';
    try {
      await npm.install({
        dir: await temp(),
        lockfile: false,
        scripts: false,
        timeoutMs: 20_000,
        log: () => {},
      });
    } finally {
      delete process.env.npm_config_registry;
    }
    // Nothing but what the server itself sets.
    expect((await npm.call()).npmEnv.map((key) => key.toLowerCase())).toEqual(['npm_config_git']);
  });

  it('fails with what npm said when npm fails', async () => {
    const npm = await fakeNpm(`console.error('npm error 404 Not Found: nope@1'); process.exit(1);`);
    const installed = npm.install({
      dir: await temp(),
      lockfile: false,
      scripts: false,
      timeoutMs: 20_000,
      log: () => {},
    });
    await expect(installed).rejects.toThrow(/npm exited with code 1.*404 Not Found/s);
  });

  it('ends an installation that takes too long', async () => {
    const npm = await fakeNpm('await new Promise((done) => setTimeout(done, 90_000));');
    const started = Date.now();
    const installed = npm.install({
      dir: await temp(),
      lockfile: false,
      scripts: false,
      timeoutMs: 1500,
      log: () => {},
    });
    await expect(installed).rejects.toThrow(/did not finish within/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('ends npm when the server shuts down', async () => {
    const npm = await fakeNpm('await new Promise((done) => setTimeout(done, 90_000));');
    const stop = new AbortController();
    const started = Date.now();
    const installed = npm.install({
      dir: await temp(),
      lockfile: false,
      scripts: false,
      timeoutMs: 60_000,
      signal: stop.signal,
      log: () => {},
    });
    setTimeout(() => stop.abort(), 300);
    await expect(installed).rejects.toThrow(/shutting down/);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);

  it('says so when npm cannot be found', async () => {
    const install = createNpmInstall({
      npmCli: join(await temp(), 'no-such-npm-cli.js'),
      home: join(await temp(), 'home'),
    });
    const installed = install({
      dir: await temp(),
      lockfile: false,
      scripts: false,
      timeoutMs: 20_000,
      log: () => {},
    });
    await expect(installed).rejects.toThrow(/npm/);
  });
});
