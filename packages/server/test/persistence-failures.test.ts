import { Replicant, ReplicantRegistry } from '@mooncg/core';
import { afterEach, describe, expect, it } from 'vitest';
import { loadBundles } from '../src/bundles/bundles.js';
import { InlineHost } from '../src/extension-host/inline-host.js';
import {
  createPersistence,
  DEBOUNCE_MS,
  MAX_WAIT_MS,
  RETRY_MAX_MS,
  RETRY_MIN_MS,
  type Timers,
} from '../src/replicants/persistence.js';
import { compileSchema, MAX_REPORTED_ERRORS } from '../src/replicants/schema.js';
import { MemoryReplicantStore, type ReplicantStore } from '../src/storage/replicant-store.js';
import { memoryLogger } from './helpers.js';
import { manifest, temporaryBundles } from './temp-bundles.js';

const temporary = temporaryBundles();
afterEach(() => temporary.cleanup());

function fakeTimers() {
  let now = 0;
  let tasks: { at: number; run: () => void }[] = [];
  const timers: Timers = {
    now: () => now,
    setTimeout(run, ms) {
      const task = { at: now + ms, run };
      tasks.push(task);
      return task;
    },
    clearTimeout(handle) {
      tasks = tasks.filter((task) => task !== handle);
    },
  };
  /** Moves time forward, letting each due timer and the save it starts finish in turn. */
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = tasks.filter((task) => task.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      tasks = tasks.filter((task) => task !== due);
      now = due.at;
      due.run();
      await new Promise((resolve) => setImmediate(resolve));
    }
    now = end;
  };
  return { timers, advance, pending: () => tasks.length };
}

/** A store whose first `failures` saves fail. */
function flakyStore(failures: number) {
  const memory = new MemoryReplicantStore();
  let attempts = 0;
  const store: ReplicantStore = {
    load: (bundle, name) => memory.load(bundle, name),
    close: () => memory.close(),
    removeBundle: (bundle) => memory.removeBundle(bundle),
    async save(records) {
      attempts++;
      if (attempts <= failures) throw new Error('disk full');
      await memory.save(records);
    },
  };
  return { store, memory, attempts: () => attempts };
}

function setup(failures: number) {
  const flaky = flakyStore(failures);
  const clock = fakeTimers();
  const { logger, lines } = memoryLogger();
  const persistence = createPersistence({ store: flaky.store, logger, timers: clock.timers });
  const score = new Replicant({ initial: { n: 0 } });
  persistence.track('scoreboard', 'score', score);
  const bump = (n: number) => score.applyOp({ patches: [{ op: 'replace', path: '/n', value: n }] });
  return { ...flaky, ...clock, persistence, lines, bump };
}

describe('retrying a failed save', () => {
  it('has a bounded backoff', () => {
    expect(RETRY_MIN_MS).toBe(1000);
    expect(RETRY_MAX_MS).toBe(30_000);
  });

  it('tries again by itself, although nothing changes any more', async () => {
    const { memory, attempts, advance, bump, lines } = setup(1);
    bump(1);
    await advance(DEBOUNCE_MS);
    expect(attempts()).toBe(1);
    expect(lines).toEqual(['ERROR Could not save 1 replicant(s), retrying in 1 s: disk full']);

    await advance(RETRY_MIN_MS - 1);
    expect(attempts()).toBe(1);
    await advance(1);

    expect(attempts()).toBe(2);
    expect(await memory.load('scoreboard', 'score')).toMatchObject({ rev: 1, value: { n: 1 } });
  });

  it('doubles the wait after each failure, up to the maximum, and stops once it succeeds', async () => {
    const { attempts, advance, bump, pending } = setup(7);
    bump(1);
    await advance(DEBOUNCE_MS);

    const waits: number[] = [];
    for (let attempt = 2; attempt <= 8; attempt++) {
      let waited = 0;
      // Bounded, so a retry that never comes fails the test instead of hanging it.
      while (attempts() < attempt && waited < 2 * RETRY_MAX_MS) {
        await advance(500);
        waited += 500;
      }
      waits.push(waited);
    }

    expect(waits).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
    await advance(RETRY_MAX_MS * 2);
    expect(attempts()).toBe(8);
    expect(pending()).toBe(0);
  });

  it('does not let further changes cut the backoff short, and saves the latest value', async () => {
    const { memory, attempts, advance, bump } = setup(1);
    bump(1);
    await advance(DEBOUNCE_MS);

    bump(2);
    await advance(DEBOUNCE_MS);
    bump(3);
    await advance(DEBOUNCE_MS);
    expect(attempts()).toBe(1);

    await advance(RETRY_MIN_MS);
    expect(attempts()).toBe(2);
    expect(await memory.load('scoreboard', 'score')).toMatchObject({ rev: 3, value: { n: 3 } });
  });

  it('goes back to the normal timing after a successful retry', async () => {
    const { attempts, advance, bump } = setup(1);
    bump(1);
    await advance(DEBOUNCE_MS + RETRY_MIN_MS);
    expect(attempts()).toBe(2);

    bump(2);
    await advance(DEBOUNCE_MS);

    expect(attempts()).toBe(3);
    expect(MAX_WAIT_MS).toBeGreaterThan(DEBOUNCE_MS);
  });
});

