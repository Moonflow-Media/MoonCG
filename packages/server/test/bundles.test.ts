import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReplicantRegistry } from '@mooncg/core';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverBundles, loadBundles } from '../src/bundles/bundles.js';
import type { ExtensionHost, ExtensionSpec } from '../src/extension-host/extension-host.js';
import { fixture, memoryLogger } from './helpers.js';

const byName = <T extends { name: string }>(items: readonly T[], name: string) => {
  const item = items.find((candidate) => candidate.name === name);
  if (!item) throw new Error(`No bundle named ${name}`);
  return item;
};

describe('discoverBundles', () => {
  const temporary: string[] = [];
  afterEach(async () => {
    for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('finds every bundle folder, sorted by name, and ignores plain files', async () => {
    const found = await discoverBundles(fixture('bundles'));
    expect(found.map((bundle) => bundle.name)).toEqual([
      'broken',
      'crashy',
      'good',
      'no-manifest',
      'wrong-name',
    ]);
  });

  it('parses a valid manifest', async () => {
    const good = byName(await discoverBundles(fixture('bundles')), 'good');
    expect(good.dir).toBe(fixture('bundles/good'));
    expect(good.errors).toEqual([]);
    expect(good.manifest).toMatchObject({ name: 'good', version: '1.0.0' });
  });

  it('reports the errors of an invalid manifest with their paths', async () => {
    const broken = byName(await discoverBundles(fixture('bundles')), 'broken');
    expect(broken.manifest).toBeUndefined();
    expect(broken.errors).toHaveLength(3);
    expect(broken.errors.join('\n')).toMatch(/^version: /m);
    expect(broken.errors.join('\n')).toMatch(/^graphics\.0\.file: /m);
    expect(broken.errors.join('\n')).toMatch(/^graphics\.0\.width: /m);
  });

  it('reports a missing manifest', async () => {
    const bundle = byName(await discoverBundles(fixture('bundles')), 'no-manifest');
    expect(bundle.errors).toEqual(['mooncg.json not found']);
  });

  it('requires the folder to be named like the bundle', async () => {
    const bundle = byName(await discoverBundles(fixture('bundles')), 'wrong-name');
    expect(bundle.manifest).toBeUndefined();
    expect(bundle.errors).toEqual([
      'name: Bundle "another-name" must live in a folder of the same name',
    ]);
  });

  it('reports a manifest that is not JSON and one that is a module', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mooncg-test-'));
    temporary.push(dir);
    await mkdir(join(dir, 'garbled'));
    await writeFile(join(dir, 'garbled', 'mooncg.json'), '{ "manifest": 1,');
    await mkdir(join(dir, 'auth'));
    await writeFile(
      join(dir, 'auth', 'mooncg.json'),
      JSON.stringify({ manifest: 1, kind: 'module', name: 'auth', version: '1.0.0' }),
    );

    const found = await discoverBundles(dir);

    expect(byName(found, 'garbled').errors[0]).toMatch(/^mooncg\.json is not valid JSON/);
    expect(byName(found, 'auth').errors).toEqual(['kind: Expected a bundle, found a module']);
  });

  it('returns nothing when the bundles directory does not exist', async () => {
    expect(await discoverBundles(fixture('does-not-exist'))).toEqual([]);
  });
});

describe('loadBundles', () => {
  /** An extension host that records what it is asked to start and fails for `crashy`. */
  function fakeHost() {
    const started: ExtensionSpec[] = [];
    const host: ExtensionHost = {
      async start(spec) {
        started.push(spec);
        if (spec.bundle === 'crashy') throw new Error('boom');
      },
      async stop() {},
      onCrash() {},
      stats: () => ({ running: 0, ledger: {}, threads: { started: 0, exited: 0, live: 0 } }),
      async close() {},
    };
    return { host, started };
  }

  async function load() {
    const registry = new ReplicantRegistry();
    const { host, started } = fakeHost();
    const { logger, lines } = memoryLogger();
    const bundles = await loadBundles({ bundlesDir: fixture('bundles'), registry, host, logger });
    return { bundles, registry, started, lines };
  }

  it('runs valid bundles and marks the others failed without stopping', async () => {
    const { bundles } = await load();
    expect(bundles.map((bundle) => [bundle.name, bundle.state])).toEqual([
      ['broken', 'failed'],
      ['crashy', 'failed'],
      ['good', 'running'],
      ['no-manifest', 'failed'],
      ['wrong-name', 'failed'],
    ]);
  });

  it('declares manifest replicants with their default value, or null', async () => {
    const { registry } = await load();
    expect(registry.get('good:score')).toMatchObject({
      readPermission: 'bundle:good:view',
      writePermission: 'bundle:good:operate',
    });
    expect(registry.get('good:score')?.replicant.value).toEqual({ home: 0, away: 0 });
    expect(registry.get('good:greeting')?.replicant.value).toBeNull();
    expect(registry.get('broken:anything')).toBeUndefined();
  });

  it('starts each extension with data-only arguments', async () => {
    const { started } = await load();
    // Bundles that do not depend on each other start at the same time, in no fixed order.
    const byBundle = [...started].sort((a, b) => a.bundle.localeCompare(b.bundle));
    expect(byBundle).toEqual([
      {
        bundle: 'crashy',
        version: '1.0.0',
        entry: fixture('bundles/crashy/extension/index.js'),
        capabilities: [],
        permissions: [],
        config: {},
      },
      {
        bundle: 'good',
        version: '1.0.0',
        entry: fixture('bundles/good/extension/index.js'),
        capabilities: [],
        permissions: ['view', 'operate'],
        config: {},
      },
    ]);
  });

  it('keeps the error of an extension that failed to start', async () => {
    const { bundles, lines } = await load();
    const crashy = byName(bundles, 'crashy');
    expect(crashy.errors).toEqual(['Extension failed to start: boom']);
    expect(crashy.manifest?.name).toBe('crashy');
    expect(lines).toContain('ERROR [bundle:crashy] Extension failed to start: boom');
  });
});
