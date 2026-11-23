import { describe, expect, it, vi } from 'vitest';
import { MoonCGError } from '../../src/errors.js';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_REQUEST_TIMEOUT_MS,
  MessageBus,
  type Sender,
} from '../../src/messages/bus.js';
import { nest } from '../nest.js';

/** Hand-driven timers: a timeout only fires when the test calls `advance`. */
function fakeTimers() {
  let now = 0;
  let tasks: { at: number; run: () => void }[] = [];
  return {
    timers: {
      setTimeout(run: () => void, ms: number) {
        const task = { at: now + ms, run };
        tasks.push(task);
        return task;
      },
      clearTimeout(handle: unknown) {
        tasks = tasks.filter((task) => task !== handle);
      },
    },
    advance(ms: number) {
      now += ms;
      for (const task of tasks.filter((candidate) => candidate.at <= now)) {
        tasks = tasks.filter((candidate) => candidate !== task);
        task.run();
      }
    },
    pending: () => tasks.length,
  };
}

const sender: Sender = { principal: 'local', bundle: 'scoreboard' };

function setup() {
  const clock = fakeTimers();
  const onError = vi.fn();
  const bus = new MessageBus({ timers: clock.timers, onError });
  const topic = bus.declare('scoreboard', 'reset', { send: 'operate', listen: 'view' });
  bus.declare('scoreboard', 'open', {});
  return { bus, topic, onError, ...clock };
}

