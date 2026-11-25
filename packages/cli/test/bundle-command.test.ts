import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PASSWORD, startAuthServer } from '../../server/test/auth-helpers.js';
import { manifest, temporaryBundles } from '../../server/test/temp-bundles.js';
import { zipOf } from '../../server/test/zip-writer.js';
import { type CliIo, run } from '../src/cli.js';

const temporary = temporaryBundles();
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  await temporary.cleanup();
});

type Files = Readonly<Record<string, string | object>>;
const ticker = (version: string, extra: object = {}): Files => ({
  'mooncg.json': manifest('ticker', {
    version,
    title: 'Ticker',
    permissions: { view: 'See the ticker' },
    capabilities: ['http.routes'],
    panels: [{ id: 'lines', title: 'Lines', file: 'dashboard/lines.html' }],
    ...extra,
  }),
  'dashboard/lines.html': `<p>ticker ${version}</p>`,
});

/** A running server, a token that may manage bundles, and the command line pointed at it. */
async function setup(config: Parameters<typeof startAuthServer>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mooncg-cli-bundle-'));
  const context = await startAuthServer(
    temporary,
    { dataDir: join(root, 'data'), ...config },
    { npmInstall: async () => {} },
  );
  cleanup.push(async () => {
    await context.server.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const { auth, server, base } = context;
  const ada = await auth.createUser({ name: 'ada', password: PASSWORD, roles: ['admin'] });
  const principal = { id: `user:${ada.id}`, kind: 'user' as const, roles: ['admin'] };
  const { secret } = auth.createToken(principal, {
    name: 'cli',
    grants: ['system:bundles.manage'],
  });
  const viewer = auth.createToken(principal, { name: 'look', grants: ['system:dashboard.view'] });

  const out: string[] = [];
  const errors: string[] = [];
  const asked: string[] = [];
  /** What the person at the terminal answers; `undefined` means there is no terminal. */
  const answers: { confirm: boolean | undefined } = { confirm: undefined };
  const io = (): CliIo => ({
    cwd: root,
    env: {},
    log: (line) => out.push(line),
    error: (line) => errors.push(line),
    ...(answers.confirm === undefined
      ? {}
      : {
          confirm: async (question: string) => {
            asked.push(question);
            return answers.confirm === true;
          },
        }),
  });
  const mooncg = (...argv: string[]) =>
    run([...argv, '--url', base, '--token', secret], io(), { pollMs: 10 });
  const folder = async (files: Files, name: string) => {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, name, path)), { recursive: true });
      await writeFile(
        join(root, name, path),
        typeof content === 'string' ? content : JSON.stringify(content),
      );
    }
    return join(root, name);
  };
  const state = (name: string) => {
    const record = server.manager.get(name);
    return record && `${record.state} ${record.manifest?.version}`;
  };
  const printed = () => [...out, ...errors].join('\n');
  return {
    ...context,
    root,
    secret,
    viewer: viewer.secret,
    out,
    errors,
    asked,
    answers,
    io,
    mooncg,
    folder,
    state,
    printed,
  };
}

describe('mooncg bundle list', () => {
  it('lists the bundles with version, state and source', async () => {
    const { mooncg, out, folder } = await setup();
    await mooncg('bundle', 'install', await folder(ticker('1.0.0'), 'ticker-src'), '--yes');
    out.length = 0;

    expect(await mooncg('bundle', 'list')).toBe(0);

    expect(out.find((line) => line.startsWith('board'))).toMatch(/^board\s+1\.0\.0\s+running/);
    expect(out.find((line) => line.startsWith('ticker'))).toMatch(
      /^ticker\s+1\.0\.0\s+running\s+folder .*ticker-src/,
    );
  });
});

