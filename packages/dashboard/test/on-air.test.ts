// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { App } from '../src/App.js';
import { ApiError, api } from '../src/api.js';
import { live } from '../src/live.js';
import { useBundles } from '../src/stores/bundles.js';
import { useInstalls } from '../src/stores/installs.js';
import { useOnAir } from '../src/stores/onAir.js';
import { BundlesView } from '../src/views/Bundles.js';
import { GraphicsView } from '../src/views/Graphics.js';

// The shell asks the live connection for changes of the bundle list; no test here has one.
vi.mock('../src/live.js', async (original) => ({
  ...(await original<typeof import('../src/live.js')>()),
  followBundles: () => () => {},
}));

type Listener = (value: unknown) => void;

const ME = { user: { id: 'user:ada', kind: 'user', name: 'ada' }, roles: [], permissions: ['*'] };
const BUNDLES = {
  canManage: true,
  backupsKept: 3,
  bundles: [
    {
      name: 'board',
      title: 'Board',
      state: 'running',
      version: '1.0.0',
      errors: [],
      panels: [],
      graphics: [
        { id: 'overlay', width: 1920, height: 1080, url: '/b/board/graphics/overlay.html' },
      ],
    },
    {
      name: 'stale',
      state: 'running',
      version: '1.0.0',
      errors: [],
      reloadErrors: ['mooncg.json is not valid JSON: Unexpected end of JSON input'],
      pendingChanges: ['dashboard', 'extension'],
      panels: [],
      graphics: [],
    },
    { name: 'off', state: 'disabled', errors: [], panels: [], graphics: [] },
  ],
};

/** Answers API calls from a table of `METHOD path` to a value, an error or a function. */
function serve(table: Record<string, unknown>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  api.request = vi.fn(async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    const answer = table[`${method} ${path}`];
    if (answer instanceof Error) throw answer;
    if (typeof answer === 'function') return answer(body);
    if (answer === undefined) throw new ApiError(404, 'not_found', 'Not found');
    return structuredClone(answer);
  }) as typeof api.request;
  return calls;
}

function fakeLive() {
  const followed = new Map<string, Listener>();
  live.follow = ((name: string, listener: Listener) => {
    followed.set(name, listener);
    return () => followed.delete(name);
  }) as typeof live.follow;
  live.status = (onStatus) => {
    onStatus('live');
    return () => {};
  };
  return { followed, push: (name: string, value: unknown) => followed.get(name)?.(value) };
}

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the On Air switch in the shell', () => {
  async function show(state: unknown, extra: Record<string, unknown> = {}) {
    const calls = serve({
      'GET /api/v1/me': ME,
      'GET /api/v1/bundles': BUNDLES,
      'GET /api/v1/on-air': state,
      ...extra,
    });
    const connection = fakeLive();
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/:all(.*)', component: { render: () => null } }],
    });
    const view = mount(App, { global: { plugins: [router] } });
    await flushPromises();
    return { view, calls, ...connection };
  }

  it('shows that the installation is off air, with a switch for whoever may use it', async () => {
    const { view } = await show({ onAir: false, canSwitch: true });
    const indicator = view.find('[data-on-air]');
    expect(indicator.attributes('data-on-air')).toBe('false');
    expect(indicator.text()).toContain('Off air');
    const button = view.find('button#on-air-switch');
    expect(button.text()).toBe('Go on air');
    expect(button.attributes('aria-pressed')).toBe('false');
    view.unmount();
  });

  it('shows who may not switch that it is on air, and no switch', async () => {
    const { view } = await show({
      onAir: true,
      since: '2026-11-25T10:00:00.000Z',
      canSwitch: false,
    });
    expect(view.find('[data-on-air]').attributes('data-on-air')).toBe('true');
    expect(view.find('[data-on-air]').text()).toContain('On Air');
    expect(view.find('button#on-air-switch').exists()).toBe(false);
    view.unmount();
  });

  it('goes on air at a click and says what that means', async () => {
    const { view, calls } = await show(
      { onAir: false, canSwitch: true },
      { 'PUT /api/v1/on-air': { onAir: true, since: 'now', by: 'ada', canSwitch: true } },
    );

    await view.find('button#on-air-switch').trigger('click');
    await flushPromises();

    expect(calls.find((call) => call.method === 'PUT')).toMatchObject({
      path: '/api/v1/on-air',
      body: { onAir: true },
    });
    expect(view.find('[data-on-air]').attributes('data-on-air')).toBe('true');
    const button = view.find('button#on-air-switch');
    expect(button.text()).toBe('End');
    expect(button.attributes('aria-pressed')).toBe('true');
    expect(view.find('[data-on-air]').attributes('title')).toContain('blocked');
    view.unmount();
  });

  it('asks before it ends On Air while changes wait, since they are applied then', async () => {
    const confirm = vi.fn((_question: string) => false);
    vi.stubGlobal('confirm', confirm);
    const { view, calls } = await show(
      { onAir: true, canSwitch: true },
      { 'PUT /api/v1/on-air': { onAir: false, canSwitch: true } },
    );

    await view.find('button#on-air-switch').trigger('click');
    await flushPromises();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[0]).toContain('stale');
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);

    confirm.mockReturnValue(true);
    await view.find('button#on-air-switch').trigger('click');
    await flushPromises();
    expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({ onAir: false });
    view.unmount();
  });

  it('follows the switch live when someone else uses it', async () => {
    const { view, push } = await show({ onAir: false, canSwitch: false });

    push('system:onAir', { onAir: true, since: 'now' });
    await flushPromises();

    expect(view.find('[data-on-air]').attributes('data-on-air')).toBe('true');
    view.unmount();
  });

  it('says why the switch was refused', async () => {
    const { view } = await show(
      { onAir: false, canSwitch: true },
      { 'PUT /api/v1/on-air': new ApiError(403, 'forbidden', 'Missing permission') },
    );
    await view.find('button#on-air-switch').trigger('click');
    await flushPromises();
    expect(view.find('[role="alert"]').text()).toContain('Missing permission');
    view.unmount();
  });

  it('shows nothing where the server knows no such switch', async () => {
    const { view } = await show(undefined);
    expect(view.find('[data-on-air]').exists()).toBe(false);
    view.unmount();
  });
});

