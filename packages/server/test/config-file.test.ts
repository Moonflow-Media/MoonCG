import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG_FILE, loadConfig, readConfigFile } from '../src/kernel/config.js';

const cwd = resolve('/srv/mooncg');
const fileDir = resolve('/etc/mooncg');
const file = (values: unknown) => ({ values, dir: fileDir, path: join(fileDir, CONFIG_FILE) });
const load = (argv: string[] = [], env: Record<string, string> = {}, values: unknown = undefined) =>
  loadConfig({ argv, env, cwd, ...(values === undefined ? {} : { file: file(values) }) });

describe('dev mode and watching in the configuration', () => {
  it('is off unless asked for', () => {
    expect(load()).toMatchObject({ dev: false, watch: false });
  });

  it('turns dev mode on with --dev, which also watches', () => {
    expect(load(['--dev'])).toMatchObject({ dev: true, watch: true, host: '127.0.0.1' });
  });

  it('turns only the watcher on with --watch or MOONCG_WATCH', () => {
    expect(load(['--watch'])).toMatchObject({ dev: false, watch: true });
    expect(load([], { MOONCG_WATCH: '1' })).toMatchObject({ dev: false, watch: true });
    expect(load([], { MOONCG_WATCH: 'true' })).toMatchObject({ watch: true });
    expect(load([], { MOONCG_WATCH: '0' })).toMatchObject({ watch: false });
  });

  it('lets the flag win over the environment, and the environment over the file', () => {
    const file = { watch: true };
    expect(load([], {}, file)).toMatchObject({ watch: true });
    expect(load([], { MOONCG_WATCH: '0' }, file)).toMatchObject({ watch: false });
    expect(load([], { MOONCG_WATCH: 'false' }, file)).toMatchObject({ watch: false });
    // A variable that is set to nothing is not set.
    expect(load([], { MOONCG_WATCH: '' }, file)).toMatchObject({ watch: true });
    expect(load([], { MOONCG_WATCH: '1' }, { watch: false })).toMatchObject({ watch: true });
    expect(load(['--watch'], { MOONCG_WATCH: '0' }, { watch: false })).toMatchObject({
      watch: true,
    });
  });

  it('turns the watcher off with --no-watch, whatever the environment and the file say', () => {
    expect(load(['--no-watch'], { MOONCG_WATCH: '1' }, { watch: true })).toMatchObject({
      watch: false,
    });
    // Dev mode is nothing without its watcher.
    expect(load(['--dev', '--no-watch'])).toMatchObject({ dev: true, watch: true });
  });

  it('never takes dev mode from the environment or from a file', () => {
    expect(load([], { MOONCG_DEV: '1' })).toMatchObject({ dev: false });
    expect(() => load([], {}, { dev: true })).toThrow(/"dev".*--dev/s);
  });

  it.each(['0.0.0.0', '192.168.1.10', '::', 'example.com'])(
    'refuses dev mode on the host %s',
    (host) => {
      expect(() => load(['--dev', '--host', host])).toThrow(/loopback/);
      expect(() => load(['--dev'], { MOONCG_HOST: host })).toThrow(/loopback/);
      expect(() => load(['--dev'], {}, { host })).toThrow(/loopback/);
    },
  );

  it.each(['localhost', '127.0.0.1', '127.0.0.2', '::1'])('allows dev mode on %s', (host) => {
    expect(load(['--dev', '--host', host])).toMatchObject({ dev: true, host });
  });

  it.each(['https://evil.example', 'http://192.168.1.10:5173', 'http://localhost.evil.example'])(
    'refuses dev mode with the allowed origin %s, wherever it was configured',
    (origin) => {
      const message = /allowed origin.*loopback/s;
      expect(() => load(['--dev', '--allowed-origin', origin])).toThrow(message);
      expect(() => load(['--dev'], { MOONCG_ALLOWED_ORIGINS: origin })).toThrow(message);
      expect(() => load(['--dev'], {}, { allowedOrigins: [origin] })).toThrow(message);
      expect(() =>
        load(['--dev', '--allowed-origin', 'http://localhost:5173', '--allowed-origin', origin]),
      ).toThrow(origin);
      // Outside dev mode nobody is signed in for where they come from.
      expect(load(['--allowed-origin', origin]).allowedOrigins).toEqual([origin]);
    },
  );

  it('allows dev mode with allowed origins on this machine', () => {
    const origins = ['http://localhost:5173', 'https://127.0.0.1:8443', 'http://[::1]:3000'];
    expect(load(['--dev'], {}, { allowedOrigins: origins })).toMatchObject({
      dev: true,
      allowedOrigins: origins,
    });
  });

  it('refuses dev mode behind a trusted proxy', () => {
    expect(() => load(['--dev', '--trust-proxy'])).toThrow(/proxy/);
    expect(() => load(['--dev'], { MOONCG_TRUST_PROXY: '1' })).toThrow(/proxy/);
  });
});