describe('mooncg bundle install', () => {
  it('shows what the bundle declares and installs it with --yes', async () => {
    const { mooncg, folder, out, state, printed, secret, asked } = await setup();

    const code = await mooncg('bundle', 'install', await folder(ticker('1.0.0'), 'src'), '--yes');

    expect(printed()).not.toContain('rror');
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/ticker 1\.0\.0/);
    expect(text).toMatch(/permissions: view \(See the ticker\)/);
    expect(text).toMatch(/capabilities: http\.routes/);
    expect(text).toMatch(/server code: no/);
    expect(text).toMatch(/Installed ticker 1\.0\.0/);
    expect(state('ticker')).toBe('running 1.0.0');
    expect(asked).toEqual([]);
    expect(printed()).not.toContain(secret);
  });

  it('resolves a relative folder against the working directory', async () => {
    const { mooncg, folder, state } = await setup();
    await folder(ticker('1.0.0'), 'here/ticker');
    expect(await mooncg('bundle', 'install', 'here/ticker', '--yes')).toBe(0);
    expect(state('ticker')).toBe('running 1.0.0');
  });

  it('asks before installing, and installs nothing on a no', async () => {
    const { mooncg, folder, state, asked, answers, server, out } = await setup();
    answers.confirm = false;

    const code = await mooncg('bundle', 'install', await folder(ticker('1.0.0'), 'src'));

    expect(code).toBe(1);
    expect(asked).toEqual(['Install ticker 1.0.0? [y/N] ']);
    // The summary came before the question.
    expect(out.join('\n')).toMatch(/permissions: view/);
    expect(state('ticker')).toBeUndefined();
    expect(server.installer.staged()).toEqual([]);
  });

  it('installs on a yes', async () => {
    const { mooncg, folder, state, answers } = await setup();
    answers.confirm = true;
    expect(await mooncg('bundle', 'install', await folder(ticker('1.0.0'), 'src'))).toBe(0);
    expect(state('ticker')).toBe('running 1.0.0');
  });

  it('installs nothing where there is nobody to ask, and says how to go on', async () => {
    const { mooncg, folder, state, errors, server } = await setup();
    const code = await mooncg('bundle', 'install', await folder(ticker('1.0.0'), 'src'));
    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(/--yes/);
    expect(state('ticker')).toBeUndefined();
    expect(server.installer.staged()).toEqual([]);
  });

  it('uploads a ZIP file', async () => {
    const { mooncg, root, state, server, out } = await setup();
    await writeFile(join(root, 'ticker-1.3.0.zip'), zipOf(ticker('1.3.0')));

    expect(await mooncg('bundle', 'install', 'ticker-1.3.0.zip', '--yes')).toBe(0);

    expect(state('ticker')).toBe('running 1.3.0');
    expect(await server.installer.sources()).toMatchObject({
      ticker: { type: 'upload', location: 'ticker-1.3.0.zip' },
    });
    expect(out.join('\n')).toMatch(/uploaded archive ticker-1\.3\.0\.zip/);
  });

  it('hands a Git address to the server, with the ref', async () => {
    const { mooncg, errors, state } = await setup();
    // No test reaches the network: the server refuses these before it fetches anything.
    expect(await mooncg('bundle', 'install', 'file:///srv/repo.git', '--yes')).toBe(1);
    expect(errors.join('\n')).toMatch(/Only https:\/\/, ssh:\/\/ and user@host:path/);
    errors.length = 0;
    const code = await mooncg('bundle', 'install', 'https://example.org/r.git', '--ref', 'a..b');
    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(/The ref must be the plain name/);
    expect(state('r')).toBeUndefined();
  });

  it('fails with what the server found wrong with the bundle', async () => {
    const { mooncg, folder, errors } = await setup();
    const bad = { 'mooncg.json': manifest('ticker', { engine: { mooncg: '>=99.0.0' } }) };
    expect(await mooncg('bundle', 'install', await folder(bad, 'bad'), '--yes')).toBe(1);
    expect(errors.join('\n')).toMatch(/engine\.mooncg: needs MoonCG >=99\.0\.0/);
  });

  it('fails for a source that is neither an address nor on this machine', async () => {
    const { mooncg, errors } = await setup();
    expect(await mooncg('bundle', 'install', 'no/such/folder', '--yes')).toBe(1);
    expect(errors.join('\n')).toMatch(/There is no file or folder/);
  });

  it('passes --scripts on, and only then', async () => {
    const { mooncg, folder, lines } = await setup();
    const files = (name: string) => ({
      'mooncg.json': manifest(name),
      'package.json': { dependencies: { 'left-pad': '1.3.0' } },
    });
    await mooncg('bundle', 'install', await folder(files('one'), 'one'), '--yes');
    expect(lines.join('\n')).not.toMatch(/install scripts|run code/);
    await mooncg('bundle', 'install', await folder(files('two'), 'two'), '--yes', '--scripts');
    expect(lines.join('\n')).toMatch(/cli \(token\) allowed two 1\.0\.0 to run code/);
  });
});

