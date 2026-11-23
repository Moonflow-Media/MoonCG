import { Replicant } from '@mooncg/core';
import { describe, expect, it } from 'vitest';
import {
  createPersistence,
  DEBOUNCE_MS,
  MAX_WAIT_MS,
  type Timers,
} from '../src/replicants/persistence.js';
import {
  MemoryReplicantStore,
  type ReplicantStore,
  type StoredReplicant,
} from '../src/storage/replicant-store.js';
import { memoryLogger } from './helpers.js';

/** Hand-driven time: nothing happens until the test calls `advance`. */
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
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = tasks.filter((task) => task.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      tasks = tasks.filter((task) => task !== due);
      now = due.at;
      due.run();
    }
    now = end;
  };
  return { timers, advance, pending: () => tasks.length };
}

/** Lets the promise chain of a timer-triggered save finish. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

function setup(store: ReplicantStore = new MemoryReplicantStore()) {
  const saves: StoredReplicant[][] = [];
  const recording: ReplicantStore = {
    load: (bundle, name) => store.load(bundle, name),
    close: () => store.close(),
    async save(records) {
      saves.push(records.map((record) => ({ ...record })));
      await store.save(records);
    },
  };
  const clock = fakeTimers();
  const { logger, lines } = memoryLogger();
  const persistence = createPersistence({ store: recording, logger, timers: clock.timers });
  const score = new Replicant({ initial: { n: 0 } });
  persistence.track('scoreboard', 'score', score);
  const bump = (rep: Replicant, n: number) =>
    rep.applyOp({ patches: [{ op: 'replace', path: '/n', value: n }] });
  return { persistence, saves, lines, score, bump, ...clock };
}

describe('write-behind persistence', () => {
  it('has the documented timing', () => {
    expect(DEBOUNCE_MS).toBe(250);
    expect(MAX_WAIT_MS).toBe(1000);
  });

  it('saves nothing until the value has been quiet for the debounce time', async () => {
    const { saves, score, bump, advance } = setup();
    bump(score, 1);

    advance(DEBOUNCE_MS - 1);
    await settle();
    expect(saves).toEqual([]);

    advance(1);
    await settle();
    expect(saves).toEqual([[{ bundle: 'scoreboard', name: 'score', rev: 1, value: { n: 1 } }]]);
  });

  it('saves only the latest value of a burst, once', async () => {
    const { saves, score, bump, advance } = setup();
    for (let n = 1; n <= 5; n++) {
      bump(score, n);
      advance(100);
    }
    advance(DEBOUNCE_MS);
    await settle();

    expect(saves).toEqual([[{ bundle: 'scoreboard', name: 'score', rev: 5, value: { n: 5 } }]]);
  });

  it('does not wait longer than the maximum while changes keep coming', async () => {
    const { saves, score, bump, advance } = setup();
    for (let n = 1; n <= 9; n++) {
      bump(score, n);
      advance(100);
    }
    await settle();
    expect(saves).toEqual([]);

    bump(score, 10);
    advance(100);
    await settle();

    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject([{ rev: 10, value: { n: 10 } }]);
  });

  it('starts a new wait after a save', async () => {
    const { saves, score, bump, advance } = setup();
    bump(score, 1);
    advance(DEBOUNCE_MS);
    await settle();

    bump(score, 2);
    advance(DEBOUNCE_MS - 1);
    await settle();
    expect(saves).toHaveLength(1);
    advance(1);
    await settle();

    expect(saves).toHaveLength(2);
  });

  it('writes all changed replicants in one save and leaves unchanged ones alone', async () => {
    const { persistence, saves, score, bump, advance } = setup();
    const other = new Replicant({ initial: { n: 0 } });
    const untouched = new Replicant({ initial: { n: 0 } });
    persistence.track('scoreboard', 'other', other);
    persistence.track('scoreboard', 'untouched', untouched);

    bump(score, 1);
    bump(other, 2);
    advance(DEBOUNCE_MS);
    await settle();

    expect(saves).toHaveLength(1);
    expect(saves[0]?.map((record) => record.name).sort()).toEqual(['other', 'score']);
  });

  it('flushes at once on request and cancels the pending timer', async () => {
    const { persistence, saves, score, bump, advance, pending } = setup();
    bump(score, 1);

    await persistence.flush();

    expect(saves).toHaveLength(1);
    expect(pending()).toBe(0);
    advance(MAX_WAIT_MS);
    await settle();
    expect(saves).toHaveLength(1);
  });

  it('does nothing on flush when nothing changed', async () => {
    const { persistence, saves } = setup();
    await persistence.flush();
    expect(saves).toEqual([]);
  });

  it('saves a changed replicant when it is closed, as on bundle unload', async () => {
    const { saves, score, bump, advance } = setup();
    bump(score, 1);

    score.close();
    await settle();

    expect(saves).toEqual([[{ bundle: 'scoreboard', name: 'score', rev: 1, value: { n: 1 } }]]);
    advance(MAX_WAIT_MS);
    await settle();
    expect(saves).toHaveLength(1);
  });

  it('logs a failed save and tries again with the next flush', async () => {
    const memory = new MemoryReplicantStore();
    let failures = 1;
    const flaky: ReplicantStore = {
      load: (bundle, name) => memory.load(bundle, name),
      close: () => memory.close(),
      async save(records) {
        if (failures-- > 0) throw new Error('disk full');
        await memory.save(records);
      },
    };
    const { persistence, lines, score, bump, advance } = setup(flaky);
    bump(score, 1);
    advance(DEBOUNCE_MS);
    await settle();
    expect(lines).toEqual(['ERROR Could not save 1 replicant(s), retrying in 1 s: disk full']);
    expect(await memory.load('scoreboard', 'score')).toBeUndefined();

    await persistence.flush();

    expect(await memory.load('scoreboard', 'score')).toMatchObject({ rev: 1, value: { n: 1 } });
  });
});

describe('restore', () => {
  it('returns the stored record', async () => {
    const store = new MemoryReplicantStore();
    await store.save([{ bundle: 'b', name: 'n', rev: 4, value: 1 }]);
    const { logger } = memoryLogger();
    const persistence = createPersistence({ store, logger });

    expect(await persistence.restore('b', 'n')).toEqual({
      bundle: 'b',
      name: 'n',
      rev: 4,
      value: 1,
    });
    expect(await persistence.restore('b', 'missing')).toBeUndefined();
  });

  it('logs a warning and returns nothing when the store cannot read the record', async () => {
    const broken: ReplicantStore = {
      load: async () => {
        throw new Error('damaged row');
      },
      save: async () => {},
      close: async () => {},
    };
    const { logger, lines } = memoryLogger();
    const persistence = createPersistence({ store: broken, logger });

    expect(await persistence.restore('b', 'n')).toBeUndefined();
    expect(lines).toEqual(['WARN  Could not read the stored value of "b:n": damaged row']);
  });
});
