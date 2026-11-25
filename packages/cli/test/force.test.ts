import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { authBundles, PASSWORD, startAuthServer } from '../../server/test/auth-helpers.js';
import { manifest, temporaryBundles } from '../../server/test/temp-bundles.js';
import { type CliIo, run } from '../src/cli.js';

const temporary = temporaryBundles();
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  await temporary.cleanup();
});

/**
 * A server with the usual bundles and `needy`, which needs `board`, and the command line
 * pointed at it with a token that manages bundles. On air unless said otherwise.
 */
async function installation(onAir = true) {
  const root = await mkdtemp(join(tmpdir(), 'mooncg-cli-force-'));
  const bundlesDir = await temporary.create({
    ...authBundles(),
    'needy/mooncg.json': manifest('needy', { dependencies: { board: '*' } }),
  });
  const context = await startAuthServer(
    temporary,
    { dataDir: join(root, 'data'), bundlesDir },
    { npmInstall: async () => {} },
  );
  cleanup.push(async () => {
    await context.server.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const ada = await context.auth.createUser({ name: 'ada', password: PASSWORD, roles: ['admin'] });
  const { secret } = context.auth.createToken(
    { id: `user:${ada.id}`, kind: 'user', roles: ['admin'] },
    { name: 'cli', grants: ['system:bundles.manage'] },
  );
  const out: string[] = [];
  const errors: string[] = [];
  const io: CliIo = {
    cwd: root,
    env: {},
    log: (line) => out.push(line),
    error: (line) => errors.push(line),
  };
  const mooncg = (...argv: string[]) =>
    run([...argv, '--url', context.base, '--token', secret], io, { pollMs: 10 });
  const folder = async (version: string) => {
    const dir = join(root, `board-${version}`);
    const files = {
      'mooncg.json': JSON.stringify(manifest('secret', { version })),
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), content);
    }
    return dir;
  };
  const state = (name: string) => {
    const record = context.server.manager.get(name);
    return record && `${record.state} ${record.manifest?.version}`;
  };
  if (onAir) await context.server.onAir.set(true, 'test');
  return { ...context, mooncg, out, errors, io, secret, folder, state };
}