describe('mooncg bundle update', () => {
  it('fetches again from where the bundle came from', async () => {
    const { mooncg, folder, state, out } = await setup();
    const path = await folder(ticker('1.0.0'), 'checkout');
    await mooncg('bundle', 'install', path, '--yes');
    await folder(ticker('1.1.0'), 'checkout');
    out.length = 0;

    expect(await mooncg('bundle', 'update', 'ticker', '--yes')).toBe(0);

    expect(state('ticker')).toBe('running 1.1.0');
    expect(out.join('\n')).toMatch(/updates ticker 1\.0\.0/);
    expect(out.join('\n')).toMatch(/Updated ticker to 1\.1\.0/);
  });

  it('takes another source, and asks with both versions', async () => {
    const { mooncg, folder, state, asked, answers } = await setup();
    await mooncg('bundle', 'install', await folder(ticker('1.0.0'), 'one'), '--yes');
    answers.confirm = true;
    expect(await mooncg('bundle', 'update', 'ticker', await folder(ticker('2.0.0'), 'two'))).toBe(
      0,
    );
    expect(asked).toEqual(['Update ticker from 1.0.0 to 2.0.0? [y/N] ']);
    expect(state('ticker')).toBe('running 2.0.0');
  });

  it('fails when the new version does not start, and says that the old one is back', async () => {
    const { mooncg, folder, state, errors } = await setup();
    await mooncg('bundle', 'install', await folder(ticker('1.0.0'), 'one'), '--yes');
    const broken = ticker('2.0.0', { replicants: { lines: { schema: 'schemas/missing.json' } } });

    const code = await mooncg('bundle', 'update', 'ticker', await folder(broken, 'two'), '--yes');

    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(/rolled back/);
    expect(errors.join('\n')).toMatch(/schemas\/missing\.json/);
    expect(state('ticker')).toBe('running 1.0.0');
  });

  it('fails for a bundle that is not installed or of unknown origin', async () => {
    const { mooncg, errors } = await setup();
    expect(await mooncg('bundle', 'update', 'nope', '--yes')).toBe(1);
    expect(await mooncg('bundle', 'update', 'board', '--yes')).toBe(1);
    expect(errors.join('\n')).toMatch(/not known where bundle "board" came from/);
  });
});

