import { describe, expect, it } from 'vitest';
import {
  BUNDLE_EVENTS,
  BUNDLE_STATES,
  type BundleEvent,
  type BundleState,
  nextBundleState,
} from '../../src/bundle/state.js';
import {
  bundleCapability,
  HTTP_ROUTES_CAPABILITY,
  hasCapability,
} from '../../src/permissions/capabilities.js';

describe('nextBundleState', () => {
  const allowed: [BundleState, BundleEvent, BundleState][] = [
    ['installing', 'placed', 'installed'],
    ['installing', 'fail', 'removed'],
    ['installed', 'enable', 'enabling'],
    ['installed', 'disable', 'disabling'],
    ['enabling', 'started', 'running'],
    ['enabling', 'fail', 'failed'],
    ['running', 'fail', 'failed'],
    ['running', 'disable', 'disabling'],
    ['failed', 'enable', 'enabling'],
    ['failed', 'disable', 'disabling'],
    ['disabling', 'stopped', 'disabled'],
    ['disabled', 'enable', 'enabling'],
    ['disabled', 'update', 'updating'],
    ['disabled', 'remove', 'removing'],
    ['updating', 'placed', 'installed'],
    ['updating', 'fail', 'failed'],
    ['removing', 'removed', 'removed'],
    ['removing', 'fail', 'failed'],
  ];

  it.each(allowed)('moves from %s on "%s" to %s', (state, event, next) => {
    expect(nextBundleState(state, event)).toBe(next);
  });

  it('refuses every other combination', () => {
    const refused = BUNDLE_STATES.flatMap((state) =>
      BUNDLE_EVENTS.filter((event) => !allowed.some(([from, on]) => from === state && on === event))
        .filter((event) => nextBundleState(state, event) !== undefined)
        .map((event) => `${state} + ${event}`),
    );
    expect(refused).toEqual([]);
    expect(BUNDLE_STATES).toHaveLength(10);
    expect(BUNDLE_EVENTS).toHaveLength(9);
    expect(BUNDLE_STATES.length * BUNDLE_EVENTS.length - allowed.length).toBe(72);
  });

  it('changes the files of a bundle only while nothing of it runs', () => {
    // Updating and removing start from `disabled` alone: whatever ran was stopped first.
    for (const event of ['update', 'remove'] as const) {
      const from = BUNDLE_STATES.filter((state) => nextBundleState(state, event) !== undefined);
      expect(from).toEqual(['disabled']);
    }
  });

  it('ends a removed bundle for good', () => {
    expect(BUNDLE_EVENTS.filter((event) => nextBundleState('removed', event))).toEqual([]);
  });

  it('leaves every state but the last one by some event', () => {
    const stuck = BUNDLE_STATES.filter(
      (state) => !BUNDLE_EVENTS.some((event) => nextBundleState(state, event) !== undefined),
    );
    expect(stuck).toEqual(['removed']);
  });
});

describe('capabilities', () => {
  it('names the capability for access to another bundle', () => {
    expect(bundleCapability('team-data', 'read')).toBe('bundle:team-data:read');
    expect(bundleCapability('team-data', 'write')).toBe('bundle:team-data:write');
    expect(HTTP_ROUTES_CAPABILITY).toBe('http.routes');
  });

  it('matches exactly or through a wildcard segment', () => {
    const capabilities = ['http.routes', 'bundle:team-data:read', 'bundle:*:write'];
    expect(hasCapability(capabilities, 'http.routes')).toBe(true);
    expect(hasCapability(capabilities, 'bundle:team-data:read')).toBe(true);
    expect(hasCapability(capabilities, 'bundle:other:read')).toBe(false);
    expect(hasCapability(capabilities, 'bundle:other:write')).toBe(true);
    expect(hasCapability(capabilities, 'net.outbound')).toBe(false);
    expect(hasCapability([], 'http.routes')).toBe(false);
  });
});
