import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ReplicantRegistry } from '@mooncg/core';
import { afterEach, describe, expect, it } from 'vitest';
import { BundleManager } from '../src/bundles/manager.js';
import type { ExtensionHost } from '../src/extension-host/extension-host.js';
import { BundleInstaller } from '../src/install/installer.js';
import { memoryLogger } from './helpers.js';
import { manifest } from './temp-bundles.js';

/**
 * What the other tests stand in for: a real fetch from a public Git repository over https,
 * and a real `npm ci` from the npm registry. They need the network, so they run only when
 * asked: `MOONCG_NETWORK_TESTS=1 pnpm test`.
 */

const NETWORK = process.env.MOONCG_NETWORK_TESTS === '1';
/** A tiny public repository that has been there, unchanged, for a long time. It is no bundle. */
const PUBLIC_REPOSITORY = 'https://github.com/octocat/Hello-World.git';
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
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
});