describe('mooncg bundle remove', () => {
  it('asks, and removes on a yes', async () => {
    const { mooncg, folder, state, asked, answers, lines } = await setup();
    await mooncg('bundle', 'install', await folder(ticker('1.0.0'), 'one'), '--yes');
    answers.confirm = false;
    expect(await mooncg('bundle', 'remove', 'ticker')).toBe(1);
    expect(state('ticker')).toBe('running 1.0.0');
    expect(asked.at(-1)).toMatch(
      /^Remove ticker\? Its files are kept as a backup and its data is kept\./,
    );

    answers.confirm = true;
    expect(await mooncg('bundle', 'remove', 'ticker')).toBe(0);
    expect(state('ticker')).toBeUndefined();
    expect(lines.join('\n')).toMatch(
      /removed ticker 1\.0\.0 \(files moved to the backups, data kept\)/,
    );
  });

  it('deletes files and data only when told to, and says so in the question', async () => {
    const { mooncg, folder, asked, answers, lines } = await setup();
    await mooncg('bundle', 'install', await folder(ticker('1.0.0'), 'one'), '--yes');
    answers.confirm = true;
    expect(await mooncg('bundle', 'remove', 'ticker', '--delete-files', '--purge-data')).toBe(0);
    expect(asked.at(-1)).toMatch(/files are deleted.*data is deleted/);
    expect(lines.join('\n')).toMatch(/removed ticker 1\.0\.0 \(files deleted, data purged\)/);
  });

  it('fails for a bundle others need, unless forced', async () => {
    const { mooncg, folder, errors, state } = await setup();
    await mooncg('bundle', 'install', await folder(ticker('1.0.0'), 'one'), '--yes');
    const crawl = { 'mooncg.json': manifest('crawl', { dependencies: { ticker: '*' } }) };
    await mooncg('bundle', 'install', await folder(crawl, 'crawl'), '--yes');

    expect(await mooncg('bundle', 'remove', 'ticker', '--yes')).toBe(1);
    expect(errors.join('\n')).toMatch(/needed by crawl/);
    expect(await mooncg('bundle', 'remove', 'ticker', '--yes', '--force')).toBe(0);
    expect(state('ticker')).toBeUndefined();
  });
});

describe('mooncg bundle enable, disable, reload', () => {
  it('changes the state of a bundle', async () => {
    const { mooncg, state, out } = await setup();
    expect(await mooncg('bundle', 'disable', 'board')).toBe(0);
    expect(state('board')).toBe('disabled 1.0.0');
    expect(await mooncg('bundle', 'enable', 'board')).toBe(0);
    expect(state('board')).toBe('running 1.0.0');
    expect(await mooncg('bundle', 'reload', 'board')).toBe(0);
    expect(out).toEqual(['board is disabled', 'board is running', 'board is running']);
  });

  it('fails with what the server said', async () => {
    const { mooncg, errors } = await setup();
    expect(await mooncg('bundle', 'enable', 'nope')).toBe(1);
    expect(await mooncg('bundle', 'enable', 'board')).toBe(1);
    expect(errors.join('\n')).toMatch(/Bundle "board" is running/);
  });
});

describe('mooncg bundle backups and restore', () => {
  it('lists the backups and puts one back', async () => {
    const { mooncg, folder, state, out } = await setup();
    await mooncg('bundle', 'install', await folder(ticker('1.0.0'), 'one'), '--yes');
    await mooncg('bundle', 'update', 'ticker', await folder(ticker('2.0.0'), 'two'), '--yes');
    out.length = 0;

    expect(await mooncg('bundle', 'backups', 'ticker')).toBe(0);
    expect(out).toHaveLength(1);
    const [id = ''] = (out[0] as string).split(/\s+/);
    expect(id).toMatch(/^1\.0\.0-\d{8}T\d{9}Z$/);
    expect(out[0]).toMatch(/update/);

    expect(await mooncg('bundle', 'restore', 'ticker', id, '--yes')).toBe(0);
    expect(state('ticker')).toBe('running 1.0.0');
    expect(await mooncg('bundle', 'restore', 'ticker', id, '--yes')).toBe(1);
  });
});

