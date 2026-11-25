import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseManifest } from '@mooncg/core';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, readConfigFile } from '../../server/src/kernel/config.js';
import { PASSWORD, startAuthServer } from '../../server/test/auth-helpers.js';
import { temporaryBundles } from '../../server/test/temp-bundles.js';
import { type CliIo, run } from '../src/cli.js';
import { createBundle, TEMPLATES } from '../src/create-command.js';

const temporary = temporaryBundles();
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  await temporary.cleanup();
});

async function workspace(files: Record<string, string> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'mooncg-cli-dev-'));
  cleanup.push(() => rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(cwd, name, '..'), { recursive: true });
    await writeFile(join(cwd, name), text);
  }
  const out: string[] = [];
  const errors: string[] = [];
  const served: string[][] = [];
  const io: CliIo = {
    cwd,
    env: {},
    log: (line) => out.push(line),
    error: (line) => errors.push(line),
    serve: async (argv) => {
      served.push([...argv]);
    },
  };
  const mooncg = (...argv: string[]) => run(argv, io);
  return { cwd, out, errors, served, io, mooncg };
}

describe('mooncg start and mooncg dev', () => {
  it('starts the server with the flags as they were given', async () => {
    const { mooncg, served } = await workspace();

    expect(await mooncg('start', '--port', '8123', '--bundles-dir', 'examples', '--watch')).toBe(0);

    expect(served).toEqual([['--port', '8123', '--bundles-dir', 'examples', '--watch']]);
  });

  it('starts dev mode by adding --dev, and only then', async () => {
    const { mooncg, served } = await workspace();

    await mooncg('dev', '--port', '8123');
    await mooncg('start');

    expect(served).toEqual([['--dev', '--port', '8123'], []]);
  });

  it('says what went wrong when the server does not start', async () => {
    const { mooncg, errors, io } = await workspace();
    const failing: CliIo = {
      ...io,
      serve: async () => {
        throw new Error('Invalid port "x": expected a number from 0 to 65535');
      },
    };

    expect(await run(['start', '--port', 'x'], failing)).toBe(1);
    expect(errors.join('\n')).toContain('Invalid port "x"');
    expect(await mooncg('start')).toBe(0);
  });

  it('refuses dev mode on a host the network reaches, through the real configuration', async () => {
    const { errors, io } = await workspace();
    const { serve: _fake, ...real } = io;

    expect(await run(['dev', '--host', '0.0.0.0', '--port', '0'], real)).toBe(1);

    expect(errors.join('\n')).toMatch(/loopback/);
  });

  it('is in the usage text', async () => {
    const { mooncg, errors } = await workspace();
    await mooncg();
    const usage = errors.join('\n');
    for (const command of ['mooncg <command>', 'init', 'start', 'dev', 'bundle create']) {
      expect(usage).toContain(command);
    }
    expect(usage).toContain('--force');
  });
});

describe('mooncg init', () => {
  it('creates an installation folder the server can start in', async () => {
    const { mooncg, cwd, out } = await workspace();

    expect(await mooncg('init', 'studio')).toBe(0);

    const dir = join(cwd, 'studio');
    expect((await readdir(dir)).sort()).toEqual([
      '.gitignore',
      'bundles',
      'data',
      'mooncg.config.json',
    ]);
    const sources = { argv: [], env: {}, cwd: dir };
    const config = loadConfig({ ...sources, file: await readConfigFile(sources) });
    expect(config).toMatchObject({
      port: 9090,
      host: '127.0.0.1',
      bundlesDir: join(dir, 'bundles'),
      dataDir: join(dir, 'data'),
      allowedOrigins: [],
      dev: false,
      watch: false,
    });
    // The database holds password hashes and session secrets.
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toContain('data/');
    expect(out.join('\n')).toContain('mooncg dev');
  });

  it('uses the working directory when no folder is named', async () => {
    const { mooncg, cwd } = await workspace();
    expect(await mooncg('init')).toBe(0);
    expect(await readdir(cwd)).toContain('mooncg.config.json');
  });

  it('overwrites nothing that is there', async () => {
    const { mooncg, cwd, errors } = await workspace({
      'mooncg.config.json': '{ "port": 1234 }',
      'bundles/mine/mooncg.json': '{}',
    });

    expect(await mooncg('init')).toBe(1);

    expect(errors.join('\n')).toContain('mooncg.config.json');
    expect(await readFile(join(cwd, 'mooncg.config.json'), 'utf8')).toBe('{ "port": 1234 }');
    expect(await readdir(join(cwd, 'bundles'))).toEqual(['mine']);
  });

  it('keeps a .gitignore that is there', async () => {
    const { mooncg, cwd } = await workspace({ '.gitignore': 'node_modules/\n' });
    expect(await mooncg('init')).toBe(0);
    expect(await readFile(join(cwd, '.gitignore'), 'utf8')).toBe('node_modules/\n');
  });

  it('takes one folder at most', async () => {
    const { mooncg } = await workspace();
    expect(await mooncg('init', 'a', 'b')).toBe(1);
  });
});

