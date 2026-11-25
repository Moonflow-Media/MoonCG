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
    expect(await mooncg(['module', 'remove', 'hello'])).toBe(1);
    expect(await mooncg(['module', 'enable'])).toBe(1);
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