describe('talking to the server', () => {
  it('needs a token, and says where to give one', async () => {
    const { io, base, errors } = await setup();
    expect(await run(['bundle', 'list', '--url', base], io())).toBe(1);
    expect(errors.join('\n')).toMatch(/--token|MOONCG_TOKEN/);
  });

  it('takes the address and the token from the environment', async () => {
    const { io, base, secret, out, printed } = await setup();
    const fromEnv: CliIo = { ...io(), env: { MOONCG_URL: base, MOONCG_TOKEN: secret } };
    expect(await run(['bundle', 'list'], fromEnv)).toBe(0);
    expect(out.join('\n')).toMatch(/board/);
    expect(printed()).not.toContain(secret);
  });

  it('fails for a token the server does not know, without printing it', async () => {
    const { io, base, errors, printed } = await setup();
    const wrong = 'mcg_0000000000000000000000000000000000000000000';
    expect(await run(['bundle', 'list', '--url', base, '--token', wrong], io())).toBe(1);
    expect(errors.join('\n')).toMatch(/token/i);
    expect(printed()).not.toContain(wrong);
  });

  it('fails for a token that may not manage bundles', async () => {
    const { io, base, viewer, errors, folder, state } = await setup();
    const path = await folder(ticker('1.0.0'), 'one');
    const code = await run(
      ['bundle', 'install', path, '--yes', '--url', base, '--token', viewer],
      io(),
    );
    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(/system:bundles\.manage/);
    expect(state('ticker')).toBeUndefined();
  });

  it('fails when no server answers', async () => {
    const { io, secret, errors, printed } = await setup();
    const code = await run(
      ['bundle', 'list', '--url', 'http://127.0.0.1:1', '--token', secret],
      io(),
    );
    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(/No MoonCG server answers at http:\/\/127\.0\.0\.1:1/);
    expect(printed()).not.toContain(secret);
  });

  it('prints the usage for a command line that makes no sense', async () => {
    const { mooncg, errors } = await setup();
    for (const argv of [
      ['bundle'],
      ['bundle', 'frobnicate'],
      ['bundle', 'install'],
      ['bundle', 'install', 'a', 'b'],
      ['bundle', 'update'],
      ['bundle', 'remove'],
      ['bundle', 'enable'],
      ['bundle', 'list', 'extra'],
      ['bundle', 'restore', 'ticker'],
    ]) {
      errors.length = 0;
      expect(await mooncg(...argv)).toBe(1);
      expect(errors.join('\n')).toMatch(/^Usage: mooncg/);
      expect(errors.join('\n')).toMatch(/bundle install/);
    }
  });
});

