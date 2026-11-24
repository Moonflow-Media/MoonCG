import { holds } from './permissions.js';

export interface NavItem {
  readonly to: string;
  readonly label: string;
}

/** The pages below the workspaces, each with the permission it takes to use it. */
const PAGES: readonly (NavItem & { readonly needs: string })[] = [
  { to: '/bundles', label: 'Bundles', needs: 'system:dashboard.view' },
  { to: '/graphics', label: 'Graphics', needs: 'system:dashboard.view' },
  { to: '/assets', label: 'Assets', needs: 'system:dashboard.view' },
  { to: '/admin/users', label: 'Users', needs: 'system:users.manage' },
  { to: '/admin/roles', label: 'Roles', needs: 'system:users.manage' },
  { to: '/admin/tokens', label: 'Tokens', needs: 'system:tokens.manage' },
  { to: '/settings', label: 'Settings', needs: 'system:settings.manage' },
  { to: '/logs', label: 'Logs', needs: 'system:logs.view' },
];

/** What the navigation shows: the workspaces, then the pages the permissions allow. */
export function navigation(
  permissions: readonly string[],
  workspaces: readonly string[],
): NavItem[] {
  return [
    ...workspaces.map((name) => ({ to: `/w/${encodeURIComponent(name)}`, label: name })),
    ...PAGES.filter((page) => holds(permissions, page.needs)).map(({ to, label }) => ({
      to,
      label,
    })),
  ];
}
