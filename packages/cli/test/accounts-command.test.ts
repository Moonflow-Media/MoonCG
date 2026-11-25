import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAccounts } from '@mooncg/server/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuth } from '../../server/src/auth/auth.js';
import { openSqliteStorage } from '../../server/src/storage/replicant-store.js';
import { type CliIo, run } from '../src/cli.js';

const CHEAP = { N: 16, r: 1, p: 1 };
const PASSWORD = 'correct horse';

const temporary: string[] = [];
afterEach(async () => {
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), 'mooncg-cli-data-'));
  temporary.push(dataDir);
  const out: string[] = [];
  const errors: string[] = [];
  const io: CliIo = {
    cwd: dataDir,
    env: {},
    log: (line) => out.push(line),
    error: (line) => errors.push(line),
  };
  const mooncg = (...argv: string[]) =>
    run([...argv, '--data-dir', dataDir], io, { passwordCost: CHEAP });
  /** Looks at the data directory the way a server started on it would. */
  const inspect = async <T>(work: (accounts: Awaited<ReturnType<typeof openAccounts>>) => T) => {
    const accounts = await openAccounts(dataDir, { passwordCost: CHEAP });
    try {
      return await work(accounts);
    } finally {
      await accounts.close();
    }
  };
  return { dataDir, out, errors, io, mooncg, inspect };
}

