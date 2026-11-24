// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api.js';
import { live } from '../src/live.js';
import { useBundles } from '../src/stores/bundles.js';
import { useLayout } from '../src/stores/layout.js';
import { useSession } from '../src/stores/session.js';
import { BundlesView } from '../src/views/Bundles.js';
import { GraphicsView } from '../src/views/Graphics.js';
import { WorkspaceView } from '../src/views/Workspace.js';

const panel = (id: string, workspace?: string) => ({
  id,
  title: `Panel ${id}`,
  width: 3,
  workspace,
  url: `/b/board/dashboard/${id}.html`,
});
const LIST = {
  canManage: false,
  bundles: [
    {
      name: 'board',
      title: 'Board',
      state: 'running',
      version: '1.0.0',
      errors: [],
      panels: [panel('control', 'Show'), panel('timer', 'Show'), panel('notes')],
      graphics: [
        { id: 'overlay', width: 1920, height: 1080, url: '/b/board/graphics/overlay.html' },
      ],
    },
    {
      name: 'broken',
      state: 'failed',
      version: '0.1.0',
      errors: ['It broke'],
      lastError: 'It broke',
      panels: [],
      graphics: [],
    },
  ],
};

/** Answers API calls from a table of `METHOD path` to a value or an error. */
function serve(table: Record<string, unknown>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  api.request = vi.fn(async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    const answer = table[`${method} ${path}`];
    if (answer instanceof Error) throw answer;
    if (answer === undefined) throw new ApiError(404, 'not_found', 'Not found');
    return structuredClone(answer);
  }) as typeof api.request;
  return calls;
}

beforeEach(() => {
  setActivePinia(createPinia());
  // No page of these tests is connected to a server.
  live.follow = () => () => {};
});

describe('the session store', () => {
  it('knows who is signed in and what they may do', async () => {
    serve({
      'GET /api/v1/me': {
        user: { id: 'user:1', kind: 'user', name: 'olga' },
        roles: ['operator'],
        permissions: ['system:dashboard.view', 'bundle:board:*'],
      },
    });
    const session = useSession();
    await session.load();
    expect(session.name).toBe('olga');
    expect(session.can('bundle:board:operate')).toBe(true);
    expect(session.can('system:users.manage')).toBe(false);
  });
});

describe('the bundles store', () => {
  it('lists the workspaces the panels name, with a default for panels that name none', async () => {
    serve({ 'GET /api/v1/bundles': LIST });
    const bundles = useBundles();
    await bundles.refresh();
    expect(bundles.workspaces).toEqual(['Main', 'Show']);
    expect(bundles.panelsOf('Show').map((item) => item.id)).toEqual([
      'board:control',
      'board:timer',
    ]);
    expect(bundles.panelsOf('Main').map((item) => item.id)).toEqual(['board:notes']);
  });

  it('asks the server to change a bundle and keeps what it refused', async () => {
    const calls = serve({
      'GET /api/v1/bundles': LIST,
      'POST /api/v1/bundles/board/reload': { bundle: {} },
      'POST /api/v1/bundles/broken/enable': new ApiError(409, 'conflict', 'It cannot start'),
    });
    const bundles = useBundles();
    await bundles.change('board', 'reload');
    expect(bundles.problem).toBe('');
    await bundles.change('broken', 'enable');
    expect(bundles.problem).toBe('Could not enable "broken": It cannot start');
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(2);
  });
});

describe('the layout store', () => {
  it('loads a saved layout, falls back to the default, and saves changes', async () => {
    const calls = serve({
      'GET /api/v1/me/prefs/layout._53_how': { value: [{ id: 'board:timer', w: 6, h: 3 }] },
      'PUT /api/v1/me/prefs/layout._53_how': null,
    });
    const layout = useLayout();
    const panels = [
      { id: 'board:control', width: 3 },
      { id: 'board:timer', width: 3 },
    ];
    await layout.load('Show', panels);
    expect(layout.of('Show')).toEqual([
      { id: 'board:timer', w: 6, h: 3 },
      { id: 'board:control', w: 3, h: 2 },
    ]);
    await layout.move('Show', 'board:control', -1);
    expect(layout.of('Show').map((item) => item.id)).toEqual(['board:control', 'board:timer']);
    expect(calls.at(-1)).toEqual({
      method: 'PUT',
      path: '/api/v1/me/prefs/layout._53_how',
      body: { value: layout.of('Show') },
    });

    await layout.load('Other one', panels);
    expect(layout.of('Other one').map((item) => item.id)).toEqual(['board:control', 'board:timer']);
    // A key is made of what the server accepts in one.
    expect(calls.some((call) => call.path === '/api/v1/me/prefs/layout._4f_ther_20_one')).toBe(
      true,
    );
  });
});

