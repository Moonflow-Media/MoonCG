// @vitest-environment happy-dom
import type { ConnectionStatus } from '@mooncg/sdk/client';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { App } from '../src/App.js';
import { ApiError, api } from '../src/api.js';
import { live } from '../src/live.js';
import { useLogs } from '../src/stores/logs.js';
import { useSession } from '../src/stores/session.js';

// The shell asks the live connection for changes of the bundle list; no test here has one.
vi.mock('../src/live.js', async (original) => ({
  ...(await original<typeof import('../src/live.js')>()),
  followBundles: () => () => {},
}));

type Listener = (value: unknown) => void;

const panel = (id: string, workspace: string) => ({
  id,
  title: id,
  workspace,
  url: `/b/board/dashboard/${id}.html`,
});
const graphic = (id: string) => ({ id, width: 1920, height: 1080, url: `/b/board/graphics/${id}` });
const BUNDLES = {
  canManage: true,
  bundles: [
    {
      name: 'board',
      state: 'running',
      errors: [],
      panels: [panel('control', 'Show'), panel('timer', 'Show'), panel('clips', 'Replay')],
      graphics: [graphic('overlay'), graphic('studio')],
    },
    { name: 'broken', state: 'failed', errors: ['It broke'], panels: [], graphics: [] },
    { name: 'off', state: 'disabled', errors: [], panels: [], graphics: [] },
  ],
};
const me = (name: string, permissions: string[]) => ({
  user: { id: `user:${name}`, kind: 'user', name },
  roles: [],
  permissions,
});
const line = (id: number, level: string, second: number) => ({
  id,
  time: `2026-01-02T03:04:${String(second).padStart(2, '0')}.000Z`,
  level,
  text: `line ${id}`,
});
const LOG = {
  entries: [line(1, 'info', 1), line(2, 'warn', 2), line(3, 'error', 3), line(4, 'info', 4)],
  last: 4,
};

/** Answers API calls from a table of `METHOD path` to a value or an error. */
function serve(table: Record<string, unknown>) {
  const calls: string[] = [];
  api.request = vi.fn(async (method: string, path: string) => {
    calls.push(`${method} ${path}`);
    const answer = table[`${method} ${path}`];
    if (answer instanceof Error) throw answer;
    if (answer === undefined) throw new ApiError(404, 'not_found', 'Not found');
    return structuredClone(answer);
  }) as typeof api.request;
  return calls;
}

/** Stands in for the live connection: the test says what a replicant holds and how it stands. */
function fakeLive() {
  const followed = new Map<string, Listener>();
  let tell: (status: ConnectionStatus) => void = () => {};
  live.follow = ((name: string, listener: Listener) => {
    followed.set(name, listener);
    return () => followed.delete(name);
  }) as typeof live.follow;
  live.status = (onStatus) => {
    tell = onStatus;
    onStatus('reconnecting');
    return () => {};
  };
  return {
    followed,
    push: (name: string, value: unknown) => followed.get(name)?.(value),
    status: (status: ConnectionStatus) => tell(status),
  };
}

async function show(who: ReturnType<typeof me>, extra: Record<string, unknown> = {}) {
  const calls = serve({ 'GET /api/v1/me': who, 'GET /api/v1/bundles': BUNDLES, ...extra });
  const connection = fakeLive();
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:all(.*)', component: { render: () => null } }],
  });
  const view = mount(App, { global: { plugins: [router] } });
  await flushPromises();
  return { view, calls, ...connection };
}

