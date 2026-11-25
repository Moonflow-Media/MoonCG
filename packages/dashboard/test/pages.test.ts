// @vitest-environment happy-dom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api.js';
import { live } from '../src/live.js';
import { useBundles } from '../src/stores/bundles.js';
import { BundlesView } from '../src/views/Bundles.js';
import { GraphicsView } from '../src/views/Graphics.js';
import { WorkspaceView } from '../src/views/Workspace.js';

type Listener = (value: unknown) => void;

const panel = (id: string, workspace = 'Show') => ({
  id,
  title: `Panel ${id}`,
  workspace,
  url: `/b/board/dashboard/${id}.html`,
});
const graphic = (id: string, singleInstance = false) => ({
  id,
  width: 1920,
  height: 1080,
  singleInstance,
  url: `/b/board/graphics/${id}.html`,
});
const LIST = {
  canManage: true,
  bundles: [
    { name: 'base', state: 'running', errors: [], panels: [], graphics: [], dependencies: [] },
    {
      name: 'board',
      title: 'Board',
      state: 'running',
      version: '1.0.0',
      errors: [],
      panels: [panel('control'), panel('timer'), panel('notes')],
      graphics: [graphic('overlay'), graphic('studio', true)],
      dependencies: ['base'],
    },
    {
      name: 'broken',
      state: 'failed',
      errors: ['It broke'],
      panels: [],
      graphics: [],
      dependencies: ['base', 'board'],
    },
    { name: 'off', state: 'disabled', errors: [], panels: [], graphics: [] },
    { name: 'slow', state: 'enabling', errors: [], panels: [], graphics: [] },
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

/** Stands in for the live connection: the test says what each replicant holds. */
function fakeLive() {
  const followed = new Map<string, Listener>();
  live.follow = ((name: string, listener: Listener) => {
    followed.set(name, listener);
    return () => {};
  }) as typeof live.follow;
  return { push: (name: string, value: unknown) => followed.get(name)?.(value) };
}

beforeEach(() => {
  setActivePinia(createPinia());
  live.follow = () => () => {};
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the bundles page', () => {
  async function show(list: unknown = LIST) {
    serve({ 'GET /api/v1/bundles': list });
    const view = mount(BundlesView, { attachTo: document.body });
    await flushPromises();
    return view;
  }
  const rows = (view: VueWrapper) =>
    view.findAll('[data-bundle]').map((row) => row.attributes('data-bundle'));
  const radio = (view: VueWrapper, choice: string) =>
    view.find(`.page-head [role="radiogroup"] [role="radio"][data-choice="${choice}"]`);
  const checked = (view: VueWrapper) =>
    view
      .findAll('.page-head [role="radio"]')
      .filter((item) => item.attributes('aria-checked') === 'true')
      .map((item) => item.attributes('data-choice'));
  const stat = (view: VueWrapper, state: string) => view.find(`.stat[data-stat="${state}"]`);

  it('offers a filter by state, with how many bundles each choice shows', async () => {
    const view = await show();
    expect(view.find('.page-head [role="radiogroup"]').attributes('aria-label')).toBe('Filter');
    expect(view.findAll('.page-head [role="radio"]').map((item) => item.text())).toEqual([
      'All 5',
      'running 2',
      'failed 1',
      'disabled 1',
    ]);
    expect(checked(view)).toEqual(['all']);
    expect(rows(view)).toEqual(['base', 'board', 'broken', 'off', 'slow']);
    view.unmount();
  });

  it('shows only the bundles in the state that was chosen', async () => {
    const view = await show();
    await radio(view, 'failed').trigger('click');
    expect(rows(view)).toEqual(['broken']);
    expect(checked(view)).toEqual(['failed']);
    await radio(view, 'running').trigger('click');
    expect(rows(view)).toEqual(['base', 'board']);
    await radio(view, 'all').trigger('click');
    expect(rows(view)).toHaveLength(5);
    view.unmount();
  });

  it('moves the choice with the arrow keys, as a group of radio buttons does', async () => {
    const view = await show();
    const tabbable = () =>
      view
        .findAll('.page-head [role="radio"]')
        .filter((item) => item.attributes('tabindex') === '0')
        .map((item) => item.attributes('data-choice'));
    expect(tabbable()).toEqual(['all']);

    await radio(view, 'all').trigger('keydown', { key: 'ArrowRight' });
    expect(checked(view)).toEqual(['running']);
    expect(tabbable()).toEqual(['running']);
    expect(document.activeElement).toBe(radio(view, 'running').element);
    expect(rows(view)).toEqual(['base', 'board']);

    await radio(view, 'running').trigger('keydown', { key: 'ArrowLeft' });
    await radio(view, 'all').trigger('keydown', { key: 'ArrowLeft' });
    expect(checked(view)).toEqual(['disabled']);
    await radio(view, 'disabled').trigger('keydown', { key: 'Home' });
    expect(checked(view)).toEqual(['all']);
    await radio(view, 'all').trigger('keydown', { key: 'End' });
    expect(checked(view)).toEqual(['disabled']);
    expect(document.activeElement).toBe(radio(view, 'disabled').element);
    view.unmount();
  });

  it('leaves the arrow keys alone while a modifier key is held', async () => {
    const view = await show();
    for (const modifier of ['altKey', 'ctrlKey', 'metaKey']) {
      const event = new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
        cancelable: true,
        [modifier]: true,
      });
      radio(view, 'all').element.dispatchEvent(event);
      await flushPromises();
      expect([modifier, checked(view)]).toEqual([modifier, ['all']]);
      // The browser keeps what the keys mean to it, such as going back a page.
      expect([modifier, event.defaultPrevented]).toEqual([modifier, false]);
    }
    await radio(view, 'all').trigger('keydown', { key: 'ArrowRight', shiftKey: true });
    expect(checked(view)).toEqual(['running']);
    view.unmount();
  });

  it('says so when no bundle is in the chosen state', async () => {
    const view = await show({ ...LIST, bundles: LIST.bundles.slice(0, 2) });
    await radio(view, 'failed').trigger('click');
    expect(rows(view)).toEqual([]);
    expect(view.find('.empty').text()).toBe('No bundle is failed.');
    view.unmount();
  });

  it('shows the key figures, and filters by the one that is pressed', async () => {
    const view = await show();
    expect(stat(view, 'running').find('.stat-value').text()).toBe('2');
    expect(stat(view, 'failed').find('.stat-value').text()).toBe('1');
    expect(stat(view, 'failed').find('.stat-hint').text()).toBe('broken');
    expect(stat(view, 'disabled').find('.stat-value').text()).toBe('1');
    expect(stat(view, 'failed').attributes('aria-pressed')).toBe('false');

    await stat(view, 'failed').trigger('click');
    expect(stat(view, 'failed').attributes('aria-pressed')).toBe('true');
    expect(stat(view, 'running').attributes('aria-pressed')).toBe('false');
    expect(rows(view)).toEqual(['broken']);
    expect(checked(view)).toEqual(['failed']);

    // Pressed again, it lets go.
    await stat(view, 'failed').trigger('click');
    expect(stat(view, 'failed').attributes('aria-pressed')).toBe('false');
    expect(rows(view)).toHaveLength(5);
    expect(checked(view)).toEqual(['all']);
    view.unmount();
  });

  it('counts the graphics running bundles serve, in a figure that is no button', async () => {
    const view = await show();
    const graphics = stat(view, 'graphics');
    expect(graphics.element.tagName).toBe('DIV');
    expect(graphics.attributes('aria-pressed')).toBeUndefined();
    expect(graphics.find('.stat-value').text()).toBe('2');
    view.unmount();
  });

  it('says what a running bundle brings and what a bundle needs, as far as it is told', async () => {
    const view = await show();
    const facts = (name: string) => view.find(`[data-bundle="${name}"] .bundle-facts`).text();
    expect(facts('board')).toContain('3 panels · 2 graphics');
    expect(facts('board')).toContain('needs base');
    expect(facts('base')).toContain('0 panels · 0 graphics');
    expect(facts('base')).not.toContain('needs');
    // What a bundle that does not run would bring is not told, so nothing is claimed.
    expect(facts('broken')).not.toContain('panel');
    expect(facts('broken')).toContain('needs base, board');
    expect(facts('off')).toBe('');
    view.unmount();
  });

  it('marks the row of a failed bundle', async () => {
    const view = await show();
    expect(view.find('[data-bundle="broken"]').classes()).toContain('failed');
    expect(view.find('[data-bundle="board"]').classes()).not.toContain('failed');
    expect(view.find('[data-bundle="slow"] .state').classes()).toContain('enabling');
    view.unmount();
  });
});

