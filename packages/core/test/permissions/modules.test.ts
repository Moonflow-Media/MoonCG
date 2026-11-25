import { describe, expect, it } from 'vitest';
import {
  authorize,
  isGrantPattern,
  MODULES_MANAGE,
  modulePermission,
  SYSTEM_PERMISSIONS,
} from '../../src/index.js';

describe('permissions of modules', () => {
  it('has a permission of its own for managing modules, which only "*" and "system:*" cover', () => {
    expect(MODULES_MANAGE).toBe('system:modules.manage');
    const policy = { roles: { admin: ['*'], bundles: ['system:bundles.manage'] } };
    expect(authorize({ id: 'user:a', roles: ['admin'] }, MODULES_MANAGE, policy)).toBe(true);
    expect(authorize({ id: 'user:b', roles: ['bundles'] }, MODULES_MANAGE, policy)).toBe(false);
  });

  it('says that it lets its holder run code inside the server', () => {
    expect(SYSTEM_PERMISSIONS[MODULES_MANAGE]).toMatch(/^Install, enable and configure modules/);
    expect(SYSTEM_PERMISSIONS[MODULES_MANAGE]).toMatch(/inside the server with full access/);
  });

  it('is covered by no grant but "*", "system:*" and itself', () => {
    const grants = [
      'system:bundles.manage',
      'system:settings.manage',
      'system:users.manage',
      'system:modules.*',
      'system:module.*',
      'bundle:*:*',
      'system:modules',
    ];
    for (const grant of grants) {
      const policy = { roles: { role: [grant] } };
      expect(authorize({ id: 'user:a', roles: ['role'] }, MODULES_MANAGE, policy), grant).toBe(
        false,
      );
    }
    for (const grant of ['*', 'system:*', MODULES_MANAGE]) {
      const policy = { roles: { role: [grant] } };
      expect(authorize({ id: 'user:a', roles: ['role'] }, MODULES_MANAGE, policy), grant).toBe(
        true,
      );
    }
  });

  it('names what a module defines in a namespace no built-in permission is in', () => {
    const permission = modulePermission('auth-oidc', 'link');
    expect(permission).toBe('system:module.auth-oidc.link');
    expect(isGrantPattern(permission)).toBe(true);
    expect(Object.keys(SYSTEM_PERMISSIONS).some((name) => name.startsWith('system:module.'))).toBe(
      false,
    );
  });

  it('refuses a name that could leave the namespace or is no grant', () => {
    for (const name of ['', 'a.b', 'a:b', '*', 'A', 'a__b', '-a', 'a-']) {
      expect(() => modulePermission('auth-oidc', name), name).toThrow();
    }
    expect(() => modulePermission('Auth', 'link')).toThrow();
  });

  it('describes every built-in system permission', () => {
    expect(Object.keys(SYSTEM_PERMISSIONS).sort()).toEqual([
      'system:bundles.manage',
      'system:dashboard.view',
      'system:logs.view',
      'system:modules.manage',
      'system:settings.manage',
      'system:tokens.manage',
      'system:users.manage',
    ]);
  });
});
