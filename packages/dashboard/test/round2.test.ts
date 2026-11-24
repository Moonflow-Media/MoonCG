// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api.js';
import { holds } from '../src/permissions.js';
import { useBundles } from '../src/stores/bundles.js';
import { layoutKey } from '../src/stores/layout.js';
import { LogsView } from '../src/views/Logs.js';
import { RolesView } from '../src/views/Roles.js';
import { TokensView } from '../src/views/Tokens.js';
import { UsersView } from '../src/views/Users.js';
import { WorkspaceView } from '../src/views/Workspace.js';

type Call = { method: string; path: string; body: unknown };
function serve(table: Record<string, unknown>) {
  const calls: Call[] = [];
  api.request = vi.fn(async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    const answer = table[`${method} ${path}`];
    if (answer instanceof Error) throw answer;
    return structuredClone(answer);
  }) as typeof api.request;
  return calls;
}
const deletes = (calls: Call[]) => calls.filter((call) => call.method === 'DELETE');

beforeEach(() => {
  setActivePinia(createPinia());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('holds, the matcher shared with the server', () => {
  it('needs as many parts in a grant as the permission has', () => {
    expect(holds(['bundle:*'], 'bundle:board:view')).toBe(false);
    expect(holds(['*:*:*'], 'system:users.manage')).toBe(false);
    expect(holds(['bundle:board'], 'bundle:board:view')).toBe(false);
    expect(holds(['system:*'], 'system:users.manage')).toBe(true);
    expect(holds(['bundle:*:*'], 'bundle:board:view')).toBe(true);
  });
});

describe('the key a layout is stored under', () => {
  it('is another one for every workspace name', () => {
    const names = ['Show', 'show', 'A b', 'a-b', 'a b', 'a_b', 'a.b', 'A-B', 'Ü', 'ü', 'u', ''];
    const keys = names.map(layoutKey);
    expect(new Set(keys).size).toBe(names.length);
    // Also where the names are too long to be told apart by their beginning.
    const long = 'x'.repeat(80);
    expect(layoutKey(`${long}1`)).not.toBe(layoutKey(`${long}2`));
  });

  it('is always something the server takes as a key', () => {
    for (const name of ['Show', 'A b', 'Ü'.repeat(30), 'x'.repeat(200), '', '../..']) {
      expect(layoutKey(name)).toMatch(/^layout\.[a-z0-9._-]{1,57}$/);
    }
    expect(layoutKey('show')).toBe('layout.show');
  });
});

describe('deleting asks first', () => {
  const pages = [
    [
      'a user',
      UsersView,
      {
        'GET /api/v1/users': { users: [{ id: 'u2', name: 'vera', disabled: false, roles: [] }] },
        'GET /api/v1/roles': { roles: [] },
      },
      '[data-user="vera"] [data-action="delete"]',
      'vera',
    ],
    [
      'a role',
      RolesView,
      { 'GET /api/v1/roles': { roles: [{ name: 'replay', builtin: false, grants: [] }] } },
      '[data-role="replay"] [data-action="delete"]',
      'replay',
    ],
    [
      'a token',
      TokensView,
      {
        'GET /api/v1/tokens': {
          tokens: [{ id: 't1', name: 'OBS', grants: ['*'], expires: null, lastUsed: null }],
        },
      },
      '[data-token="t1"] [data-action="revoke"]',
      'OBS',
    ],
  ] as const;

  it.each(pages)(
    'keeps %s when the question is answered with no',
    async (_what, page, table, button, name) => {
      const confirm = vi.fn(() => false);
      vi.stubGlobal('confirm', confirm);
      const calls = serve(table);
      const view = mount(page);
      await flushPromises();
      await view.find(button).trigger('click');
      await flushPromises();
      expect(confirm).toHaveBeenCalledOnce();
      expect(String(confirm.mock.calls[0])).toContain(name);
      expect(deletes(calls)).toEqual([]);
    },
  );

  it.each(pages)('deletes %s when it is answered with yes', async (_what, page, table, button) => {
    vi.stubGlobal('confirm', () => true);
    const calls = serve(table);
    const view = mount(page);
    await flushPromises();
    await view.find(button).trigger('click');
    await flushPromises();
    expect(deletes(calls)).toHaveLength(1);
  });
});

describe('a layout that cannot be saved', () => {
  it('says so, and stops saying so once saving works again', async () => {
    const table: Record<string, unknown> = {
      'GET /api/v1/bundles': {
        canManage: false,
        bundles: [
          {
            name: 'board',
            state: 'running',
            errors: [],
            graphics: [],
            panels: [{ id: 'control', title: 'Control', width: 3, workspace: 'Show', url: '/x' }],
          },
        ],
      },
      'GET /api/v1/me/prefs/layout._53_how': { value: null },
      'PUT /api/v1/me/prefs/layout._53_how': new ApiError(409, 'conflict', 'Too many preferences'),
    };
    serve(table);
    await useBundles().refresh();
    const view = mount(WorkspaceView, { props: { workspace: 'Show' } });
    await flushPromises();
    expect(view.find('[role="alert"]').exists()).toBe(false);
    await view.find('[data-action="wider"]').trigger('click');
    await flushPromises();
    expect(view.find('[role="alert"]').text()).toContain('Too many preferences');
    // The change still shows; it is only not kept.
    expect(view.find('[data-panel]').classes()).toContain('w-4');
    table['PUT /api/v1/me/prefs/layout._53_how'] = null;
    await view.find('[data-action="wider"]').trigger('click');
    await flushPromises();
    expect(view.find('[role="alert"]').exists()).toBe(false);
  });
});

describe('the logs page', () => {
  const entry = (id: number, level: string, text: string) => ({
    id,
    time: `2026-01-02T03:04:0${id}.000Z`,
    level,
    text,
  });

  it('shows the log, follows it, and filters by level', async () => {
    vi.useFakeTimers();
    const table: Record<string, unknown> = {
      'GET /api/v1/logs?after=0': {
        entries: [entry(1, 'info', 'started'), entry(2, 'warn', 'odd')],
        last: 2,
      },
      'GET /api/v1/logs?after=2': { entries: [entry(3, 'error', 'broke')], last: 3 },
      'GET /api/v1/logs?after=3': { entries: [], last: 3 },
    };
    const calls = serve(table);
    const view = mount(LogsView);
    await flushPromises();
    const lines = () => view.findAll('[data-log]').map((line) => line.text());
    expect(lines()).toHaveLength(2);
    expect(lines()[1]).toContain('odd');
    expect(lines()[1]).toContain('03:04:02');

    await vi.advanceTimersByTimeAsync(2000);
    await flushPromises();
    expect(lines().at(-1)).toContain('broke');
    expect(calls.map((call) => call.path)).toContain('/api/v1/logs?after=2');

    // The filter is a group of radio buttons; each says how many lines it shows.
    const filter = view.find('[role="radiogroup"]');
    expect(filter.attributes('aria-label')).toBe('Show from level');
    expect(filter.findAll('[role="radio"]').map((choice) => choice.text())).toEqual([
      'info 3',
      'warn 2',
      'error 1',
    ]);
    await filter.find('[data-choice="warn"]').trigger('click');
    expect(filter.find('[data-choice="warn"]').attributes('aria-checked')).toBe('true');
    expect(lines().map((line) => line.includes('started'))).toEqual([false, false]);
    expect(lines()).toHaveLength(2);
    await filter.find('[data-choice="error"]').trigger('click');
    expect(lines()).toHaveLength(1);

    view.unmount();
    const before = calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.length).toBe(before);
  });

  it('starts over when the server was restarted and counts its lines from one again', async () => {
    vi.useFakeTimers();
    const line = (id: number, text: string) => ({
      id,
      time: '2026-01-02T03:04:05.000Z',
      level: 'info',
      text,
    });
    const calls = serve({
      'GET /api/v1/logs?after=0': { entries: [line(40, 'before the restart')], last: 40 },
    });
    const view = mount(LogsView);
    await flushPromises();
    const lines = () => view.findAll('[data-log]').map((entry) => entry.text());
    expect(lines()).toHaveLength(1);

    // The restarted server has two lines; the page still asks for what follows line 40.
    serve({
      'GET /api/v1/logs?after=40': { entries: [], last: 2 },
      'GET /api/v1/logs?after=0': { entries: [line(1, 'started'), line(2, 'listening')], last: 2 },
      'GET /api/v1/logs?after=2': { entries: [], last: 2 },
    });
    await vi.advanceTimersByTimeAsync(2000);
    await flushPromises();
    expect(lines()).toHaveLength(2);
    expect(lines()[0]).toContain('started');
    expect(lines().join()).not.toContain('before the restart');
    void calls;
    view.unmount();
  });

  it('says why the log cannot be shown', async () => {
    serve({ 'GET /api/v1/logs?after=0': new ApiError(403, 'forbidden', 'Missing permission') });
    const view = mount(LogsView);
    await flushPromises();
    expect(view.find('[role="alert"]').text()).toContain('Missing permission');
  });
});
