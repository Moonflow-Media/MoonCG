import { ReplicantRegistry } from '@mooncg/core';
import { afterEach, describe, expect, it } from 'vitest';
import { loadBundles } from '../src/bundles/bundles.js';
import { InlineHost } from '../src/extension-host/inline-host.js';
import { createPersistence } from '../src/replicants/persistence.js';
import { MemoryReplicantStore } from '../src/storage/replicant-store.js';
import { memoryLogger } from './helpers.js';
import { manifest, temporaryBundles } from './temp-bundles.js';

const temporary = temporaryBundles();
afterEach(() => temporary.cleanup());

const scoreSchema = {
  type: 'object',
  properties: { home: { type: 'integer', minimum: 0 } },
  required: ['home'],
  additionalProperties: false,
};

async function load(bundlesDir: string, store = new MemoryReplicantStore()) {
  const registry = new ReplicantRegistry();
  const { logger, lines } = memoryLogger();
  const persistence = createPersistence({ store, logger });
  const bundles = await loadBundles({
    bundlesDir,
    registry,
    host: new InlineHost({ registry, logger }),
    logger,
    persistence,
  });
  const byName = (name: string) => bundles.find((bundle) => bundle.name === name);
  return { bundles, registry, lines, byName, store, persistence };
}

const replace = (value: unknown) => ({
  patches: [{ op: 'replace' as const, path: '', value: value as never }],
});

describe('replicant schemas', () => {
  it('validates every write against the schema file and rejects with invalid', async () => {
    const dir = await temporary.create({
      'game/mooncg.json': manifest('game', {
        replicants: { score: { schema: 'schemas/score.json', default: { home: 0 } } },
      }),
      'game/schemas/score.json': scoreSchema,
    });

    const { registry, byName } = await load(dir);
    const replicant = registry.get('game:score')?.replicant;

    expect(byName('game')).toMatchObject({ state: 'running', errors: [] });
    expect(replicant?.applyOp(replace({ home: 2 }))).toMatchObject({ ok: true, rev: 1 });
    expect(replicant?.applyOp(replace({ home: -1 }))).toEqual({
      ok: false,
      code: 'invalid',
      message: '/home: must be >= 0',
    });
    expect(replicant?.value).toEqual({ home: 2 });
    expect(replicant?.rev).toBe(1);
  });

  it('applies to an extension writing through its handle as well', async () => {
    const dir = await temporary.create({
      'game/mooncg.json': manifest('game', {
        extension: 'extension/index.js',
        replicants: {
          score: { schema: 'schemas/score.json', default: { home: 0 } },
          outcome: {},
        },
      }),
      'game/schemas/score.json': scoreSchema,
      'game/extension/index.js': `
        export default async function start(ctx) {
          const outcome = await ctx.replicant('score').set({ home: 'many' }).then(
            () => 'accepted',
            (error) => error.code + ': ' + error.message,
          );
          await ctx.replicant('outcome').set(outcome);
        }`,
    });

    const { registry } = await load(dir);

    expect(registry.get('game:outcome')?.replicant.value).toBe('invalid: /home: must be integer');
    expect(registry.get('game:score')?.replicant.value).toEqual({ home: 0 });
  });

  it.each([
    ['is missing', undefined, /^replicants\.score\.schema: .*could not be read/i],
    ['is not JSON', '{ "type": ', /^replicants\.score\.schema: .*not valid JSON/i],
    ['does not compile', { type: 'strng' }, /^replicants\.score\.schema: /],
  ])(
    'fails the bundle when the schema file %s, and keeps the others running',
    async (_label, schema, error) => {
      const files: Record<string, string | object> = {
        'game/mooncg.json': manifest('game', {
          replicants: { fine: { default: 1 }, score: { schema: 'schemas/score.json' } },
        }),
        'ok/mooncg.json': manifest('ok', { replicants: { value: { default: 1 } } }),
      };
      if (schema !== undefined) files['game/schemas/score.json'] = schema;
      const dir = await temporary.create(files);

      const { registry, byName } = await load(dir);

      expect(byName('game')?.state).toBe('failed');
      expect(byName('game')?.errors).toHaveLength(1);
      expect(byName('game')?.errors[0]).toMatch(error);
      expect(registry.get('game:fine')).toBeUndefined();
      expect(byName('ok')?.state).toBe('running');
    },
  );

  it('fails the bundle when the default violates the schema', async () => {
    const dir = await temporary.create({
      'game/mooncg.json': manifest('game', {
        replicants: { score: { schema: 'schemas/score.json', default: { home: -5 } } },
      }),
      'game/schemas/score.json': scoreSchema,
    });

    const { byName } = await load(dir);

    expect(byName('game')?.errors).toEqual([
      'replicants.score.default: does not match the schema: /home: must be >= 0',
    ]);
  });

  it('asks for a default when the schema does not accept null', async () => {
    const dir = await temporary.create({
      'game/mooncg.json': manifest('game', { replicants: { score: { schema: 'score.json' } } }),
      'game/score.json': scoreSchema,
    });

    const { byName } = await load(dir);

    expect(byName('game')?.errors[0]).toMatch(/^replicants\.score\.default: .*default/);
  });
});