describe('mooncg bundle create', () => {
  it('knows its templates', () => {
    expect(TEMPLATES).toContain('html');
  });

  it('creates a bundle from the html template in the bundles folder', async () => {
    const { mooncg, cwd, out } = await workspace();

    expect(await mooncg('bundle', 'create', 'lower-third')).toBe(0);

    const dir = join(cwd, 'bundles', 'lower-third');
    const manifest = parseManifest(JSON.parse(await readFile(join(dir, 'mooncg.json'), 'utf8')));
    expect(manifest).toMatchObject({
      ok: true,
      manifest: { name: 'lower-third', title: 'Lower Third', version: '0.1.0' },
    });
    if (!manifest.ok) return;
    const named = [
      manifest.manifest.extension,
      ...manifest.manifest.panels.map((panel) => panel.file),
      ...manifest.manifest.graphics.map((graphic) => graphic.file),
      ...Object.values(manifest.manifest.replicants).flatMap(({ schema }) => schema ?? []),
    ];
    expect(named.length).toBeGreaterThanOrEqual(4);
    // Every file the manifest names is there, and no placeholder is left in any file.
    for (const file of named) {
      const text = await readFile(join(dir, file as string), 'utf8');
      expect(text).not.toMatch(/\{\{\w+\}\}/);
    }
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toContain('lower-third');
    expect(out.join('\n')).toContain(dir);
  });

  it('creates a bundle that runs: the server starts it and serves its pages', async () => {
    const { mooncg, cwd } = await workspace();
    await mooncg('bundle', 'create', 'demo');

    const context = await startAuthServer(temporary, { bundlesDir: join(cwd, 'bundles') });
    cleanup.push(() => context.server.close());
    await context.auth.createUser({ name: 'ada', password: PASSWORD, roles: ['admin'] });
    const admin = { cookie: await context.login('ada') };

    expect(context.server.manager.get('demo')).toMatchObject({ state: 'running', errors: [] });
    const { json } = await context.http('GET', '/api/v1/bundles', admin);
    const [bundle] = json.bundles;
    expect(bundle.panels).toHaveLength(1);
    expect(bundle.graphics).toHaveLength(1);
    expect((await context.http('GET', bundle.panels[0].url, admin)).status).toBe(200);
    expect((await context.http('GET', bundle.graphics[0].url, admin)).status).toBe(200);
    // Its extension ran and its replicant holds the default.
    const socket = await context.socket(admin, 'demo');
    expect(await socket.ask({ t: 'rep.sub', name: 'message' })).toMatchObject({
      t: 'rep.snap',
      value: { text: expect.any(String) },
    });
    socket.close();
  });

  it('puts the bundle where --dir or the configuration file says', async () => {
    const { mooncg, cwd } = await workspace({
      'mooncg.config.json': JSON.stringify({ bundlesDir: 'my-bundles' }),
    });

    expect(await mooncg('bundle', 'create', 'one')).toBe(0);
    expect(await mooncg('bundle', 'create', 'two', '--dir', 'elsewhere')).toBe(0);

    expect(await readdir(join(cwd, 'my-bundles'))).toEqual(['one']);
    expect(await readdir(join(cwd, 'elsewhere'))).toEqual(['two']);
  });

  it('puts the bundle where the file --config or MOONCG_CONFIG names says', async () => {
    const { mooncg, cwd, io } = await workspace({
      'mooncg.config.json': JSON.stringify({ bundlesDir: 'default-bundles' }),
      'conf/show.json': JSON.stringify({ bundlesDir: '../show-bundles' }),
      'conf/env.json': JSON.stringify({ bundlesDir: '../env-bundles' }),
    });

    expect(await mooncg('bundle', 'create', 'one', '--config', 'conf/show.json')).toBe(0);
    const env = { MOONCG_CONFIG: join(cwd, 'conf', 'env.json') };
    expect(await run(['bundle', 'create', 'two'], { ...io, env })).toBe(0);
    // The flag wins over the variable, as it does for the server.
    expect(
      await run(['bundle', 'create', 'three', '--config', 'conf/show.json'], { ...io, env }),
    ).toBe(0);

    expect((await readdir(join(cwd, 'show-bundles'))).sort()).toEqual(['one', 'three']);
    expect(await readdir(join(cwd, 'env-bundles'))).toEqual(['two']);
    expect(await readdir(cwd)).not.toContain('default-bundles');
  });

  it('says so when the file --config names is not there', async () => {
    const { mooncg, errors, cwd } = await workspace();
    expect(await mooncg('bundle', 'create', 'one', '--config', 'missing.json')).toBe(1);
    expect(errors.join('\n')).toContain('missing.json');
    expect(await readdir(cwd)).toEqual([]);
  });

  it.each(['Bad_Name', 'system', 'con', '../escape', 'a--b', ''])(
    'refuses the name "%s" and creates nothing',
    async (name) => {
      const { mooncg, cwd, errors } = await workspace();
      expect(await mooncg('bundle', 'create', name)).toBe(1);
      expect(await readdir(cwd)).toEqual([]);
      expect(errors.join('\n')).not.toBe('');
    },
  );

  it('does not write into a folder that exists', async () => {
    const { mooncg, cwd, errors } = await workspace({ 'bundles/demo/keep.txt': 'mine' });

    expect(await mooncg('bundle', 'create', 'demo')).toBe(1);

    expect(errors.join('\n')).toContain('exists');
    expect(await readdir(join(cwd, 'bundles', 'demo'))).toEqual(['keep.txt']);
  });

  it('takes away what it wrote when a file cannot be written, so that a retry works', async () => {
    const { cwd } = await workspace();
    const bundlesDir = join(cwd, 'bundles');
    let written = 0;
    const failing = createBundle({
      name: 'demo',
      bundlesDir,
      write: async (path, text) => {
        // The second file fails, as on a full disk.
        if (++written === 2) throw new Error('ENOSPC: no space left on device');
        await writeFile(path, text, { flag: 'wx' });
      },
    });

    await expect(failing).rejects.toThrow(/ENOSPC/);
    expect(written).toBe(2);
    // The bundles folder was created for it and may stay; the half-written bundle may not.
    expect(await readdir(bundlesDir)).toEqual([]);

    const { files } = await createBundle({ name: 'demo', bundlesDir });
    expect((await readdir(join(bundlesDir, 'demo'))).length).toBeGreaterThan(0);
    expect(files.length).toBeGreaterThan(1);
  });

  it('names the templates when asked for one it does not have', async () => {
    const { mooncg, errors, cwd } = await workspace();
    expect(await mooncg('bundle', 'create', 'demo', '--template', 'nope')).toBe(1);
    expect(errors.join('\n')).toContain('html');
    expect(await readdir(cwd)).toEqual([]);
  });

  it('needs no server and no token', async () => {
    const { mooncg, errors } = await workspace();
    expect(await mooncg('bundle', 'create', 'demo', '--url', 'http://127.0.0.1:1')).toBe(0);
    expect(errors).toEqual([]);
  });
});
