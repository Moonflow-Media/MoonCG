import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ReplicantRegistry } from '@mooncg/core';
import { afterEach, describe, expect, it } from 'vitest';
import { BundleManager } from '../src/bundles/manager.js';
import type { ExtensionHost } from '../src/extension-host/extension-host.js';
import { BundleInstaller } from '../src/install/installer.js';
import { indexId } from '../src/registry/registry.js';
import { PASSWORD, startAuthServer } from './auth-helpers.js';
import { memoryLogger } from './helpers.js';
import { manifest, temporaryBundles } from './temp-bundles.js';

/**
 * What the other tests stand in for: a real fetch from a public Git repository over https
 * (resolved, checked and pinned to the checked address), a real `npm ci` from the npm
 * registry, and a real https index with its archive. They need the network, so they run only when
 * asked: `MOONCG_NETWORK_TESTS=1 pnpm test`.
 */

const NETWORK = process.env.MOONCG_NETWORK_TESTS === '1';
/** A tiny public repository that has been there, unchanged, for a long time. It is no bundle. */
const PUBLIC_REPOSITORY = 'https://github.com/octocat/Hello-World.git';
/**
 * The example index of this repository as GitHub serves it raw: `text/plain`, with the
 * scoreboard archive next to it by a relative path.
 */
const PUBLIC_INDEX =
  'https://raw.githubusercontent.com/Moonflow-Media/MoonCG/main/e2e/registry/index.json';
const temporary = temporaryBundles();
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  await temporary.cleanup();
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'mooncg-network-'));
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const bundlesDir = join(root, 'bundles');
  const dataDir = join(root, 'data');
  await mkdir(bundlesDir, { recursive: true });
  const registry = new ReplicantRegistry();
  const { logger, lines } = memoryLogger();
  const host = {
    start: async () => {},
    stop: async () => {},
    onCrash() {},
    stats: () => ({ running: 0, ledger: {}, threads: { started: 0, exited: 0, live: 0 } }),
    close: async () => {},
  } as unknown as ExtensionHost;
  const manager = new BundleManager({ bundlesDir, registry, host, logger });
  await manager.start();
  // npm and Git as the server runs them: no stand-ins.
  const installer = new BundleInstaller({
    dataDir,
    bundlesDir,
    manager,
    registry,
    logger,
    mooncgVersion: '0.9.0',
  });
  cleanup.push(() => installer.close());
  await installer.start();
  return { root, bundlesDir, installer, manager, lines };
}

describe.skipIf(!NETWORK)('with the network', () => {
  it('fetches a public Git repository over https, and checks it like any other', async () => {
    const { installer } = await setup();
    const job = await installer.settled(
      (
        await installer.stage({
          source: { type: 'git', url: PUBLIC_REPOSITORY, ref: 'master' },
          by: 'test',
        })
      ).id,
    );
    // Cloned, and then refused for what it is: the fetch itself worked.
    expect(job).toMatchObject({ state: 'failed', step: 'validate' });
    expect(job.error).toMatch(/mooncg\.json not found/);
  }, 120_000);

  it('runs a real npm ci for a bundle with one small dependency', async () => {
    const { root, installer, manager, bundlesDir } = await setup();
    const source = join(root, 'source');
    const files: Record<string, string> = {
      'mooncg.json': JSON.stringify(manifest('counter')),
      'package.json': JSON.stringify({
        name: 'counter',
        version: '1.0.0',
        private: true,
        dependencies: { ms: '2.1.3' },
      }),
      'package-lock.json': JSON.stringify({
        name: 'counter',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': { name: 'counter', version: '1.0.0', dependencies: { ms: '2.1.3' } },
          'node_modules/ms': {
            version: '2.1.3',
            resolved: 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz',
            integrity:
              'sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==',
            license: 'MIT',
          },
        },
      }),
    };
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(source, path)), { recursive: true });
      await writeFile(join(source, path), text);
    }
    const staged = await installer.settled(
      (await installer.stage({ source: { type: 'path', path: source }, by: 'test' })).id,
    );
    expect(staged.staged?.npm).toMatchObject({
      needed: true,
      lockfile: true,
      dependencies: ['ms'],
    });
    const done = await installer.settled(
      installer.commit(staged.staged?.id ?? '', { by: 'test' }).id,
    );
    expect(done).toMatchObject({ state: 'succeeded' });
    const installed = join(bundlesDir, 'counter', 'node_modules', 'ms', 'package.json');
    expect(existsSync(installed)).toBe(true);
    expect(JSON.parse(await readFile(installed, 'utf8')).version).toBe('2.1.3');
    expect(manager.get('counter')?.state).toBe('running');
  }, 180_000);

  it('adds a real https index, reads its catalog and installs the scoreboard from it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mooncg-network-index-'));
    const context = await startAuthServer(
      temporary,
      { dataDir: join(root, 'data'), modulesDir: join(root, 'modules') },
      { npmInstall: async () => {} },
    );
    cleanup.push(async () => {
      await context.server.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    const { http, auth, login, server } = context;
    await auth.createUser({ name: 'ada', password: PASSWORD, roles: ['admin'] });
    const cookie = await login('ada');

    // Added through the API, which fetches it at once: a raw GitHub file is `text/plain`.
    const added = await http('POST', '/api/v1/registry/indexes', {
      cookie,
      json: { url: PUBLIC_INDEX },
    });
    expect(added.status, added.text).toBe(201);
    expect(added.json.index, added.text).toMatchObject({ status: 'ok', entries: 1 });
    const listed = await http('GET', '/api/v1/registry/indexes', { cookie });
    expect(listed.json.indexes).toEqual([expect.objectContaining({ url: PUBLIC_INDEX })]);

    const catalog = await http('GET', '/api/v1/registry/catalog?kind=bundle', { cookie });
    expect(catalog.status).toBe(200);
    const entry = catalog.json.entries.find((item: { name: string }) => item.name === 'scoreboard');
    expect(entry.versions[0]).toMatchObject({
      version: '0.1.0',
      compatible: true,
      source: {
        type: 'zip',
        location:
          'https://raw.githubusercontent.com/Moonflow-Media/MoonCG/main/e2e/registry/scoreboard-0.1.0.zip',
      },
    });

    // Staged through the real download, the SHA-256 check and the ZIP checks.
    const stage = await http('POST', '/api/v1/registry/stage', {
      cookie,
      json: { kind: 'bundle', index: indexId(PUBLIC_INDEX), name: 'scoreboard' },
    });
    expect(stage.status, stage.text).toBe(202);
    const staged = await server.installer.settled(stage.json.job.id);
    expect(staged.state, staged.error).toBe('succeeded');
    expect(staged.staged).toMatchObject({ name: 'scoreboard', version: '0.1.0' });

    const commit = await http('POST', `/api/v1/bundles/-/staged/${staged.staged?.id}/commit`, {
      cookie,
      json: {},
    });
    expect(commit.status, commit.text).toBe(202);
    const done = await server.installer.settled(commit.json.job.id);
    expect(done.state, done.error).toBe('succeeded');
    expect(server.manager.get('scoreboard')?.manifest?.version).toBe('0.1.0');
  }, 120_000);
});
