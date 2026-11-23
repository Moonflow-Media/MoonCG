import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ReplicantRegistry } from '@mooncg/core';
import { afterEach, describe, expect, it } from 'vitest';
import { loadBundles } from '../src/bundles/bundles.js';
import type { ExtensionHost } from '../src/extension-host/extension-host.js';
import { InlineHost } from '../src/extension-host/inline-host.js';
import { fixture, memoryLogger } from './helpers.js';
import { manifest, temporaryBundles } from './temp-bundles.js';

const temporary = temporaryBundles();
afterEach(() => temporary.cleanup());

async function load(bundlesDir: string, host?: ExtensionHost) {
  const registry = new ReplicantRegistry();
  const { logger, lines } = memoryLogger();
  const bundles = await loadBundles({
    bundlesDir,
    registry,
    host: host ?? new InlineHost({ registry, logger }),
    logger,
  });
  const byName = (name: string) => bundles.find((bundle) => bundle.name === name);
  return { bundles, registry, lines, byName };
}

describe('start order', () => {
  it('starts a bundle after what it depends on, whatever the folder names', async () => {
    const dir = await temporary.create({
      'alpha/mooncg.json': manifest('alpha', {
        dependencies: { zeta: '*' },
        capabilities: ['bundle:zeta:read'],
        extension: 'extension/index.js',
        replicants: { seen: {} },
      }),
      'alpha/extension/index.js': `
        export default async function start(ctx) {
          const data = ctx.replicant('zeta:data');
          await data.ready;
          await ctx.replicant('seen').set(data.value);
        }`,
      'zeta/mooncg.json': manifest('zeta', { replicants: { data: { default: 'from zeta' } } }),
    });

    const { bundles, registry } = await load(dir);

    expect(bundles.map((bundle) => [bundle.name, bundle.state, bundle.errors])).toEqual([
      ['alpha', 'running', []],
      ['zeta', 'running', []],
    ]);
    expect(registry.get('alpha:seen')?.replicant.value).toBe('from zeta');
  });
});

describe('failed bundles', () => {
  it('removes the replicants of a bundle whose extension failed to start', async () => {
    const { registry, byName } = await load(fixture('bundles'));
    expect(byName('crashy')?.state).toBe('failed');
    expect(registry.get('crashy:state')).toBeUndefined();
    expect(registry.get('good:score')).toBeDefined();
  });

  it('fails a bundle with a replicant default nested beyond the limit', async () => {
    let tooDeep: unknown = 0;
    for (let level = 0; level < 70; level++) tooDeep = [tooDeep];
    const dir = await temporary.create({
      'deep/mooncg.json': manifest('deep', { replicants: { nested: { default: tooDeep } } }),
      'ok/mooncg.json': manifest('ok', { replicants: { value: { default: 1 } } }),
    });

    const { registry, byName } = await load(dir);

    expect(byName('deep')).toMatchObject({ state: 'failed' });
    expect(byName('deep')?.errors[0]).toMatch(/64/);
    expect(registry.get('deep:nested')).toBeUndefined();
    expect(byName('ok')?.state).toBe('running');
  });

  it('fails a bundle whose replicant cannot be declared, and keeps none of its replicants', async () => {
    const dir = await temporary.create({
      'dup/mooncg.json': manifest('dup', { replicants: { first: {}, taken: {}, third: {} } }),
      'ok/mooncg.json': manifest('ok', { replicants: { value: { default: 1 } } }),
    });
    const registry = new ReplicantRegistry();
    registry.declare('dup', 'taken', { initial: 'declared elsewhere' });
    const { logger } = memoryLogger();

    const bundles = await loadBundles({
      bundlesDir: dir,
      registry,
      host: new InlineHost({ registry, logger }),
      logger,
    });

    expect(bundles.map((bundle) => [bundle.name, bundle.state])).toEqual([
      ['dup', 'failed'],
      ['ok', 'running'],
    ]);
    expect(bundles[0]?.errors[0]).toMatch(/^replicants\.taken: .*already declared/);
    expect(registry.get('dup:first')).toBeUndefined();
    expect(registry.get('dup:third')).toBeUndefined();
  });

  it('tells an unreadable manifest apart from a missing one', async () => {
    const dir = await temporary.create({ 'empty/README.txt': 'no manifest here' });
    await mkdir(join(dir, 'odd', 'mooncg.json'), { recursive: true });

    const { byName } = await load(dir);

    expect(byName('empty')?.errors).toEqual(['mooncg.json not found']);
    expect(byName('odd')?.errors).toHaveLength(1);
    expect(byName('odd')?.errors[0]).toMatch(/^mooncg\.json could not be read: /);
  });
});
