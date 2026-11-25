import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { moduleManifest, startModuleServer } from '../../server/test/module-helpers.js';
import { temporaryBundles } from '../../server/test/temp-bundles.js';
import { type CliIo, run } from '../src/cli.js';

const temporary = temporaryBundles();
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  await temporary.cleanup();
});

const MODULES = {
  'hello/mooncg.json': moduleManifest('hello', { title: 'Hello', version: '2.1.0' }),
  'hello/index.js':
    'export default (ctx) => ctx.http.register({ method: "GET", path: "/hi", public: true, handler: () => ({ body: "hi" }) });',
  'broken/mooncg.json': moduleManifest('broken'),
  'broken/index.js': 'export default () => { throw new Error("It broke\\u001b[2J badly"); };',
};

/** A running server with two modules, and the command line pointed at it with a token. */
async function setup() {
  const context = await startModuleServer(temporary, MODULES);
  cleanup.push(() => context.server.close());
  const { auth, base } = context;
  const ada = auth.findUser('ada');
  const principal = { id: `user:${ada?.id}`, kind: 'user' as const, roles: ['admin'] };
  const token = (grant: string) =>
    auth.createToken(principal, { name: grant, grants: [grant] }).secret;
  const out: string[] = [];
  const errors: string[] = [];
  const io: CliIo = {
    cwd: process.cwd(),
    env: {},
    log: (line) => out.push(line),
    error: (line) => errors.push(line),
  };
  const mooncg = (argv: string[], secret = token('system:modules.manage')) =>
    run([...argv, '--url', base, '--token', secret], io);
  return { ...context, out, errors, mooncg, token, io };
}

describe('mooncg module', () => {
  it('lists the modules with version and state', async () => {
    const { mooncg, out } = await setup();
    expect(await mooncg(['module', 'list'])).toBe(0);
    expect(out).toEqual([
      'auth-local  (built in)  running',
      'broken  1.0.0  disabled',
      'hello  2.1.0  disabled',
    ]);
  });

  it('enables a module, which starts it at once', async () => {
    const { mooncg, out, http } = await setup();
    expect(await mooncg(['module', 'enable', 'hello'])).toBe(0);
    expect(out).toEqual(['Module "hello" is running.']);
    expect((await http('GET', '/m/hello/hi')).text).toBe('hi');
  });

  it('disables it again', async () => {
    const { mooncg, out, http, admin } = await setup();
    await mooncg(['module', 'enable', 'hello']);
    out.length = 0;
    expect(await mooncg(['module', 'disable', 'hello'])).toBe(0);
    expect(out).toEqual(['Module "hello" is disabled.']);
    expect((await http('GET', '/m/hello/hi', { cookie: admin })).status).toBe(404);
  });

  it('fails when the module does, with the reason on one line', async () => {
    const { mooncg, out, errors } = await setup();
    expect(await mooncg(['module', 'enable', 'broken'])).toBe(1);
    expect(errors).toEqual(['Module "broken" failed: It broke [2J badly']);
    out.length = 0;
    await mooncg(['module', 'list']);
    expect(out).toContain('broken  1.0.0  failed: It broke [2J badly');
  });

  it('says what the server says about a module that is not there', async () => {
    const { mooncg, errors } = await setup();
    expect(await mooncg(['module', 'enable', 'nope'])).toBe(1);
    expect(errors).toEqual(['There is no module "nope"']);
  });

  it('needs a token that holds system:modules.manage', async () => {
    const { mooncg, errors, token, io, base } = await setup();
    expect(await mooncg(['module', 'list'], token('system:bundles.manage'))).toBe(1);
    expect(errors.join('\n')).toMatch(/system:modules.manage/);
    errors.length = 0;
    expect(await run(['module', 'list', '--url', base], io)).toBe(1);
    expect(errors.join('\n')).toMatch(/No API token given.*system:modules.manage/);
  });

  it('prints the usage for anything else', async () => {
    const { mooncg, errors } = await setup();
    expect(await mooncg(['module', 'frobnicate', 'hello'])).toBe(1);
    expect(await mooncg(['module', 'enable'])).toBe(1);
    expect(await mooncg(['module', 'install'])).toBe(1);
    expect(await mooncg(['module', 'list', 'extra'])).toBe(1);
    expect(errors.join('\n')).toMatch(/module list/);
  });

  it('does not send the token over plain http to another machine', async () => {
    const { io, errors } = await setup();
    const code = await run(
      ['module', 'list', '--url', 'http://mooncg.example:9090', '--token', 'mcg_x'],
      io,
    );
    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(/unencrypted/);
  });
});