describe('the configuration file', () => {
  it('sets what flags and environment leave open, relative to its own folder', () => {
    expect(
      load(
        [],
        {},
        {
          port: 8123,
          host: '0.0.0.0',
          dataDir: 'var/data',
          bundlesDir: '../bundles',
          allowedOrigins: ['http://localhost:5173/'],
          watch: true,
        },
      ),
    ).toMatchObject({
      port: 8123,
      host: '0.0.0.0',
      dataDir: resolve(fileDir, 'var/data'),
      bundlesDir: resolve(fileDir, '../bundles'),
      allowedOrigins: ['http://localhost:5173'],
      watch: true,
    });
  });

  it('loses against the environment, which loses against the flags', () => {
    const values = { port: 1000, host: 'localhost', dataDir: 'file-data', bundlesDir: 'file-b' };
    const env = { MOONCG_PORT: '2000', MOONCG_DATA_DIR: 'env-data' };
    expect(load(['--port', '3000'], env, values)).toMatchObject({
      port: 3000,
      host: 'localhost',
      dataDir: resolve(cwd, 'env-data'),
      bundlesDir: resolve(fileDir, 'file-b'),
    });
  });

  it('lets the allowed origins of the environment or the flags replace those of the file', () => {
    const values = { allowedOrigins: ['http://a.example'] };
    expect(load([], {}, values).allowedOrigins).toEqual(['http://a.example']);
    expect(load([], { MOONCG_ALLOWED_ORIGINS: 'http://b.example' }, values).allowedOrigins).toEqual(
      ['http://b.example'],
    );
    expect(load(['--allowed-origin', 'http://c.example'], {}, values).allowedOrigins).toEqual([
      'http://c.example',
    ]);
  });

  it('accepts $schema and an empty object', () => {
    expect(load([], {}, { $schema: './schema.json' })).toMatchObject({ port: 9090 });
    expect(load([], {}, {})).toMatchObject({ port: 9090 });
  });

  it.each([
    [{ prot: 1 }, /"prot"/],
    [{ port: '9090' }, /"port"/],
    [{ port: 70000 }, /port/],
    [{ port: 1.5 }, /"port"/],
    [{ host: 5 }, /"host"/],
    [{ host: '' }, /"host"/],
    [{ dataDir: 5 }, /"dataDir"/],
    [{ bundlesDir: '' }, /"bundlesDir"/],
    [{ allowedOrigins: 'http://a.example' }, /"allowedOrigins"/],
    [{ allowedOrigins: [5] }, /"allowedOrigins"/],
    [{ allowedOrigins: ['nonsense'] }, /allowed origin/],
    [{ watch: 'yes' }, /"watch"/],
    [[], /object/],
    ['text', /object/],
    [null, /object/],
  ])('refuses %j and names the file', (values, message) => {
    expect(() => load([], {}, values)).toThrow(message);
    expect(() => load([], {}, values)).toThrow(/mooncg\.config\.json/);
  });

  it('accepts --config among the flags', () => {
    expect(load(['--config', 'other.json', '--port', '1'])).toMatchObject({ port: 1 });
  });
});

describe('readConfigFile', () => {
  const created: string[] = [];
  afterEach(async () => {
    for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  const folder = async (files: Record<string, string> = {}) => {
    const dir = await mkdtemp(join(tmpdir(), 'mooncg-config-'));
    created.push(dir);
    for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
    return dir;
  };

  it('answers nothing when the working directory has no file', async () => {
    const dir = await folder();
    expect(await readConfigFile({ argv: [], env: {}, cwd: dir })).toBeUndefined();
  });

  it('reads mooncg.config.json of the working directory', async () => {
    const dir = await folder({ [CONFIG_FILE]: '{ "port": 8123 }' });
    expect(await readConfigFile({ argv: [], env: {}, cwd: dir })).toEqual({
      values: { port: 8123 },
      dir,
      path: join(dir, CONFIG_FILE),
    });
  });

  it('reads the file --config or MOONCG_CONFIG names, the flag first', async () => {
    const dir = await folder({ 'a.json': '{ "port": 1 }', 'b.json': '{ "port": 2 }' });
    const other = await folder();
    const env = { MOONCG_CONFIG: join(dir, 'b.json') };
    expect((await readConfigFile({ argv: [], env, cwd: other }))?.values).toEqual({ port: 2 });
    expect(
      (await readConfigFile({ argv: ['--port', '5', '--config', 'a.json'], env, cwd: dir }))
        ?.values,
    ).toEqual({ port: 1 });
  });

  it('fails for a file that was named and is not there', async () => {
    const dir = await folder();
    await expect(
      readConfigFile({ argv: ['--config', 'missing.json'], env: {}, cwd: dir }),
    ).rejects.toThrow(/missing\.json/);
  });

  it('fails for a file that is not JSON, naming it', async () => {
    const dir = await folder({ [CONFIG_FILE]: '{ port: 1 }' });
    await expect(readConfigFile({ argv: [], env: {}, cwd: dir })).rejects.toThrow(
      /mooncg\.config\.json.*JSON/s,
    );
  });

  it('feeds loadConfig', async () => {
    const dir = await folder({ [CONFIG_FILE]: '{ "port": 8123, "dataDir": "d" }' });
    const sources = { argv: [], env: {}, cwd: dir };
    const config = loadConfig({ ...sources, file: await readConfigFile(sources) });
    expect(config).toMatchObject({ port: 8123, dataDir: join(dir, 'd') });
  });
});