describe('the workspace view', () => {
  async function show(workspace: string) {
    const calls = serve({
      'GET /api/v1/bundles': LIST,
      'PUT /api/v1/me/prefs/layout._53_how': null,
    });
    await useBundles().refresh();
    const view = mount(WorkspaceView, { props: { workspace } });
    await flushPromises();
    return { view, calls };
  }

  it('frames each panel of the workspace from its own URL', async () => {
    const { view } = await show('Show');
    const frames = view.findAll('iframe');
    expect(frames.map((frame) => frame.attributes('src'))).toEqual([
      '/b/board/dashboard/control.html',
      '/b/board/dashboard/timer.html',
    ]);
    expect(frames[0]?.attributes('title')).toBe('Panel control');
    expect(view.text()).toContain('Panel timer');
  });

  it('moves and resizes a panel and stores the layout', async () => {
    const { view, calls } = await show('Show');
    await view.find('[data-panel="board:timer"] [data-action="left"]').trigger('click');
    await flushPromises();
    expect(view.findAll('[data-panel]').map((item) => item.attributes('data-panel'))).toEqual([
      'board:timer',
      'board:control',
    ]);
    await view.find('[data-panel="board:timer"] [data-action="wider"]').trigger('click');
    await flushPromises();
    expect(view.find('[data-panel="board:timer"]').classes()).toContain('w-4');
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(2);
  });

  it('says so when a workspace has no panel for this user', async () => {
    const { view } = await show('Nowhere');
    expect(view.findAll('iframe')).toHaveLength(0);
    expect(view.text()).toContain('no panel');
  });
});

describe('the bundles view', () => {
  async function show(canManage: boolean) {
    const calls = serve({
      'GET /api/v1/bundles': { ...LIST, canManage },
      'POST /api/v1/bundles/board/reload': { bundle: {} },
    });
    const view = mount(BundlesView);
    await flushPromises();
    return { view, calls };
  }

  it('lists each bundle with its state and last error', async () => {
    const { view } = await show(false);
    const rows = view.findAll('[data-bundle]');
    expect(rows.map((row) => row.attributes('data-bundle'))).toEqual(['board', 'broken']);
    expect(rows[0]?.text()).toContain('running');
    expect(rows[1]?.text()).toContain('failed');
    expect(rows[1]?.text()).toContain('It broke');
  });

  it('offers no button the server would refuse', async () => {
    const { view } = await show(false);
    expect(view.findAll('button')).toHaveLength(0);
  });

  it('lets whoever may manage bundles reload, disable and enable them', async () => {
    const { view, calls } = await show(true);
    const actions = (name: string) =>
      view.findAll(`[data-bundle="${name}"] button`).map((button) => button.text());
    expect(actions('board')).toEqual(['Reload', 'Disable']);
    expect(actions('broken')).toEqual(['Reload', 'Disable']);
    await view.find('[data-bundle="board"] button').trigger('click');
    await flushPromises();
    expect(calls.some((call) => call.path === '/api/v1/bundles/board/reload')).toBe(true);
  });
});

describe('the graphics view', () => {
  it('lists the graphics with their full URL and size', async () => {
    serve({ 'GET /api/v1/bundles': LIST });
    const view = mount(GraphicsView);
    await flushPromises();
    const link = view.find('a');
    expect(link.attributes('href')).toBe('/b/board/graphics/overlay.html');
    expect(view.text()).toContain('1920');
    expect(view.find('input').element.value).toBe(
      `${location.origin}/b/board/graphics/overlay.html`,
    );
    expect(view.find('button').text()).toBe('Copy');
  });
});
