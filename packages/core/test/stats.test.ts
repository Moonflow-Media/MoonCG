import { describe, expect, it } from 'vitest';
import { MessageBus } from '../src/messages/bus.js';
import { ReplicantRegistry } from '../src/replicant/registry.js';

describe('resource counts', () => {
  it('counts the replicants of a registry and the listeners attached to them', () => {
    const registry = new ReplicantRegistry();
    const a = registry.declare('b', 'a', { initial: 1 }).replicant;
    registry.declare('b', 'c', { initial: 1 });
    registry.declare('other', 'a', { initial: 1 });
    const stop = a.onCommit(() => {});
    a.onClose(() => {});
    expect(registry.stats()).toEqual({ replicants: 3, listeners: 2 });

    stop();
    expect(registry.stats()).toEqual({ replicants: 3, listeners: 1 });

    registry.undeclare('b');
    expect(registry.stats()).toEqual({ replicants: 1, listeners: 0 });
    expect(a.listenerCount).toBe(0);
  });

  it('counts the topics of a bus with their listeners, handlers and open requests', async () => {
    const bus = new MessageBus({ timers: { setTimeout, clearTimeout } });
    bus.declare('b', 'x', {});
    bus.declare('b', 'y', {});
    const stopListening = bus.subscribe('b:x', () => {});
    bus.subscribe('b:y', () => {});
    const stopHandling = bus.handle('b:x', () => new Promise(() => {}));
    const open = bus.request('b:x', 1, { principal: 'p', bundle: 'b' });
    open.catch(() => {});
    expect(bus.stats()).toEqual({ topics: 2, listeners: 2, handlers: 1, requests: 1 });

    stopListening();
    stopHandling();
    await open.catch(() => {});
    expect(bus.stats()).toEqual({ topics: 2, listeners: 1, handlers: 0, requests: 0 });

    bus.undeclare('b');
    expect(bus.stats()).toEqual({ topics: 0, listeners: 0, handlers: 0, requests: 0 });
  });
});