describe('mooncg user', () => {
  it('creates an administrator who can then sign in', async () => {
    const { mooncg, out, inspect } = await setup();
    expect(await mooncg('user', 'create', 'ada', '--admin', '--password', PASSWORD)).toBe(0);
    expect(out.join('\n')).toContain('ada');
    expect(out.join('\n')).not.toContain(PASSWORD);
    await inspect(async ({ auth }) => {
      expect(auth.listUsers()).toMatchObject([{ name: 'ada', roles: ['admin'] }]);
      expect((await auth.login('ada', PASSWORD, 'test')).ok).toBe(true);
      // With a user in place, a server started on this directory offers no setup.
      expect(auth.setupCode()).toBeUndefined();
    });
  });

  it('creates a user with roles, or with none', async () => {
    const { mooncg, inspect } = await setup();
    expect(
      await mooncg(
        'user',
        'create',
        'olga',
        '--role',
        'operator',
        '--role',
        'viewer',
        '--password',
        PASSWORD,
      ),
    ).toBe(0);
    expect(await mooncg('user', 'create', 'gus', '--password', PASSWORD)).toBe(0);
    await inspect(({ auth }) => {
      expect(auth.findUser('olga')?.roles).toEqual(['operator', 'viewer']);
      expect(auth.findUser('gus')?.roles).toEqual([]);
    });
  });

  it('takes the password from the environment or asks for it', async () => {
    const { mooncg, io, inspect } = await setup();
    const fromEnv: CliIo = { ...io, env: { MOONCG_PASSWORD: PASSWORD } };
    expect(
      await run(['user', 'create', 'eve', '--data-dir', io.cwd], fromEnv, { passwordCost: CHEAP }),
    ).toBe(0);
    const asked: string[] = [];
    const prompting: CliIo = {
      ...io,
      prompt: async (question) => {
        asked.push(question);
        return 'typed password';
      },
    };
    expect(
      await run(['user', 'create', 'pat', '--data-dir', io.cwd], prompting, {
        passwordCost: CHEAP,
      }),
    ).toBe(0);
    expect(asked).toHaveLength(1);
    await inspect(async ({ auth }) => {
      expect((await auth.login('eve', PASSWORD, 'test')).ok).toBe(true);
      expect((await auth.login('pat', 'typed password', 'test')).ok).toBe(true);
    });
    // Nowhere to get a password from: an error, not a user without one.
    expect(await mooncg('user', 'create', 'nopass')).toBe(1);
    await inspect(({ auth }) => expect(auth.findUser('nopass')).toBeUndefined());
  });

  it('reports a short password, a taken name and an unknown role', async () => {
    const { mooncg, errors } = await setup();
    expect(await mooncg('user', 'create', 'ada', '--password', 'short')).toBe(1);
    expect(errors.at(-1)).toMatch(/at least 8/);
    await mooncg('user', 'create', 'ada', '--password', PASSWORD);
    expect(await mooncg('user', 'create', 'ADA', '--password', PASSWORD)).toBe(1);
    expect(errors.at(-1)).toMatch(/taken/);
    expect(await mooncg('user', 'create', 'bob', '--role', 'nope', '--password', PASSWORD)).toBe(1);
    expect(errors.at(-1)).toMatch(/nope/);
  });

  it('lists users with their roles and state', async () => {
    const { mooncg, out, inspect } = await setup();
    await mooncg('user', 'create', 'ada', '--admin', '--password', PASSWORD);
    await mooncg('user', 'create', 'vera', '--role', 'viewer', '--password', PASSWORD);
    await inspect(({ auth }) => {
      auth.updateUser((auth.findUser('vera') as { id: string }).id, { disabled: true });
    });
    out.length = 0;
    expect(await mooncg('user', 'list')).toBe(0);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/^ada\s+admin$/);
    expect(out[1]).toMatch(/^vera\s+viewer\s+disabled$/);
    expect(out.join('\n')).not.toMatch(/scrypt/);
  });

  it('shows the user dev mode created as what it is, and gives it no password or token', async () => {
    const { mooncg, out, errors, dataDir } = await setup();
    await mooncg('user', 'create', 'ada', '--admin', '--password', PASSWORD);
    // What "mooncg dev" does when it starts on this data directory.
    const storage = await openSqliteStorage(dataDir);
    createAuth({ store: storage.auth, devMode: true }).ensureDevUser();
    await storage.close();
    out.length = 0;

    expect(await mooncg('user', 'list')).toBe(0);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/^ada\s+admin$/);
    expect(out[1]).toMatch(/^dev\s+admin\s+dev mode only/);

    expect(await mooncg('user', 'passwd', 'dev', '--password', PASSWORD)).toBe(1);
    expect(errors.at(-1)).toMatch(/dev mode/);
    expect(
      await mooncg('token', 'create', 'obs', '--user', 'dev', '--grant', 'system:dashboard.view'),
    ).toBe(1);
    expect(errors.at(-1)).toMatch(/dev mode/);
  });

  it('sets a new password and signs the user out everywhere', async () => {
    const { mooncg, errors, inspect } = await setup();
    await mooncg('user', 'create', 'ada', '--admin', '--password', PASSWORD);
    const session = await inspect(async ({ auth }) => {
      const result = await auth.login('ada', PASSWORD, 'test');
      return result.ok ? result.session : '';
    });
    expect(await mooncg('user', 'passwd', 'ada', '--password', 'another password')).toBe(0);
    await inspect(async ({ auth }) => {
      expect(auth.identify({ session }).via).toBe('none');
      expect((await auth.login('ada', 'another password', 'test')).ok).toBe(true);
    });
    expect(await mooncg('user', 'passwd', 'nobody', '--password', PASSWORD)).toBe(1);
    expect(errors.at(-1)).toMatch(/nobody/);
  });
});