describe('the workspace page', () => {
  const KEY = '/api/v1/me/prefs/layout._53_how';
  async function show(saved: unknown, list: unknown = LIST) {
    serve({ 'GET /api/v1/bundles': list, [`GET ${KEY}`]: { value: saved }, [`PUT ${KEY}`]: null });
    await useBundles().refresh();
    const view = mount(WorkspaceView, { props: { workspace: 'Show' } });
    await flushPromises();
    return view;
  }
  const notes = (view: VueWrapper) =>
    view.findAll('[data-hidden-panel]').map((note) => note.text());

  it('is headed by the name of the workspace and how many panels it shows', async () => {
    const view = await show(null);
    expect(view.find('.page-head h1').text()).toBe('Show 3 panels');
    expect(view.find('.page-head .badge').text()).toBe('3 panels');
    expect(notes(view)).toEqual([]);
  });

  it('says which panels of the layout are hidden because their bundle does not run', async () => {
    const view = await show([
      { id: 'board:control', w: 3, h: 2 },
      { id: 'broken:monitor', w: 3, h: 2 },
      { id: 'off:playlist', w: 3, h: 2 },
      // Of a bundle that runs, and of one that is not there: gone, not hidden.
      { id: 'board:removed', w: 3, h: 2 },
      { id: 'elsewhere:panel', w: 3, h: 2 },
    ]);
    expect(notes(view)).toEqual([
      '"monitor" is hidden: the bundle broken is failed.',
      '"playlist" is hidden: the bundle off is disabled.',
    ]);
    expect(view.findAll('[data-panel]')).toHaveLength(3);
  });

  it('keeps saying so after the layout was changed, and stops once the bundle runs', async () => {
    const view = await show([
      { id: 'board:control', w: 3, h: 2 },
      { id: 'off:playlist', w: 3, h: 2 },
    ]);
    await view.find('[data-panel="board:control"] [data-action="wider"]').trigger('click');
    await flushPromises();
    expect(notes(view)).toEqual(['"playlist" is hidden: the bundle off is disabled.']);

    const running = LIST.bundles.map((bundle) =>
      bundle.name === 'off'
        ? { ...bundle, state: 'running', panels: [{ ...panel('playlist'), url: '/x' }] }
        : bundle,
    );
    serve({
      'GET /api/v1/bundles': { ...LIST, bundles: running },
      [`GET ${KEY}`]: { value: null },
    });
    await useBundles().refresh();
    await flushPromises();
    expect(notes(view)).toEqual([]);
    expect(view.find('[data-panel="off:playlist"]').exists()).toBe(true);
  });

  it('names the hidden panels also where no panel is left to show', async () => {
    const none = LIST.bundles.map((bundle) => ({ ...bundle, panels: [] }));
    const view = await show([{ id: 'off:playlist', w: 3, h: 2 }], { ...LIST, bundles: none });
    expect(view.text()).toContain('This workspace has no panel you may use.');
    expect(notes(view)).toEqual(['"playlist" is hidden: the bundle off is disabled.']);
  });
});

