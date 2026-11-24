import { describe, expect, it } from 'vitest';
import { grantsCover } from '../../src/permissions/authorize.js';

describe('grantsCover', () => {
  it('answers whether one of the grants covers a permission', () => {
    expect(grantsCover(['*'], 'system:users.manage')).toBe(true);
    expect(grantsCover(['bundle:board:view', 'bundle:*:operate'], 'bundle:timer:operate')).toBe(
      true,
    );
    expect(grantsCover(['bundle:board:view'], 'bundle:board:operate')).toBe(false);
    expect(grantsCover(['bundle:*'], 'bundle:board:view')).toBe(false);
    expect(grantsCover([], 'system:dashboard.view')).toBe(false);
  });
});
