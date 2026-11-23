import { describe, expect, it } from 'vitest';
import { type BundleEvent, type BundleState, nextBundleState } from '../../src/bundle/state.js';
import {
  bundleCapability,
  HTTP_ROUTES_CAPABILITY,
  hasCapability,
} from '../../src/permissions/capabilities.js';

describe('nextBundleState', () => {
  const allowed: [BundleState, BundleEvent, BundleState][] = [
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
  ];

  it.each(allowed)('moves from %s on "%s" to %s', (state, event, next) => {
    expect(nextBundleState(state, event)).toBe(next);
  });

  it('refuses every other combination', () => {
    const states: BundleState[] = [
      'installed',
      'enabling',
      'running',
      'failed',
      'disabling',
      'disabled',
    ];
    const events: BundleEvent[] = ['enable', 'started', 'fail', 'disable', 'stopped'];
    const refused = states.flatMap((state) =>
      events
        .filter((event) => !allowed.some(([from, on]) => from === state && on === event))
        .filter((event) => nextBundleState(state, event) !== undefined)
        .map((event) => `${state} + ${event}`),
    );
    expect(refused).toEqual([]);
    expect(states.length * events.length - allowed.length).toBe(20);
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
