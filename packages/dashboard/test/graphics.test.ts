// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api.js';
import { live } from '../src/live.js';
import { GraphicsView } from '../src/views/Graphics.js';

const graphic = (id: string, singleInstance = false) => ({
  id,
  width: 1920,
  height: 1080,
  singleInstance,
  url: `/b/board/graphics/${id}.html`,
});
const bundles = (canManage: boolean) => ({
  canManage,
  bundles: [
    {
      name: 'board',
      title: 'Board',
      state: 'running',
      errors: [],
      panels: [],
      graphics: [graphic('overlay'), graphic('studio', true)],
    },
  ],
});

type Listener = (value: unknown) => void;

/** Stands in for the live connection: the test says what each replicant holds. */
function fakeLive() {
  const followed = new Map<string, Listener>();
  const stopped: string[] = [];
  live.follow = ((name: string, listener: Listener) => {
    followed.set(name, listener);
    return () => stopped.push(name);
  }) as typeof live.follow;
  return { followed, stopped, push: (name: string, value: unknown) => followed.get(name)?.(value) };
}

function serve(canManage: boolean) {
  const calls: { method: string; path: string }[] = [];
  api.request = vi.fn(async (method: string, path: string) => {
    calls.push({ method, path });
    if (path === '/api/v1/bundles') return bundles(canManage);
    if (path === '/api/v1/bundles/board/instances') {
      if (!canManage) throw new ApiError(403, 'forbidden', 'Missing permission');
      return {
        instances: [
          {
            id: 'i-1',
            graphic: 'overlay',
            principal: 'token:t1',
            kind: 'token',
            name: 'OBS',
            since: '',
          },
          {
            id: 'i-2',
            graphic: 'overlay',
            principal: 'user:u7',
            kind: 'user',
            name: null,
            since: '',
          },
        ],
      };
    }
    if (method === 'POST') return undefined;
    throw new ApiError(404, 'not_found', 'Not found');
  }) as typeof api.request;
  return calls;
}

const instance = (id: string) => ({ id, since: '2026-01-02T03:04:05.000Z' });

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('the graphics view', () => {
  it('follows the instances of each graphic and stops when it goes away', async () => {
    const { followed, stopped } = fakeLive();
    serve(false);
    const view = mount(GraphicsView);
    await flushPromises();
    expect([...followed.keys()]).toEqual(['board:$instances.overlay', 'board:$instances.studio']);
    view.unmount();
    expect(stopped.sort()).toEqual(['board:$instances.overlay', 'board:$instances.studio']);
  });

  it('shows that a graphic is open, and that it is not, without asking who', async () => {
    const { push } = fakeLive();
    const calls = serve(false);
    const view = mount(GraphicsView);
    await flushPromises();
    push('board:$instances.overlay', [instance('i-1'), instance('i-2')]);
    push('board:$instances.studio', []);
    await flushPromises();

    const overlay = view.find('[data-graphic="board:overlay"]');
    expect(overlay.findAll('[data-instance]')).toHaveLength(2);
    expect(overlay.text()).toContain('Open since');
    // Who it is, is for those who manage bundles: nobody else even asks.
    expect(calls.map((call) => call.path)).not.toContain('/api/v1/bundles/board/instances');
    expect(view.find('[data-graphic="board:studio"]').text()).toContain('Not open anywhere');
    expect(view.find('[data-graphic="board:studio"]').text()).toContain('one instance');
  });

  it('tells whoever may manage bundles who has a graphic open', async () => {
    const { push } = fakeLive();
    serve(true);
    const view = mount(GraphicsView);
    await flushPromises();
    push('board:$instances.overlay', [instance('i-1'), instance('i-2')]);
    await flushPromises();
    expect(view.find('[data-instance="i-1"]').text()).toContain('Open by OBS (token)');
    // Without a name, the principal says who.
    expect(view.find('[data-instance="i-2"]').text()).toContain('Open by user:u7');
  });

  it('disconnects one instance for whoever may manage bundles', async () => {
    const { push } = fakeLive();
    const calls = serve(true);
    const view = mount(GraphicsView);
    await flushPromises();
    push('board:$instances.overlay', [instance('i-1')]);
    await flushPromises();
    await view.find('[data-instance="i-1"] button[data-action="disconnect"]').trigger('click');
    await flushPromises();
    expect(calls.filter((call) => call.method === 'POST')).toEqual([
      { method: 'POST', path: '/api/v1/bundles/board/instances/i-1/disconnect' },
    ]);
  });

  it('offers no reload to whoever may not manage bundles', async () => {
    const { push } = fakeLive();
    serve(false);
    const view = mount(GraphicsView);
    await flushPromises();
    push('board:$instances.overlay', [instance('i-1')]);
    await flushPromises();
    expect(view.findAll('[data-instance] button')).toHaveLength(0);
  });

  it('reloads one instance for whoever may manage bundles', async () => {
    const { push } = fakeLive();
    const calls = serve(true);
    const view = mount(GraphicsView);
    await flushPromises();
    push('board:$instances.overlay', [instance('i-1'), instance('i-2')]);
    await flushPromises();
    await view.find('[data-instance="i-2"] button[data-action="reload"]').trigger('click');
    await flushPromises();
    expect(calls.filter((call) => call.method === 'POST')).toEqual([
      { method: 'POST', path: '/api/v1/bundles/board/instances/i-2/reload' },
    ]);
  });

  it('says so when a reload is refused', async () => {
    const { push } = fakeLive();
    serve(true);
    const view = mount(GraphicsView);
    await flushPromises();
    push('board:$instances.overlay', [instance('i-1')]);
    await flushPromises();
    api.request = vi.fn(async () => {
      throw new ApiError(404, 'not_found', 'Not found');
    }) as typeof api.request;
    await view.find('[data-instance="i-1"] button').trigger('click');
    await flushPromises();
    expect(view.find('[role="alert"]').text()).toContain('Not found');
  });
});