describe('the bundles page and live reload', () => {
  async function show(onAir: boolean, table: Record<string, unknown> = {}) {
    const calls = serve({ 'GET /api/v1/bundles': BUNDLES, ...table });
    fakeLive();
    useOnAir().onAir = onAir;
    const view = mount(BundlesView, { attachTo: document.body });
    await flushPromises();
    const button = (bundle: string, label: string) =>
      view
        .findAll(`[data-bundle="${bundle}"] button`)
        .find((candidate) => candidate.text() === label);
    return { view, calls, button };
  }

  it('says that a bundle was not reloaded and why, while it keeps running', async () => {
    const { view } = await show(false);
    const row = view.find('[data-bundle="stale"]');
    expect(row.find('[data-badge="not-reloaded"]').text()).toBe('not reloaded');
    expect(row.text()).toContain('mooncg.json is not valid JSON');
    expect(row.text()).toContain('keeps running');
    expect(view.find('[data-bundle="board"] [data-badge="not-reloaded"]').exists()).toBe(false);
    view.unmount();
  });

  it('says which changes wait for On Air to end', async () => {
    const { view } = await show(true);
    const badge = view.find('[data-bundle="stale"] [data-badge="pending"]');
    expect(badge.text()).toBe('changes pending');
    expect(badge.attributes('title')).toContain('dashboard, extension');
    expect(view.find('[data-bundle="board"] [data-badge="pending"]').exists()).toBe(false);
    view.unmount();
  });

  it('sends a plain reload while off air', async () => {
    const { view, calls, button } = await show(false, {
      'POST /api/v1/bundles/board/reload': { bundle: {} },
    });
    await button('board', 'Reload')?.trigger('click');
    await flushPromises();
    expect(calls.find((call) => call.method === 'POST')?.body).toBeUndefined();
    view.unmount();
  });

  it.each(['Reload', 'Disable'])(
    'asks before it does "%s" while on air, and does nothing on a no',
    async (label) => {
      const confirm = vi.fn((_question: string) => false);
      vi.stubGlobal('confirm', confirm);
      const action = label.toLowerCase();
      const { view, calls, button } = await show(true, {
        [`POST /api/v1/bundles/board/${action}`]: { bundle: {} },
      });

      await button('board', label)?.trigger('click');
      await flushPromises();
      expect(confirm.mock.calls[0]?.[0]).toContain('on air');
      expect(calls.some((call) => call.method === 'POST')).toBe(false);

      confirm.mockReturnValue(true);
      await button('board', label)?.trigger('click');
      await flushPromises();
      expect(calls.find((call) => call.method === 'POST')).toMatchObject({
        path: `/api/v1/bundles/board/${action}`,
        body: { forceOnAir: true },
      });
      view.unmount();
    },
  );

  it('enables a bundle while on air without asking', async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    const { view, calls, button } = await show(true, {
      'POST /api/v1/bundles/off/enable': { bundle: {} },
    });
    await button('off', 'Enable')?.trigger('click');
    await flushPromises();
    expect(confirm).not.toHaveBeenCalled();
    expect(calls.find((call) => call.method === 'POST')?.body).toBeUndefined();
    view.unmount();
  });

  it('removes while on air only after both questions were answered with yes, overriding the lock and nothing else', async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    const { view, calls, button } = await show(true, {
      'POST /api/v1/bundles/board/remove': { job: { id: 'j1', state: 'queued' } },
    });

    await button('board', 'Remove')?.trigger('click');
    await flushPromises();

    expect(confirm).toHaveBeenCalledTimes(2);
    // Not `force`: that would also take the bundle away from under the ones that need it,
    // which nobody was asked about.
    expect(calls.find((call) => call.path.endsWith('/remove'))?.body).toEqual({
      forceOnAir: true,
    });
    view.unmount();
  });

  it('says on the page that changes are blocked while on air', async () => {
    const { view } = await show(true);
    expect(view.find('[data-on-air-note]').text()).toContain('On Air');
    view.unmount();
    const off = await show(false);
    expect(off.view.find('[data-on-air-note]').exists()).toBe(false);
    off.view.unmount();
  });
});

