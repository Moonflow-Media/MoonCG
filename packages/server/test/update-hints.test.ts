import { ReplicantRegistry } from '@mooncg/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UpdateHint } from '../src/registry/catalog.js';
import { UpdateHints, type UpdatesValue } from '../src/registry/updates.js';
import { memoryLogger } from './helpers.js';

const hint = (kind: UpdateHint['kind'], name: string, available: string): UpdateHint => ({
  kind,
  name,
  installed: '1.0.0',
  available,
  index: { id: 'main', url: 'https://index.example/index.json' },
});

/** Update hints over a registry, worked out from whatever `now` holds when they are asked. */
function setup() {
  const registry = new ReplicantRegistry();
  const now: { hints: UpdateHint[]; basis: unknown } = { hints: [], basis: 'one' };
  let computed = 0;
  const hints = new UpdateHints({
    registry,
    compute: async () => {
      computed += 1;
      return { hints: [...now.hints], basis: now.basis };
    },
    logger: memoryLogger().logger,
  });
  const value = (kind: 'bundles' | 'modules') =>
    registry.get(`system:updates.${kind}`)?.replicant.value as unknown as UpdatesValue;
  return { hints, now, value, computed: () => computed };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the live update hints', () => {
  it('count up only when the hints of their kind changed', async () => {
    const { hints, now, value } = setup();
    await hints.refresh();
    const first = value('bundles').revision;
    const modules = value('modules').revision;

    // Worked out again, to the same: nothing is published.
    await hints.refresh();
    expect(value('bundles').revision).toBe(first);

    now.hints = [hint('bundle', 'board', '1.1.0')];
    await hints.refresh();
    expect(value('bundles')).toEqual({ updates: now.hints, revision: first + 1 });
    // The other kind did not change.
    expect(value('modules').revision).toBe(modules);

    // Equal, though not the same objects.
    now.hints = [hint('bundle', 'board', '1.1.0')];
    await hints.refresh();
    expect(value('bundles').revision).toBe(first + 1);
    hints.close();
  });

  it('count up when the entries or what is installed changed, though the hints did not', async () => {
    // The catalog reads its entries again on that news.
    const { hints, now, value } = setup();
    await hints.refresh();
    const bundles = value('bundles').revision;
    const modules = value('modules').revision;
    now.basis = 'two';
    await hints.refresh();
    expect(value('bundles').revision).toBe(bundles + 1);
    expect(value('modules').revision).toBe(modules + 1);
    hints.close();
  });

  it('take changes that come close together as one', async () => {
    vi.useFakeTimers();
    const { hints, computed } = setup();
    for (let i = 0; i < 5; i++) {
      hints.changed();
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(computed()).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(computed()).toBe(1);
    hints.close();
  });

  it('are worked out at least every 2 s, however steadily changes come', async () => {
    vi.useFakeTimers();
    const { hints, computed } = setup();
    // A change every 50 ms for 5 s: each would put a plain debounce off again.
    for (let i = 0; i < 100; i++) {
      hints.changed();
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(computed()).toBeGreaterThanOrEqual(2);
    expect(computed()).toBeLessThanOrEqual(3);
    hints.close();
  });
});