const admin = me('ada', ['*']);
const viewer = me('vera', ['system:dashboard.view', 'bundle:board:view']);

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the shell', () => {
  it('keeps the parts other code finds it by', async () => {
    const { view } = await show(admin);
    expect(view.find('nav[aria-label="Main"]').exists()).toBe(true);
    expect(view.find('span.user[data-user-name]').text()).toBe('ada');
    expect(view.find('button#logout').text()).toBe('Sign out');
    expect(view.find('.avatar').text()).toBe('A');
    view.unmount();
  });

  it('groups the navigation and labels each group', async () => {
    const { view } = await show(admin);
    const groups = view
      .findAll('nav [data-nav-group]')
      .map((group) => [
        group.find('.nav-label').text(),
        group.findAll('a.nav-item').map((link) => link.attributes('href')),
      ]);
    expect(groups).toEqual([
      ['Workspaces', ['/w/Replay', '/w/Show']],
      ['Show', ['/bundles', '/graphics', '/assets']],
      ['Admin', ['/admin/users', '/admin/roles', '/admin/tokens']],
      ['System', ['/settings', '/logs']],
    ]);
    view.unmount();
  });

  it('shows no label of a group that has no entry for this user', async () => {
    const { view } = await show(viewer);
    expect(view.findAll('.nav-label').map((label) => label.text())).toEqual(['Workspaces', 'Show']);
    expect(view.find('nav').text()).not.toContain('Admin');
    expect(view.find('nav').text()).not.toContain('System');
    view.unmount();
  });

  it('counts the panels of a workspace and the bundles that failed', async () => {
    const { view } = await show(admin);
    expect(view.find('a[href="/w/Show"] .count').text()).toBe('2');
    expect(view.find('a[href="/w/Replay"] .count').text()).toBe('1');
    const failed = view.find('a[href="/bundles"] .count');
    expect(failed.text()).toBe('1');
    expect(failed.classes()).toContain('failed');
    expect(view.find('a[href="/bundles"]').attributes('aria-label')).toBe('Bundles, 1 failed');
    expect(view.find('a[href="/assets"] .count').exists()).toBe(false);
    view.unmount();
  });

  it('counts the graphics that are open right now', async () => {
    const { view, push, followed } = await show(admin);
    // Besides the lists of the graphics, the shell follows the On Air switch.
    expect([...followed.keys()].filter((name) => name.startsWith('board:'))).toEqual([
      'board:$instances.overlay',
      'board:$instances.studio',
    ]);
    expect(view.find('a[href="/graphics"] .count').exists()).toBe(false);

    push('board:$instances.overlay', [
      { id: 'i-1', since: '' },
      { id: 'i-2', since: '' },
    ]);
    push('board:$instances.studio', []);
    await flushPromises();
    const open = view.find('a[href="/graphics"] .count');
    expect(open.text()).toBe('1');
    expect(open.classes()).toContain('live');

    push('board:$instances.overlay', []);
    await flushPromises();
    expect(view.find('a[href="/graphics"] .count').exists()).toBe(false);
    view.unmount();
  });

  it('says how the connection stands', async () => {
    const { view, status } = await show(admin);
    const conn = view.find('.conn');
    // Where it stands when the page loads is shown, not announced; changes are.
    expect(conn.attributes('role')).toBeUndefined();
    expect(conn.attributes('aria-live')).toBeUndefined();
    const said = () => view.find('.sidebar-foot [role="status"]').text();
    expect(said()).toBe('');
    expect(conn.attributes('data-status')).toBe('reconnecting');
    expect(conn.text()).toContain('Reconnecting…');

    status('live');
    await flushPromises();
    expect(conn.attributes('data-status')).toBe('live');
    expect(conn.text()).toContain('Live');
    expect(conn.find('code').text()).toBe(location.host);
    expect(said()).toBe('');

    status('offline');
    await flushPromises();
    expect(conn.attributes('data-status')).toBe('offline');
    expect(conn.text()).toContain('Offline');
    expect(said()).toBe('Offline');
    status('reconnecting');
    await flushPromises();
    expect(said()).toBe('Reconnecting…');
    status('live');
    await flushPromises();
    expect(said()).toBe('Live');
    view.unmount();
  });
});