describe('what the stores send while on air', () => {
  it('overrides the lock for a change of state only when asked', async () => {
    const calls = serve({
      'GET /api/v1/bundles': BUNDLES,
      'POST /api/v1/bundles/board/reload': { bundle: {} },
    });
    const bundles = useBundles();
    await bundles.change('board', 'reload');
    await bundles.change('board', 'reload', true);
    const posts = calls.filter((call) => call.method === 'POST').map((call) => call.body);
    expect(posts).toEqual([undefined, { forceOnAir: true }]);
  });

  it('overrides the lock for committing and removing only when asked, and never for fetching', async () => {
    const job = { job: { id: 'j1', state: 'queued' } };
    const calls = serve({
      'POST /api/v1/bundles/-/stage': job,
      'POST /api/v1/bundles/board/update': job,
      'POST /api/v1/bundles/-/staged/s1/commit': job,
      'POST /api/v1/bundles/board/remove': job,
    });
    const upload = vi.fn(async (_path: string, _file: Blob) => job);
    api.upload = upload as unknown as typeof api.upload;
    const installs = useInstalls();

    await installs.stageGit('https://example.com/a.git', '', 'board');
    await installs.refetch('board');
    await installs.commit('s1', false, true);
    await installs.remove('board', true);
    await installs.stageUpload(new File(['x'], 'a.zip'), 'board');
    await installs.commit('s1', true);
    await installs.remove('board');

    expect(calls.map((call) => call.body)).toEqual([
      { source: { type: 'git', url: 'https://example.com/a.git' }, target: 'board' },
      {},
      { scripts: false, forceOnAir: true },
      { forceOnAir: true },
      { scripts: true },
      {},
    ]);
    expect(upload.mock.calls[0]?.[0]).not.toContain('force');
  });
});

describe('the graphics page and live reload', () => {
  it('marks a page whose files changed as out of date, next to its Reload', async () => {
    serve({
      'GET /api/v1/bundles': BUNDLES,
      'GET /api/v1/bundles/board/instances': { instances: [] },
    });
    const { push } = fakeLive();
    const view = mount(GraphicsView, { attachTo: document.body });
    await flushPromises();

    push('board:$instances.overlay', [
      { id: 'i-1', since: '2026-11-25T10:00:00.000Z', outOfDate: true },
      { id: 'i-2', since: '2026-11-25T10:00:00.000Z' },
    ]);
    await flushPromises();

    const stale = view.find('[data-instance="i-1"]');
    expect(stale.find('[data-badge="out-of-date"]').text()).toBe('Out of date');
    expect(stale.find('[data-badge="out-of-date"]').attributes('title')).toContain('Reload');
    expect(stale.find('button[data-action="reload"]').exists()).toBe(true);
    expect(view.find('[data-instance="i-2"] [data-badge="out-of-date"]').exists()).toBe(false);
    view.unmount();
  });
});