describe('mooncg token', () => {
  async function withAdmin() {
    const context = await setup();
    await context.mooncg('user', 'create', 'ada', '--admin', '--password', PASSWORD);
    context.out.length = 0;
    return context;
  }

  it('creates a token, prints its secret once, and the token works', async () => {
    const { mooncg, out, inspect } = await withAdmin();
    expect(
      await mooncg('token', 'create', 'OBS', '--user', 'ada', '--grant', 'bundle:scoreboard:view'),
    ).toBe(0);
    const secret = out.join('\n').match(/mcg_[A-Za-z0-9_-]+/)?.[0] as string;
    expect(secret.length).toBeGreaterThanOrEqual(40);
    await inspect(({ auth }) => {
      const identity = auth.identify({ bearer: secret });
      expect(identity.via).toBe('bearer');
      expect(identity.principal.only).toEqual(['bundle:scoreboard:view']);
    });

    out.length = 0;
    expect(await mooncg('token', 'list')).toBe(0);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/OBS/);
    expect(out[0]).toMatch(/bundle:scoreboard:view/);
    expect(out[0]).not.toContain('mcg_');
  });

  it('refuses grants beyond the creator, a missing creator and a bad expiry', async () => {
    const { mooncg, errors } = await withAdmin();
    await mooncg('user', 'create', 'vera', '--role', 'viewer', '--password', PASSWORD);
    expect(
      await mooncg('token', 'create', 'x', '--user', 'vera', '--grant', 'system:users.manage'),
    ).toBe(1);
    expect(errors.at(-1)).toMatch(/system:users\.manage/);
    expect(await mooncg('token', 'create', 'x', '--grant', '*')).toBe(1);
    expect(await mooncg('token', 'create', 'x', '--user', 'nobody', '--grant', '*')).toBe(1);
    expect(
      await mooncg('token', 'create', 'x', '--user', 'ada', '--grant', '*', '--expires', 'soon'),
    ).toBe(1);
    expect(
      await mooncg(
        'token',
        'create',
        'x',
        '--user',
        'ada',
        '--grant',
        '*',
        '--expires',
        '2999-01-01',
      ),
    ).toBe(0);
  });

  it('revokes a token by its id', async () => {
    const { mooncg, out, inspect } = await withAdmin();
    await mooncg('token', 'create', 'OBS', '--user', 'ada', '--grant', '*');
    const secret = out.join('\n').match(/mcg_[A-Za-z0-9_-]+/)?.[0] as string;
    const id = await inspect(({ auth }) => auth.listTokens()[0]?.id as string);
    expect(await mooncg('token', 'revoke', id)).toBe(0);
    await inspect(({ auth }) => expect(auth.identify({ bearer: secret }).via).toBe('none'));
    expect(await mooncg('token', 'revoke', id)).toBe(1);
  });
});

describe('mooncg', () => {
  it('prints the usage for an unknown command or a missing argument', async () => {
    const { mooncg, errors } = await setup();
    expect(await mooncg('user')).toBe(1);
    expect(await mooncg('user', 'create')).toBe(1);
    expect(await mooncg('token', 'nope')).toBe(1);
    expect(errors.every((line) => line.includes('Usage'))).toBe(true);
  });

  it('works on a data directory a server has open, and the server sees the change', async () => {
    const { mooncg, dataDir } = await setup();
    // Stands for the running server: it keeps the database open the whole time.
    const server = await openAccounts(dataDir, { passwordCost: CHEAP });
    try {
      expect(server.auth.setupCode()).toBeDefined();
      expect(await mooncg('user', 'create', 'ada', '--admin', '--password', PASSWORD)).toBe(0);
      expect(server.auth.setupCode()).toBeUndefined();
      expect((await server.auth.login('ada', PASSWORD, 'test')).ok).toBe(true);
    } finally {
      await server.close();
    }
  });
});

describe('mooncg user passwd and tokens', () => {
  it('revokes the tokens of the user, unless told to keep them', async () => {
    const { mooncg, out, inspect } = await setup();
    await mooncg('user', 'create', 'ada', '--admin', '--password', PASSWORD);
    const token = async () => {
      out.length = 0;
      await mooncg('token', 'create', 'OBS', '--user', 'ada', '--grant', '*');
      return out.join('\n').match(/mcg_[A-Za-z0-9_-]+/)?.[0] as string;
    };
    const works = (secret: string) =>
      inspect(({ auth }) => auth.identify({ bearer: secret }).via === 'bearer');

    const kept = await token();
    expect(
      await mooncg('user', 'passwd', 'ada', '--password', 'second password', '--keep-tokens'),
    ).toBe(0);
    expect(await works(kept)).toBe(true);
    out.length = 0;
    expect(await mooncg('user', 'passwd', 'ada', '--password', 'third password')).toBe(0);
    expect(await works(kept)).toBe(false);
    expect(out.join('\n')).toMatch(/tokens/i);
  });
});
