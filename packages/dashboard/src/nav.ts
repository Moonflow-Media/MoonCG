import { holds } from './permissions.js';

/** The groups of the navigation, in the order they are shown. */
export const NAV_GROUPS = ['Workspaces', 'Show', 'Admin', 'System'] as const;
export type NavGroup = (typeof NAV_GROUPS)[number];

/** What a count stands for: something failed, something on air, something to look at. */
export type NavTone = 'failed' | 'live' | 'warn';

export interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly group: NavGroup;
  /** A number shown beside the label. Left out where there is nothing to count. */
  readonly count?: number;
  /** Without one the count is drawn plain. */
  readonly tone?: NavTone;
  /** What the count counts, in words: `2 failed`. */
  readonly hint?: string;
}

/** What the navigation counts. Whatever is left out or zero shows no count. */
export interface NavCounts {
  /** The panels of each workspace, by its name. */
  readonly panels?: Readonly<Record<string, number>>;
  readonly failedBundles?: number;
  /** The graphics that are open somewhere right now. */
  readonly openGraphics?: number;
  /** Warnings and errors logged since the user last looked at the log. */
  readonly unseenLogs?: number;
}

interface Counted {
  readonly count: number;
  readonly tone?: NavTone;
  readonly hint: string;
}

interface Page {
  readonly to: string;
  readonly label: string;
  readonly group: NavGroup;
  readonly needs: string;
  readonly counted?: (counts: NavCounts) => Counted;
}

/** The pages below the workspaces, each with the permission it takes to use it. */
const PAGES: readonly Page[] = [
  {
    to: '/bundles',
    label: 'Bundles',
    group: 'Show',
    needs: 'system:dashboard.view',
    counted: ({ failedBundles: count = 0 }) => ({ count, tone: 'failed', hint: `${count} failed` }),
  },
  {
    to: '/graphics',
    label: 'Graphics',
    group: 'Show',
    needs: 'system:dashboard.view',
    counted: ({ openGraphics: count = 0 }) => ({ count, tone: 'live', hint: `${count} open` }),
  },
  { to: '/assets', label: 'Assets', group: 'Show', needs: 'system:dashboard.view' },
  { to: '/admin/users', label: 'Users', group: 'Admin', needs: 'system:users.manage' },
  { to: '/admin/roles', label: 'Roles', group: 'Admin', needs: 'system:users.manage' },
  { to: '/admin/tokens', label: 'Tokens', group: 'Admin', needs: 'system:tokens.manage' },
  { to: '/settings', label: 'Settings', group: 'System', needs: 'system:settings.manage' },
  { to: '/modules', label: 'Modules', group: 'System', needs: 'system:modules.manage' },
  {
    to: '/logs',
    label: 'Logs',
    group: 'System',
    needs: 'system:logs.view',
    counted: ({ unseenLogs: count = 0 }) => ({
      count,
      tone: 'warn',
      hint: `${count} ${count === 1 ? 'warning or error' : 'warnings or errors'} since your last visit`,
    }),
  },
];

/** An entry with its count, if there is something to count. */
const withCount = (item: NavItem, counted: Counted | undefined): NavItem =>
  counted && counted.count > 0 ? { ...item, ...counted } : item;

/** What the navigation shows: the workspaces, then the pages the permissions allow. */
export function navigation(
  permissions: readonly string[],
  workspaces: readonly string[],
  counts: NavCounts = {},
): NavItem[] {
  return [
    ...workspaces.map((name) => {
      const count = counts.panels?.[name] ?? 0;
      return withCount(
        { to: `/w/${encodeURIComponent(name)}`, label: name, group: 'Workspaces' },
        { count, hint: `${count} ${count === 1 ? 'panel' : 'panels'}` },
      );
    }),
    ...PAGES.filter((page) => holds(permissions, page.needs)).map(({ to, label, group, counted }) =>
      withCount({ to, label, group }, counted?.(counts)),
    ),
  ];
}

export interface NavSection {
  readonly group: NavGroup;
  readonly items: readonly NavItem[];
}

/** The entries by group. A group none of whose entries is shown is left out, label and all. */
export function grouped(items: readonly NavItem[]): NavSection[] {
  return NAV_GROUPS.map((group) => ({
    group,
    items: items.filter((item) => item.group === group),
  })).filter((section) => section.items.length > 0);
}