describe('a bundle that fails while starting', () => {
  const failing = (body: string) => ({
    'fail/mooncg.json': manifest('fail', {
      extension: 'extension/index.js',
      replicants: { s: { default: 0, persistent: true } },
    }),
    'fail/extension/index.js': `export default async function start(ctx) {\n${body}\n}`,
    'fine/mooncg.json': manifest('fine', {
      extension: 'extension/index.js',
      replicants: { s: { default: 0, persistent: true } },
    }),
    'fine/extension/index.js':
      "export default async function start(ctx) { await ctx.replicant('s').set(7); }",
  });

  async function load(files: Record<string, string | object>, store = new MemoryReplicantStore()) {
    const dir = await temporary.create(files);
    const registry = new ReplicantRegistry();
    const { logger } = memoryLogger();
    const persistence = createPersistence({ store, logger });
    const bundles = await loadBundles({
      bundlesDir: dir,
      registry,
      host: new InlineHost({ registry, logger }),
      logger,
      persistence,
    });
    await persistence.flush();
    return { bundles, store, persistence };
  }

  it('stores nothing the failed extension wrote, but what a successful one wrote at start', async () => {
    const { bundles, store } = await load(
      failing("await ctx.replicant('s').set(42); throw new Error('boom');"),
    );

    expect(bundles.map((bundle) => [bundle.name, bundle.state])).toEqual([
      ['fail', 'failed'],
      ['fine', 'running'],
    ]);
    expect(await store.load('fail', 's')).toBeUndefined();
    expect(await store.load('fine', 's')).toMatchObject({ rev: 1, value: 7 });
  });

  it('stores nothing even when the extension fails after the save delay has passed', async () => {
    const { store } = await load(
      failing(
        `await ctx.replicant('s').set(42);
         await new Promise((resolve) => setTimeout(resolve, ${DEBOUNCE_MS + 150}));
         throw new Error('boom');`,
      ),
    );
    expect(await store.load('fail', 's')).toBeUndefined();
  });

  it('keeps the value stored by an earlier, successful run', async () => {
    const store = new MemoryReplicantStore();
    await store.save([{ bundle: 'fail', name: 's', rev: 3, value: 5 }]);

    await load(failing("await ctx.replicant('s').set(42); throw new Error('boom');"), store);

    expect(await store.load('fail', 's')).toEqual({ bundle: 'fail', name: 's', rev: 3, value: 5 });
  });
});

describe('schema hardening', () => {
  it.each([
    ['at the root', { $async: true, type: 'number' }],
    ['in a definition', { definitions: { n: { $async: true, type: 'number' } }, type: 'number' }],
  ])('refuses an asynchronous schema (%s), which would accept everything', (_label, schema) => {
    expect(() => compileSchema(schema)).toThrow(/\$async/);
  });

  it('reports only the first violations of a value with many', () => {
    const validate = compileSchema({ type: 'array', items: { type: 'number' } });
    const errors = validate(Array.from({ length: 500 }, () => 'x'));

    expect(MAX_REPORTED_ERRORS).toBe(10);
    expect(errors).toHaveLength(11);
    expect(errors?.[0]).toBe('/0: must be number');
    expect(errors?.[9]).toBe('/9: must be number');
    expect(errors?.[10]).toBe('and 490 more');
  });

  it('reports all violations when there are few', () => {
    const validate = compileSchema({ type: 'array', items: { type: 'number' } });
    expect(validate(['x', 1, 'y'])).toEqual(['/0: must be number', '/2: must be number']);
  });
});