describe('replicant persistence', () => {
  const files = (extra: object = {}) => ({
    'game/mooncg.json': manifest('game', {
      replicants: {
        score: { schema: 'schemas/score.json', default: { home: 0 }, persistent: true, ...extra },
        volatile: { default: { home: 0 } },
        explicit: { default: { home: 0 }, persistent: false },
      },
    }),
    'game/schemas/score.json': scoreSchema,
  });

  it('stores only replicants marked persistent', async () => {
    const dir = await temporary.create(files());
    const { registry, store, persistence } = await load(dir);

    for (const name of ['score', 'volatile', 'explicit']) {
      registry.get(`game:${name}`)?.replicant.applyOp(replace({ home: 3 }));
    }
    await persistence.flush();

    expect(await store.load('game', 'score')).toEqual({
      bundle: 'game',
      name: 'score',
      rev: 1,
      value: { home: 3 },
    });
    expect(await store.load('game', 'volatile')).toBeUndefined();
    expect(await store.load('game', 'explicit')).toBeUndefined();
  });

  it('starts from the stored value and revision instead of the default', async () => {
    const dir = await temporary.create(files());
    const store = new MemoryReplicantStore();
    await store.save([
      { bundle: 'game', name: 'score', rev: 12, value: { home: 7 } },
      { bundle: 'game', name: 'volatile', rev: 12, value: { home: 7 } },
    ]);

    const { registry, lines } = await load(dir, store);

    expect(registry.get('game:score')?.replicant).toMatchObject({ rev: 12, value: { home: 7 } });
    expect(registry.get('game:volatile')?.replicant).toMatchObject({ rev: 0, value: { home: 0 } });
    expect(lines).toEqual([]);
  });

  it('falls back to the default with a warning when the stored value no longer validates', async () => {
    const dir = await temporary.create(files());
    const store = new MemoryReplicantStore();
    await store.save([{ bundle: 'game', name: 'score', rev: 12, value: { home: 'seven' } }]);

    const { registry, lines, byName } = await load(dir, store);

    expect(byName('game')?.state).toBe('running');
    expect(registry.get('game:score')?.replicant).toMatchObject({ rev: 12, value: { home: 0 } });
    expect(lines).toEqual([
      'WARN  [bundle:game] Stored value of replicant "score" does not match its schema (/home: must be integer); using the default',
    ]);
  });

  it('works without persistence: every replicant starts from its default', async () => {
    const dir = await temporary.create(files());
    const registry = new ReplicantRegistry();
    const { logger } = memoryLogger();

    const bundles = await loadBundles({
      bundlesDir: dir,
      registry,
      host: new InlineHost({ registry, logger }),
      logger,
    });

    expect(bundles[0]?.state).toBe('running');
    expect(registry.get('game:score')?.replicant.value).toEqual({ home: 0 });
  });
});