describe('mooncg module install, update and remove', () => {
  /** A folder with a module `greeter` of `version`. */
  async function greeter(version: string) {
    const dir = await mkdtemp(join(tmpdir(), 'mooncg-module-src-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'mooncg.json'),
      JSON.stringify(moduleManifest('greeter', { version, title: 'Greeter' })),
    );
    await writeFile(
      join(dir, 'index.js'),
      `export default (ctx) => ctx.http.register({ method: "GET", path: "/v", public: true, handler: () => ({ body: "${version}" }) });`,
    );
    return dir;
  }

  it('installs a module after showing that it runs inside the server, disabled', async () => {
    const { mooncg, out, server } = await setup();
    expect(await mooncg(['module', 'install', await greeter('1.0.0'), '--yes'])).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/greeter 1\.0\.0 "Greeter", from folder/);
    expect(text).toMatch(/runs inside the MoonCG server process with full access/);
    expect(text).toMatch(
      /Installed greeter 1\.0\.0\. It is disabled: "mooncg module enable greeter" starts it\./,
    );
    expect(server.modules.get('greeter')).toMatchObject({ enabled: false, state: 'disabled' });
  });

  it('asks before it installs, and discards what it fetched on no', async () => {
    const { io, base, token, server } = await setup();
    const asked: string[] = [];
    const answering: CliIo = {
      ...io,
      confirm: async (question) => {
        asked.push(question);
        return false;
      },
    };
    const dir = await greeter('1.0.0');
    const argv = [
      'module',
      'install',
      dir,
      '--url',
      base,
      '--token',
      token('system:modules.manage'),
    ];
    expect(await run(argv, answering)).toBe(1);
    expect(asked).toEqual(['Install module greeter 1.0.0? [y/N] ']);
    expect(server.modules.get('greeter')).toBeUndefined();
    expect(server.moduleInstaller.staged()).toEqual([]);
    // Nobody to ask and no --yes: nothing is installed either.
    expect(await run(argv, io)).toBe(1);
    expect(server.moduleInstaller.staged()).toEqual([]);
  });

  it('updates and removes it', async () => {
    const { mooncg, out, http, server } = await setup();
    await mooncg(['module', 'install', await greeter('1.0.0'), '--yes']);
    await mooncg(['module', 'enable', 'greeter']);
    out.length = 0;
    expect(await mooncg(['module', 'update', 'greeter', await greeter('1.1.0'), '--yes'])).toBe(0);
    expect(out.join('\n')).toMatch(/updates greeter 1\.0\.0/);
    expect((await http('GET', '/m/greeter/v')).text).toBe('1.1.0');

    expect(await mooncg(['module', 'remove', 'greeter', '--yes'])).toBe(0);
    expect(out.at(-1)).toBe('Removed module greeter');
    expect(server.modules.get('greeter')).toBeUndefined();
  });

  it('keeps to the On Air lock for an enabled module unless --on-air is given', async () => {
    const { mooncg, errors, server, http } = await setup();
    await mooncg(['module', 'install', await greeter('1.0.0'), '--yes']);
    await mooncg(['module', 'enable', 'greeter']);
    await server.onAir.set(true, 'test');
    expect(await mooncg(['module', 'update', 'greeter', await greeter('1.1.0'), '--yes'])).toBe(1);
    expect(errors.join('\n')).toMatch(/on air/);
    expect(server.moduleInstaller.staged()).toEqual([]);
    expect(
      await mooncg(['module', 'update', 'greeter', await greeter('1.1.0'), '--yes', '--on-air']),
    ).toBe(0);
    expect((await http('GET', '/m/greeter/v')).text).toBe('1.1.0');
  });
});