describe('MessageBus topics', () => {
  it('declares a topic under its qualified name with mapped permissions', () => {
    const { bus, topic } = setup();
    expect(bus.get('scoreboard:reset')).toBe(topic);
    expect(topic).toMatchObject({
      bundle: 'scoreboard',
      sendPermission: 'bundle:scoreboard:operate',
      listenPermission: 'bundle:scoreboard:view',
    });
    expect(bus.get('scoreboard:open')).toMatchObject({
      sendPermission: 'bundle:scoreboard:access',
      listenPermission: 'bundle:scoreboard:access',
    });
    expect(bus.get('scoreboard:nope')).toBeUndefined();
    expect(() => bus.declare('scoreboard', 'reset', {})).toThrow(/already declared/);
  });

  it('refuses everything on an undeclared topic with not_found', async () => {
    const { bus } = setup();
    const notFound = expect.objectContaining({ code: 'not_found' });
    expect(() => bus.subscribe('scoreboard:nope', () => {})).toThrow(notFound);
    expect(() => bus.publish('scoreboard:nope', 1, sender)).toThrow(notFound);
    expect(() => bus.handle('scoreboard:nope', async () => 1)).toThrow(notFound);
    await expect(bus.request('scoreboard:nope', 1, sender)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('MessageBus.publish', () => {
  it('delivers only to the subscribers of that topic, with the sender', () => {
    const { bus } = setup();
    const onReset = vi.fn();
    const onOpen = vi.fn();
    bus.subscribe('scoreboard:reset', onReset);
    bus.subscribe('scoreboard:open', onOpen);

    bus.publish('scoreboard:reset', { hard: true }, sender);

    expect(onReset).toHaveBeenCalledExactlyOnceWith({ hard: true }, sender);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('stops delivering after unsubscribe and isolates a failing listener', () => {
    const { bus, onError } = setup();
    const failure = new Error('listener failure');
    const first = vi.fn(() => {
      throw failure;
    });
    const second = vi.fn();
    const stop = bus.subscribe('scoreboard:reset', first);
    bus.subscribe('scoreboard:reset', second);

    bus.publish('scoreboard:reset', null, sender);
    stop();
    bus.publish('scoreboard:reset', null, sender);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it.each([
    ['undefined', undefined],
    ['a Date', new Date(0)],
    ['a value nested too deep', nest(65)],
  ])('refuses %s as data with bad_request', (_label, data) => {
    const { bus } = setup();
    expect(() => bus.publish('scoreboard:reset', data as never, sender)).toThrow(
      expect.objectContaining({ code: 'bad_request' }),
    );
  });
});

describe('MessageBus.request', () => {
  it('asks the one handler and resolves with its answer', async () => {
    const { bus, pending } = setup();
    const handler = vi.fn(async (data: unknown) => ({ echoed: data }));
    bus.handle('scoreboard:reset', handler as never);

    await expect(bus.request('scoreboard:reset', 5, sender)).resolves.toEqual({ echoed: 5 });
    expect(handler).toHaveBeenCalledExactlyOnceWith(5, sender, expect.any(Function));
    expect(pending()).toBe(0);
  });

  it('allows one handler per topic', () => {
    const { bus } = setup();
    const stop = bus.handle('scoreboard:reset', async () => 1);
    expect(() => bus.handle('scoreboard:reset', async () => 2)).toThrow(
      expect.objectContaining({ code: 'conflict' }),
    );
    stop();
    expect(() => bus.handle('scoreboard:reset', async () => 2)).not.toThrow();
  });

  it('rejects with not_found when nobody handles the topic', async () => {
    const { bus } = setup();
    await expect(bus.request('scoreboard:reset', 1, sender)).rejects.toMatchObject({
      code: 'not_found',
      message: expect.stringContaining('scoreboard:reset'),
    });
  });

  it('rejects with timeout after the default time, or the one asked for', async () => {
    const { bus, advance } = setup();
    bus.handle('scoreboard:reset', () => new Promise(() => {}));
    const slow = bus.request('scoreboard:reset', 1, sender);
    const quick = bus.request('scoreboard:reset', 1, sender, 100);
    const outcomes: string[] = [];
    slow.catch((error: MoonCGError) => outcomes.push(`slow ${error.code}`));
    quick.catch((error: MoonCGError) => outcomes.push(`quick ${error.code}`));

    advance(100);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(outcomes).toEqual(['quick timeout']);

    advance(DEFAULT_REQUEST_TIMEOUT_MS - 101);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(outcomes).toEqual(['quick timeout']);
    advance(1);
    await expect(slow).rejects.toBeInstanceOf(MoonCGError);
    expect(outcomes).toEqual(['quick timeout', 'slow timeout']);
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(5000);
  });

  it('caps the timeout a caller may ask for', async () => {
    const { bus, advance } = setup();
    bus.handle('scoreboard:reset', () => new Promise(() => {}));
    const request = bus.request('scoreboard:reset', 1, sender, 10 * MAX_REQUEST_TIMEOUT_MS);
    advance(MAX_REQUEST_TIMEOUT_MS);
    await expect(request).rejects.toMatchObject({ code: 'timeout' });
  });

  it('rejects with unavailable when the handler goes away mid-request', async () => {
    const { bus, pending } = setup();
    const stop = bus.handle('scoreboard:reset', () => new Promise(() => {}));
    const request = bus.request('scoreboard:reset', 1, sender);

    stop();

    await expect(request).rejects.toMatchObject({ code: 'unavailable' });
    expect(pending()).toBe(0);
  });

  it('passes on a typed error from the handler and hides any other as internal', async () => {
    const { bus } = setup();
    const stop = bus.handle('scoreboard:reset', async () => {
      throw new MoonCGError('forbidden', 'not you');
    });
    await expect(bus.request('scoreboard:reset', 1, sender)).rejects.toMatchObject({
      code: 'forbidden',
      message: 'not you',
    });
    stop();
    bus.handle('scoreboard:reset', async () => {
      throw new Error('secret stack detail');
    });
    await expect(bus.request('scoreboard:reset', 1, sender)).rejects.toMatchObject({
      code: 'internal',
    });
  });

  it('rejects an answer that is not JSON as internal', async () => {
    const { bus } = setup();
    bus.handle('scoreboard:reset', async () => undefined as never);
    await expect(bus.request('scoreboard:reset', 1, sender)).rejects.toMatchObject({
      code: 'internal',
    });
  });

  it('ignores a late answer after the timeout', async () => {
    const { bus, advance } = setup();
    let answer: (value: number) => void = () => {};
    bus.handle('scoreboard:reset', () => new Promise((resolve) => (answer = resolve)));
    const request = bus.request('scoreboard:reset', 1, sender, 10);

    advance(10);
    answer(1);

    await expect(request).rejects.toMatchObject({ code: 'timeout' });
  });
});

describe('MessageBus.undeclare', () => {
  it('removes a bundle with its topics, listeners and handlers, failing open requests', async () => {
    const { bus } = setup();
    bus.declare('other', 'reset', {});
    const listener = vi.fn();
    bus.subscribe('scoreboard:reset', listener);
    bus.handle('scoreboard:reset', () => new Promise(() => {}));
    const request = bus.request('scoreboard:reset', 1, sender);

    bus.undeclare('scoreboard');

    await expect(request).rejects.toMatchObject({ code: 'unavailable' });
    expect(bus.get('scoreboard:reset')).toBeUndefined();
    expect(bus.get('other:reset')).toBeDefined();
    expect(() => bus.declare('scoreboard', 'reset', {})).not.toThrow();
    bus.publish('scoreboard:reset', 1, sender);
    expect(listener).not.toHaveBeenCalled();
  });

  it('tells subscribers of a removed topic', () => {
    const { bus } = setup();
    const onRemoved = vi.fn();
    bus.subscribe('scoreboard:reset', () => {}, onRemoved);
    bus.undeclare('scoreboard');
    expect(onRemoved).toHaveBeenCalledTimes(1);
  });
});
