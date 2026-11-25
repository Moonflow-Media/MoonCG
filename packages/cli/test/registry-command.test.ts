import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { indexId } from '../../server/src/registry/registry.js';
import { PASSWORD, startAuthServer } from '../../server/test/auth-helpers.js';
import { bytes, json, startHttpFixture } from '../../server/test/http-fixture.js';
import { moduleManifest } from '../../server/test/module-helpers.js';
import { manifest, temporaryBundles } from '../../server/test/temp-bundles.js';
import { zipOf } from '../../server/test/zip-writer.js';
import { printable } from '../src/api-client.js';
import { type CliIo, run } from '../src/cli.js';

const temporary = temporaryBundles();
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  await temporary.cleanup();
});

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const ticker = (version: string) =>
  zipOf({ 'mooncg.json': manifest('ticker', { version, title: 'Ticker' }) });
const greeter = zipOf({
  'mooncg.json': moduleManifest('greeter'),
  'index.js': 'export default function setup() {}\n',
});
const indexOf = (versions: string[]) => ({
  index: 1,
  title: 'Test index',
  entries: [
    {
      name: 'ticker',
      kind: 'bundle',
      title: 'Ticker',
      description: 'Lines along the bottom.',
      tags: ['news'],
      versions: versions.map((version) => ({
        version,
        source: { type: 'zip', url: `ticker-${version}.zip`, sha256: sha256(ticker(version)) },
      })),
    },
    {
      name: 'greeter',
      kind: 'module',
      versions: [
        { version: '1.0.0', source: { type: 'zip', url: 'greeter.zip', sha256: sha256(greeter) } },
      ],
    },
  ],
});

