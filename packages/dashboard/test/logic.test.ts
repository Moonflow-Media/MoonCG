import { describe, expect, it } from 'vitest';
import { arrange, MAX_HEIGHT, MAX_WIDTH, move, resize } from '../src/layout.js';
import { navigation } from '../src/nav.js';
import { holds } from '../src/permissions.js';

describe('holds', () => {
  it('matches a permission against grants with wildcards, part by part', () => {
    expect(holds(['*'], 'system:users.manage')).toBe(true);
    expect(holds(['bundle:*:view'], 'bundle:board:view')).toBe(true);
    expect(holds(['bundle:board:*'], 'bundle:board:operate')).toBe(true);
    expect(holds(['bundle:board:view'], 'bundle:board:operate')).toBe(false);
    expect(holds(['bundle:board:view'], 'system:dashboard.view')).toBe(false);
    expect(holds([], 'system:dashboard.view')).toBe(false);
  });
});

describe('navigation', () => {
  const labels = (permissions: string[], workspaces: string[] = ['Show']) =>
    navigation(permissions, workspaces).map((item) => item.label);

  it('shows an administrator everything, workspaces first', () => {
    expect(navigation(['*'], ['Show', 'Replay']).map((item) => item.to)).toEqual([
      '/w/Show',
      '/w/Replay',
      '/bundles',
      '/graphics',
      '/assets',
      '/admin/users',
      '/admin/roles',
      '/admin/tokens',
      '/settings',
      '/logs',
    ]);
  });

  it('shows only what the permissions allow', () => {
    expect(labels(['system:dashboard.view', 'bundle:board:view'])).toEqual([
      'Show',
      'Bundles',
      'Graphics',
      'Assets',
    ]);
    expect(labels(['system:dashboard.view', 'system:tokens.manage'])).toContain('Tokens');
    expect(labels(['system:dashboard.view', 'system:tokens.manage'])).not.toContain('Users');
    expect(labels(['system:dashboard.view', 'system:users.manage'])).toEqual(
      expect.arrayContaining(['Users', 'Roles']),
    );
    expect(labels(['system:dashboard.view', 'system:logs.view'])).toContain('Logs');
    expect(labels(['system:dashboard.view'])).not.toContain('Settings');
  });

  it('percent-encodes a workspace name in its path', () => {
    expect(navigation(['*'], ['Main show'])[0]).toEqual({
      to: '/w/Main%20show',
      label: 'Main show',
    });
  });
});

describe('arranging panels', () => {
  const panels = [
    { id: 'board:control', width: 3 },
    { id: 'board:timer', width: 20 },
    { id: 'chat:feed', width: undefined },
  ];

  it('starts in manifest order with the manifest width and a default height', () => {
    expect(arrange(panels, undefined)).toEqual([
      { id: 'board:control', w: 3, h: 2 },
      { id: 'board:timer', w: MAX_WIDTH, h: 2 },
      { id: 'chat:feed', w: 3, h: 2 },
    ]);
  });

  it('keeps the saved order and sizes, drops what is gone and appends what is new', () => {
    const saved = [
      { id: 'chat:feed', w: 6, h: 4 },
      { id: 'gone:panel', w: 2, h: 2 },
      { id: 'board:control', w: 4, h: 1 },
    ];
    expect(arrange(panels, saved)).toEqual([
      { id: 'chat:feed', w: 6, h: 4 },
      { id: 'board:control', w: 4, h: 1 },
      { id: 'board:timer', w: MAX_WIDTH, h: 2 },
    ]);
  });

  it('ignores a saved layout that is not one, and repairs sizes out of range', () => {
    expect(arrange(panels, 'nonsense')).toHaveLength(3);
    expect(arrange(panels, [{ id: 'board:control', w: 99, h: -3 }, 7, null])[0]).toEqual({
      id: 'board:control',
      w: MAX_WIDTH,
      h: 1,
    });
  });

  it('moves a panel one place and stops at the ends', () => {
    const list = arrange(panels, undefined);
    const ids = (items: { id: string }[]) => items.map((item) => item.id);
    expect(ids(move(list, 'chat:feed', -1))).toEqual(['board:control', 'chat:feed', 'board:timer']);
    expect(ids(move(list, 'board:control', -1))).toEqual(ids(list));
    expect(ids(move(list, 'chat:feed', 1))).toEqual(ids(list));
    expect(ids(move(list, 'nope', 1))).toEqual(ids(list));
  });

  it('resizes within the grid', () => {
    const list = arrange(panels, undefined);
    expect(resize(list, 'board:control', 1, 1)[0]).toEqual({ id: 'board:control', w: 4, h: 3 });
    expect(resize(list, 'board:control', -9, -9)[0]).toEqual({ id: 'board:control', w: 1, h: 1 });
    expect(resize(list, 'board:control', 99, 99)[0]).toEqual({
      id: 'board:control',
      w: MAX_WIDTH,
      h: MAX_HEIGHT,
    });
  });
});