describe('the graphics page', () => {
  async function show() {
    serve({ 'GET /api/v1/bundles': { ...LIST, canManage: false } });
    const connection = fakeLive();
    const view = mount(GraphicsView);
    await flushPromises();
    return { view, ...connection };
  }
  const overlay = (view: VueWrapper) => view.find('[data-graphic="board:overlay"]');
  const copyButton = (view: VueWrapper) => overlay(view).find('.copy-field button');

  it('says "Copied" for a moment once the URL is on the clipboard', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { view } = await show();
    expect(copyButton(view).text()).toBe('Copy');

    await copyButton(view).trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(
      `${location.origin}/b/board/graphics/overlay.html`,
    );
    expect(copyButton(view).text()).toBe('Copied');
    // Only the one that was copied says so.
    expect(view.find('[data-graphic="board:studio"] .copy-field button').text()).toBe('Copy');

    await vi.advanceTimersByTimeAsync(2000);
    expect(copyButton(view).text()).toBe('Copy');
    view.unmount();
  });

  it('claims nothing when the browser does not let it copy', async () => {
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: async () => {
          throw new Error('denied');
        },
      },
    });
    const { view } = await show();
    await copyButton(view).trigger('click');
    await flushPromises();
    expect(copyButton(view).text()).toBe('Copy');

    vi.stubGlobal('navigator', {});
    await copyButton(view).trigger('click');
    await flushPromises();
    expect(copyButton(view).text()).toBe('Copy');
    view.unmount();
  });

  it('marks a graphic that is open as on air, and counts them in the heading', async () => {
    const { view, push } = await show();
    push('board:$instances.overlay', []);
    push('board:$instances.studio', []);
    await flushPromises();
    expect(view.text()).not.toContain('On air');
    expect(view.find('.page-head .badge').exists()).toBe(false);

    push('board:$instances.overlay', [{ id: 'i-1', since: '2026-01-02T03:04:05.000Z' }]);
    await flushPromises();
    expect(overlay(view).find('.graphic-title .badge.live').text()).toBe('On air');
    expect(view.find('[data-graphic="board:studio"]').text()).not.toContain('On air');
    expect(view.find('.page-head .badge.live').text()).toBe('1 open');
    view.unmount();
  });

  it('draws no preview: nothing on the page loads a graphic', async () => {
    const { view, push } = await show();
    push('board:$instances.overlay', [{ id: 'i-1', since: '2026-01-02T03:04:05.000Z' }]);
    await flushPromises();
    expect(view.findAll('iframe, img, object, embed, .graphic-preview')).toHaveLength(0);
    expect(overlay(view).find('.graphic-title a').text()).toBe('Board · overlay');
    expect(overlay(view).find('.graphic-title').text()).toContain('1920×1080');
    view.unmount();
  });
});
