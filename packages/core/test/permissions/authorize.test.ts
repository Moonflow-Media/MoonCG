import { describe, expect, it } from 'vitest';
import {
  ALLOW_ALL_POLICY,
  ALLOW_ALL_PRINCIPAL,
  authorize,
  bundlePermission,
  type Policy,
} from '../../src/permissions/authorize.js';

const policy: Policy = {
  roles: {
    admin: ['*'],
    operator: ['bundle:scoreboard:view', 'bundle:scoreboard:operate'],
    viewer: ['bundle:*:view'],
    sysop: ['system:bundles.manage', 'bundle:scoreboard:*'],
  },
};
const as = (...roles: string[]) => ({ id: 'u1', roles });

describe('authorize', () => {
  it('grants an exact permission held through a role', () => {
    expect(authorize(as('operator'), 'bundle:scoreboard:operate', policy)).toBe(true);
    expect(authorize(as('sysop'), 'system:bundles.manage', policy)).toBe(true);
  });

  it('denies a permission no role grants', () => {
    expect(authorize(as('operator'), 'bundle:timer:view', policy)).toBe(false);
    expect(authorize(as('operator'), 'system:bundles.manage', policy)).toBe(false);
    expect(authorize(as('sysop'), 'system:users.manage', policy)).toBe(false);
  });

  it('denies principals without roles or with unknown roles', () => {
    expect(authorize(as(), 'bundle:scoreboard:view', policy)).toBe(false);
    expect(authorize(as('ghost'), 'bundle:scoreboard:view', policy)).toBe(false);
  });

  it('lets "*" match every permission', () => {
    expect(authorize(as('admin'), 'bundle:scoreboard:operate', policy)).toBe(true);
    expect(authorize(as('admin'), 'system:users.manage', policy)).toBe(true);
  });

  it('matches a wildcard segment against exactly one segment', () => {
    expect(authorize(as('viewer'), 'bundle:scoreboard:view', policy)).toBe(true);
    expect(authorize(as('viewer'), 'bundle:timer:view', policy)).toBe(true);
    expect(authorize(as('viewer'), 'bundle:timer:operate', policy)).toBe(false);
    expect(authorize(as('viewer'), 'system:logs.view', policy)).toBe(false);
    expect(authorize(as('sysop'), 'bundle:scoreboard:anything', policy)).toBe(true);
    expect(authorize(as('sysop'), 'bundle:timer:anything', policy)).toBe(false);
  });

  it('combines the grants of all roles', () => {
    expect(authorize(as('viewer', 'operator'), 'bundle:scoreboard:operate', policy)).toBe(true);
  });

  it('allows everything for the allow-all principal and policy', () => {
    expect(authorize(ALLOW_ALL_PRINCIPAL, 'system:users.manage', ALLOW_ALL_POLICY)).toBe(true);
    expect(authorize(ALLOW_ALL_PRINCIPAL, 'bundle:x:y', ALLOW_ALL_POLICY)).toBe(true);
  });
});

describe('bundlePermission', () => {
  it('builds the namespaced permission string', () => {
    expect(bundlePermission('scoreboard', 'operate')).toBe('bundle:scoreboard:operate');
  });

  it('falls back to the implicit access permission', () => {
    expect(bundlePermission('scoreboard', undefined)).toBe('bundle:scoreboard:access');
  });
});