describe('what the review asked of the command line', () => {
  const steering = {
    'mooncg.json': manifest('steer', {
      permissions: { view: 'See' },
      defaultRoles: { viewer: ['view'] },
    }),
    'package.json': { dependencies: { 'left-pad': '1.3.0' } },
    '.npmrc': 'git=./tools/g.exe',
  };

  it('installs a bundle that steers npm only with --scripts, and says what that means', async () => {
    const { mooncg, folder, errors, out, state } = await setup();
    const path = await folder(steering, 'steer');

    expect(await mooncg('bundle', 'install', path, '--yes')).toBe(1);
    expect(errors.join('\n')).toMatch(/\.npmrc/);
    expect(errors.join('\n')).toMatch(/--scripts/);
    expect(state('steer')).toBeUndefined();

    expect(await mooncg('bundle', 'install', path, '--yes', '--scripts')).toBe(0);
    expect(out.join('\n')).toMatch(/runs code while it is installed: YES.*\.npmrc/);
    expect(state('steer')).toBe('running 1.0.0');
  });

  it('says for an ordinary bundle that installing it runs nothing', async () => {
    const { mooncg, folder, out } = await setup();
    await mooncg('bundle', 'install', await folder(ticker('1.0.0'), 'a'), '--yes');
    expect(out.join('\n')).toMatch(/runs code while it is installed: no/);
  });

  it('shows the role grants a bundle proposes and whether they are made', async () => {
    const { mooncg, folder, out } = await setup();
    const files = { 'mooncg.json': steering['mooncg.json'] };
    await mooncg('bundle', 'install', await folder(files, 'one'), '--yes');
    expect(out.join('\n')).toMatch(/role grants: viewer: view \(granted when it is installed\)/);
    await mooncg('bundle', 'remove', 'steer', '--yes');
    out.length = 0;
    await mooncg('bundle', 'install', await folder(files, 'one'), '--yes');
    expect(out.join('\n')).toMatch(/role grants: viewer: view \(NOT granted: .*installed before/);
  });

  it('says that the files are deleted where the server keeps no backups', async () => {
    const { mooncg, folder, asked, answers } = await setup({ bundleBackupsKept: 0 });
    await mooncg('bundle', 'install', await folder(ticker('1.0.0'), 'a'), '--yes');
    answers.confirm = true;
    expect(await mooncg('bundle', 'remove', 'ticker')).toBe(0);
    expect(asked.at(-1)).toMatch(
      /^Remove ticker\? Its files are deleted \(the server keeps no backups\)/,
    );
  });

  /** A server that answers the list with whatever the test hands it, and notes the calls. */
  function fake(bundles: unknown[]) {
    const calls: string[] = [];
    const answer = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ canManage: true, bundles }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const out: string[] = [];
    const errors: string[] = [];
    const io: CliIo = {
      cwd: tmpdir(),
      env: {},
      log: (line) => out.push(line),
      error: (line) => errors.push(line),
      fetch: answer,
    };
    return { io, calls, out, errors };
  }
  const TOKEN = 'mcg_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  it('prints nothing from the server that could redraw the terminal', async () => {
    const { io, out } = fake([
      {
        name: 'board\u001b[2J\u001b[1;1H',
        version: '1.0.0\u009b31m',
        state: 'running\u0007',
        source: {
          type: 'git',
          location: 'https://example.org/\u001b]0;owned\u0007x.git\r\nfake line',
        },
      },
    ]);
    expect(await run(['bundle', 'list', '--url', 'http://127.0.0.1:9', '--token', TOKEN], io)).toBe(
      0,
    );
    expect(out).toHaveLength(1);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
    expect(out.join('\n')).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    expect(out[0]).toContain('board');
    expect(out[0]).toContain('fake line');
  });

  it('refuses to send the token over plain http to another machine without --insecure', async () => {
    const { io, calls, errors } = fake([]);
    const list = (...more: string[]) => run(['bundle', 'list', '--token', TOKEN, ...more], io);

    expect(await list('--url', 'http://show.example.org:9090')).toBe(1);
    expect(calls).toEqual([]);
    expect(errors.join('\n')).toMatch(/--insecure/);
    expect(errors.join('\n')).toMatch(/http:\/\/show\.example\.org:9090/);
    expect(errors.join('\n')).not.toContain(TOKEN);

    errors.length = 0;
    expect(await list('--url', 'http://show.example.org:9090', '--insecure')).toBe(0);
    expect(calls).toHaveLength(1);
    expect(errors.join('\n')).toMatch(/Warning: .*unencrypted/);
  });

  it.each([
    'http://127.0.0.1:9090',
    'http://localhost:9090',
    'http://[::1]:9090',
    'https://show.example.org',
  ])('sends it to %s without a word', async (url) => {
    const { io, calls, errors } = fake([]);
    expect(await run(['bundle', 'list', '--token', TOKEN, '--url', url], io)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('shows no user name or password of the address in an error', async () => {
    const { io, errors } = await setup();
    const code = await run(
      ['bundle', 'list', '--token', TOKEN, '--url', 'http://ops:hunter2@127.0.0.1:1/'],
      io(),
    );
    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(/127\.0\.0\.1:1/);
    expect(errors.join('\n')).not.toMatch(/hunter2|ops:/);
  });

  it('refuses an address that is none', async () => {
    const { io, errors } = fake([]);
    expect(await run(['bundle', 'list', '--token', TOKEN, '--url', 'not a url'], io)).toBe(1);
    expect(await run(['bundle', 'list', '--token', TOKEN, '--url', 'ftp://x.example'], io)).toBe(1);
    expect(errors.join('\n')).toMatch(/--url/);
  });
});