async function setup() {
  const fixture = await startHttpFixture({
    '/index.json': json(indexOf(['1.0.0', '1.1.0'])),
    '/ticker-1.0.0.zip': bytes(ticker('1.0.0')),
    '/ticker-1.1.0.zip': bytes(ticker('1.1.0')),
    '/ticker-1.2.0.zip': bytes(ticker('1.2.0')),
    '/greeter.zip': bytes(greeter),
  });
  const root = await mkdtemp(join(tmpdir(), 'mooncg-cli-registry-'));
  const context = await startAuthServer(temporary, {
    dataDir: join(root, 'data'),
    modulesDir: join(root, 'modules'),
  });
  cleanup.push(async () => {
    await context.server.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const { auth, server } = context;
  await auth.createUser({ name: 'ada', password: PASSWORD, roles: ['admin'] });
  const ada = auth.findUser('ada');
  const principal = { id: `user:${ada?.id}`, kind: 'user' as const, roles: ['admin'] };
  const secret = auth.createToken(principal, { name: 'all', grants: ['*'] }).secret;
  const out: string[] = [];
  const errors: string[] = [];
  const io: CliIo = {
    cwd: root,
    env: {},
    log: (line) => out.push(line),
    error: (line) => errors.push(line),
  };
  const base = `http://127.0.0.1:${server.port}`;
  const mooncg = (argv: string[]) =>
    run([...argv, '--url', base, '--token', secret], io, { pollMs: 10 });
  return {
    ...context,
    fixture,
    out,
    errors,
    mooncg,
    cwd: root,
    indexUrl: `${fixture.url}/index.json`,
  };
}

describe('mooncg registry', () => {
  it('adds, lists, checks and removes indexes', async () => {
    const { mooncg, out, errors, indexUrl } = await setup();
    expect(await mooncg(['registry', 'add', indexUrl]), errors.join()).toBe(0);
    expect(out.at(-1)).toMatch(/Added .*index\.json: ok, 2 entries/);
    out.length = 0;
    expect(await mooncg(['registry', 'list'])).toBe(0);
    expect(out).toEqual([`${indexId(indexUrl)}  ok  ${indexUrl}  added  2 entries`]);
    out.length = 0;
    expect(await mooncg(['registry', 'refresh'])).toBe(0);
    expect(out).toEqual([`${indexId(indexUrl)}  ok  ${indexUrl}  added  2 entries`]);
    expect(await mooncg(['registry', 'remove', indexUrl])).toBe(0);
    out.length = 0;
    await mooncg(['registry', 'list']);
    expect(out).toEqual(['No registry index is set up.']);
  });

  it('searches the catalog and tells about an entry', async () => {
    const { mooncg, out, indexUrl } = await setup();
    await mooncg(['registry', 'add', indexUrl]);
    out.length = 0;
    expect(await mooncg(['registry', 'search', 'news'])).toBe(0);
    expect(out).toEqual(['bundle  ticker  1.1.0  Ticker: Lines along the bottom.']);
    out.length = 0;
    expect(await mooncg(['registry', 'info', 'ticker'])).toBe(0);
    expect(out.join('\n')).toMatch(/ticker \(bundle\) in .*index\.json/);
    expect(out.join('\n')).toMatch(/1\.1\.0.*\n.*1\.0\.0/);
    expect(await mooncg(['registry', 'info', 'nothing'])).toBe(1);
  });

  it('installs a bundle and a module by name, and says what is outdated', async () => {
    const { mooncg, out, errors, indexUrl, fixture, server } = await setup();
    await mooncg(['registry', 'add', indexUrl]);
    expect(await mooncg(['bundle', 'install', 'ticker', '--version', '1.0.0', '--yes'])).toBe(0);
    expect(errors).toEqual([]);
    expect(out.join('\n')).toMatch(/listed as ticker 1\.0\.0 in/);
    expect(out.join('\n')).toMatch(/not checked by MoonCG/);
    expect(server.manager.get('ticker')?.manifest?.version).toBe('1.0.0');

    out.length = 0;
    expect(await mooncg(['bundle', 'outdated'])).toBe(0);
    expect(out).toEqual([`ticker  1.0.0 -> 1.1.0  (${indexUrl})`]);

    // An update without a source takes the newer version from the index.
    fixture.routes.set('/index.json', json(indexOf(['1.0.0', '1.1.0', '1.2.0'])));
    await mooncg(['registry', 'refresh']);
    expect(await mooncg(['bundle', 'update', 'ticker', '--yes'])).toBe(0);
    expect(server.manager.get('ticker')?.manifest?.version).toBe('1.2.0');
    out.length = 0;
    await mooncg(['bundle', 'outdated']);
    expect(out).toEqual(['Everything installed from an index is up to date.']);

    expect(await mooncg(['module', 'install', 'greeter', '--yes'])).toBe(0);
    expect(server.modules.get('greeter')?.enabled).toBe(false);
    out.length = 0;
    expect(await mooncg(['module', 'outdated'])).toBe(0);
    expect(out).toEqual(['Everything installed from an index is up to date.']);

    errors.length = 0;
    expect(await mooncg(['bundle', 'install', 'not-listed', '--yes'])).toBe(1);
    expect(errors.join()).toMatch(/no file or folder "not-listed".*catalog/);
  });

  it('updates from the index something came from, also when another lists the name', async () => {
    const { mooncg, errors, indexUrl, server } = await setup();
    const copy = `${indexUrl}?copy=1`;
    await mooncg(['registry', 'add', indexUrl]);
    await mooncg(['registry', 'add', copy]);
    expect(
      await mooncg([
        'bundle',
        'install',
        'ticker',
        '--version',
        '1.0.0',
        '--index',
        indexId(copy),
        '--yes',
      ]),
      errors.join(),
    ).toBe(0);
    expect(await mooncg(['bundle', 'update', 'ticker', '--yes']), errors.join()).toBe(0);
    expect(server.manager.get('ticker')?.manifest?.version).toBe('1.1.0');
  });

  it('asks for ./name or --index when a name is both a folder here and in the catalog', async () => {
    const { mooncg, errors, indexUrl, cwd, server } = await setup();
    await mooncg(['registry', 'add', indexUrl]);
    await mkdir(join(cwd, 'ticker'));
    expect(await mooncg(['bundle', 'install', 'ticker', '--yes'])).toBe(1);
    expect(errors.join()).toMatch(/\.\/ticker/);
    expect(errors.join()).toMatch(/--index/);
    expect(server.manager.get('ticker')).toBeUndefined();
    errors.length = 0;
    expect(await mooncg(['bundle', 'install', 'ticker', '--index', indexUrl, '--yes'])).toBe(0);
    expect(server.manager.get('ticker')?.manifest?.version).toBe('1.1.0');
  });

  it('warns about a pre-release asked for by name', async () => {
    const { mooncg, out, errors, indexUrl, fixture, server } = await setup();
    fixture.routes.set('/index.json', json(indexOf(['1.0.0', '1.1.0', '1.2.0-beta.1'])));
    fixture.routes.set('/ticker-1.2.0-beta.1.zip', bytes(ticker('1.2.0-beta.1')));
    await mooncg(['registry', 'add', indexUrl]);
    expect(await mooncg(['bundle', 'install', 'ticker', '--version', '1.0.0', '--yes'])).toBe(0);
    out.length = 0;
    expect(
      await mooncg(['bundle', 'update', 'ticker', '--version', '1.2.0-beta.1', '--yes']),
      errors.join(),
    ).toBe(0);
    expect(out.join('\n')).toMatch(/1\.2\.0-beta\.1 is a pre-release/);
    expect(server.manager.get('ticker')?.manifest?.version).toBe('1.2.0-beta.1');
  });
});

describe('printable', () => {
  it('takes out what could change how a line is read', () => {
    expect(printable('a\u202eb\u2066c\u200bd\u2028e\u2029f\u001b[2Jg')).toBe('a b c d e f [2Jg');
  });
});