describe('the command line while the installation is on air', () => {
  it.each(['reload', 'disable'] as const)(
    'refuses to %s a bundle and says why; --on-air does it, --force does not',
    async (action) => {
      const { mooncg, errors, out } = await installation();

      expect(await mooncg('bundle', action, 'secret')).toBe(1);
      expect(errors.join('\n')).toContain('on air');
      expect(errors.join('\n')).toContain('--on-air');
      expect(await mooncg('bundle', action, 'secret', '--force')).toBe(1);

      expect(await mooncg('bundle', action, 'secret', '--on-air')).toBe(0);
      expect(out.join('\n')).toContain(
        action === 'reload' ? 'secret is running' : 'secret is disabled',
      );
    },
  );

  it('refuses an update before anything is fetched, and says how to go ahead', async () => {
    const { mooncg, errors, out, folder, state, server } = await installation();
    const next = await folder('2.0.0');

    expect(await mooncg('bundle', 'update', 'secret', next, '--yes')).toBe(1);

    const said = errors.join('\n');
    expect(said).toContain('on air');
    expect(said).toContain('secret');
    expect(said).toContain('--on-air');
    expect(said).toContain('Nothing was changed');
    expect(out.join('\n')).not.toContain('Fetching');
    expect(state('secret')).toBe('running 1.0.0');
    expect(server.installer.staged()).toEqual([]);
    // What removes a bundle others need does not update one that is on air.
    expect(await mooncg('bundle', 'update', 'secret', next, '--yes', '--force')).toBe(1);
    expect(state('secret')).toBe('running 1.0.0');
  });

  it('updates with --on-air', async () => {
    const { mooncg, folder, state } = await installation();
    const next = await folder('2.0.0');

    expect(await mooncg('bundle', 'update', 'secret', next, '--yes', '--on-air')).toBe(0);

    expect(state('secret')).toBe('running 2.0.0');
  });

  it('discards what it fetched when On Air goes on before its question is answered', async () => {
    const { errors, folder, state, server, io, base, secret } = await installation(false);
    const next = await folder('2.0.0');
    // The person at the terminal takes their time with the question; the show starts.
    const asking: CliIo = {
      ...io,
      confirm: async () => {
        await server.onAir.set(true, 'test');
        return true;
      },
    };

    const code = await run(
      ['bundle', 'update', 'secret', next, '--url', base, '--token', secret],
      asking,
      { pollMs: 10 },
    );

    expect(code).toBe(1);
    const said = errors.join('\n');
    expect(said).toContain('on air');
    expect(said).toContain('--on-air');
    expect(said).toContain('discarded');
    expect(state('secret')).toBe('running 1.0.0');
    expect(server.installer.staged()).toEqual([]);
  });

  it('installs a new bundle without any flag: that interrupts nothing', async () => {
    const { mooncg, state } = await installation();
    const fresh = await temporary.create({
      'mooncg.json': manifest('fresh', { version: '1.0.0' }),
    });

    expect(await mooncg('bundle', 'install', fresh, '--yes')).toBe(0);

    expect(state('fresh')).toBe('running 1.0.0');
  });

  it('refuses a removal; --on-air removes', async () => {
    const { mooncg, errors, state } = await installation();

    expect(await mooncg('bundle', 'remove', 'secret', '--yes')).toBe(1);
    expect(errors.join('\n')).toContain('on air');
    expect(errors.join('\n')).toContain('--on-air');
    // --force is about the bundles that need this one.
    expect(await mooncg('bundle', 'remove', 'secret', '--yes', '--force')).toBe(1);
    expect(state('secret')).toBe('running 1.0.0');

    expect(await mooncg('bundle', 'remove', 'secret', '--yes', '--on-air')).toBe(0);
    expect(state('secret')).toBeUndefined();
  });

  it('takes both flags to remove a bundle others need while on air', async () => {
    const { mooncg, errors, state } = await installation();

    expect(await mooncg('bundle', 'remove', 'board', '--yes', '--on-air')).toBe(1);
    expect(errors.at(-1)).toContain('needed by needy');
    expect(await mooncg('bundle', 'remove', 'board', '--yes', '--force')).toBe(1);
    expect(errors.at(-1)).toContain('on air');
    expect(state('board')).toBe('running 1.0.0');

    expect(await mooncg('bundle', 'remove', 'board', '--yes', '--force', '--on-air')).toBe(0);
    expect(state('board')).toBeUndefined();
  });

  it('refuses to restore a backup over a running bundle; --on-air restores', async () => {
    const { mooncg, errors, folder, state, out } = await installation();
    await mooncg('bundle', 'update', 'secret', await folder('2.0.0'), '--yes', '--on-air');
    out.length = 0;
    await mooncg('bundle', 'backups', 'secret');
    const backup = (out[0] ?? '').split(/\s+/)[0] as string;

    expect(await mooncg('bundle', 'restore', 'secret', backup, '--yes')).toBe(1);
    expect(errors.join('\n')).toContain('on air');
    expect(await mooncg('bundle', 'restore', 'secret', backup, '--yes', '--force')).toBe(1);
    expect(state('secret')).toBe('running 2.0.0');

    expect(await mooncg('bundle', 'restore', 'secret', backup, '--yes', '--on-air')).toBe(0);
    expect(state('secret')).toBe('running 1.0.0');
  });

  it('still enables a bundle without any flag', async () => {
    const { mooncg } = await installation();
    await mooncg('bundle', 'disable', 'secret', '--on-air');
    expect(await mooncg('bundle', 'enable', 'secret')).toBe(0);
  });
});

describe('the command line while the installation is off air', () => {
  it('keeps --force for removing a bundle others need, as before there was a lock', async () => {
    const { mooncg, errors, state } = await installation(false);

    expect(await mooncg('bundle', 'remove', 'board', '--yes')).toBe(1);
    expect(errors.at(-1)).toContain('needed by needy');
    expect(await mooncg('bundle', 'remove', 'board', '--yes', '--on-air')).toBe(1);
    expect(state('board')).toBe('running 1.0.0');

    expect(await mooncg('bundle', 'remove', 'board', '--yes', '--force')).toBe(0);
    expect(state('board')).toBeUndefined();
  });

  it('names both flags in the usage text, each with what it is for', async () => {
    const { io, errors } = await installation(false);
    await run([], io);
    const usage = errors.join('\n');
    expect(usage).toContain('--on-air');
    expect(usage).toMatch(/--force removes a bundle others still need/);
  });
});