describe('the count on Logs', () => {
  it('follows the log for whoever may read it, and counts warnings and errors', async () => {
    vi.useFakeTimers();
    const { view, calls } = await show(admin, {
      'GET /api/v1/logs?after=0': LOG,
      'GET /api/v1/logs?after=4': { entries: [line(5, 'warn', 5)], last: 5 },
      'GET /api/v1/logs?after=5': { entries: [], last: 5 },
    });
    const count = () => view.find('a[href="/logs"] .count');
    expect(count().text()).toBe('2');
    expect(count().classes()).toContain('warn');

    await vi.advanceTimersByTimeAsync(2000);
    await flushPromises();
    expect(count().text()).toBe('3');

    view.unmount();
    const before = calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.length).toBe(before);
  });

  it('asks nothing of the log for whoever may not read it', async () => {
    vi.useFakeTimers();
    const { view, calls } = await show(viewer, { 'GET /api/v1/logs?after=0': LOG });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.filter((call) => call.includes('/api/v1/logs'))).toEqual([]);
    expect(view.find('a[href="/logs"]').exists()).toBe(false);
    view.unmount();
  });

  it('asks again only once the answer before is there, and takes no line twice', async () => {
    vi.useFakeTimers();
    const asked: string[] = [];
    const answers: ((answer: unknown) => void)[] = [];
    api.request = vi.fn((_method: string, path: string) => {
      asked.push(path);
      return new Promise((resolve) => answers.push(resolve));
    }) as typeof api.request;
    const logs = useLogs();
    const stop = logs.follow();

    // The server is slow: three rounds of the clock pass before it answers.
    await vi.advanceTimersByTimeAsync(6500);
    expect(asked).toEqual(['/api/v1/logs?after=0']);

    answers[0]?.(structuredClone(LOG));
    await flushPromises();
    expect(logs.entries.map((entry) => entry.id)).toEqual([1, 2, 3, 4]);
    expect(logs.unseen).toBe(2);

    // From then on it asks for what follows, one request at a time.
    await vi.advanceTimersByTimeAsync(2000);
    expect(asked).toEqual(['/api/v1/logs?after=0', '/api/v1/logs?after=4']);
    await vi.advanceTimersByTimeAsync(4000);
    expect(asked).toHaveLength(2);
    answers[1]?.({ entries: [line(5, 'warn', 5)], last: 5 });
    await flushPromises();
    expect(logs.entries.map((entry) => entry.id)).toEqual([1, 2, 3, 4, 5]);
    expect(logs.unseen).toBe(3);

    // A request that fails does not keep the next one from being made.
    api.request = vi.fn(async (_method: string, path: string) => {
      asked.push(path);
      throw new ApiError(503, 'unavailable', 'Not now');
    }) as typeof api.request;
    await vi.advanceTimersByTimeAsync(4000);
    expect(asked.slice(2)).toEqual(['/api/v1/logs?after=5', '/api/v1/logs?after=5']);
    stop();
  });

  it('counts only what was logged since the last visit, per user and across reloads', async () => {
    vi.useFakeTimers();
    const table: Record<string, unknown> = {
      'GET /api/v1/me': admin,
      'GET /api/v1/logs?after=0': LOG,
      'GET /api/v1/logs?after=4': { entries: [], last: 4 },
    };
    serve(table);
    await useSession().load();
    const logs = useLogs();
    const stop = logs.follow();
    await flushPromises();
    expect(logs.unseen).toBe(2);

    // The log page is open: what is there has been seen, and so is what comes in meanwhile.
    const leave = logs.visit();
    expect(logs.unseen).toBe(0);
    table['GET /api/v1/logs?after=4'] = { entries: [line(5, 'error', 5)], last: 5 };
    table['GET /api/v1/logs?after=5'] = { entries: [], last: 5 };
    await vi.advanceTimersByTimeAsync(2000);
    expect(logs.unseen).toBe(0);

    // Left again: only what follows counts.
    leave();
    table['GET /api/v1/logs?after=5'] = { entries: [line(6, 'warn', 6)], last: 6 };
    table['GET /api/v1/logs?after=6'] = { entries: [], last: 6 };
    await vi.advanceTimersByTimeAsync(2000);
    expect(logs.unseen).toBe(1);
    stop();

    // The page is loaded again: the same user still has seen the first five lines.
    const everything = { entries: [...LOG.entries, line(5, 'error', 5), line(6, 'warn', 6)] };
    table['GET /api/v1/logs?after=0'] = { ...everything, last: 6 };
    setActivePinia(createPinia());
    await useSession().load();
    const again = useLogs();
    const stopAgain = again.follow();
    await flushPromises();
    expect(again.unseen).toBe(1);
    stopAgain();

    // Someone else at the same browser has seen none of it.
    table['GET /api/v1/me'] = me('olga', ['*']);
    setActivePinia(createPinia());
    await useSession().load();
    const other = useLogs();
    const stopOther = other.follow();
    await flushPromises();
    expect(other.unseen).toBe(4);
    stopOther();
  });
});
