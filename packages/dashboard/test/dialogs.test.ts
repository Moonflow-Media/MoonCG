// @vitest-environment happy-dom
import { DIALOG_CHANNEL } from '@mooncg/sdk/client';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDialogHost, type DialogInfo, type OpenedDialog } from '../src/dialogs.js';
import { useBundles } from '../src/stores/bundles.js';
import { DialogHost } from '../src/views/DialogHost.js';

const ORIGIN = 'http://127.0.0.1:9090';
const CONFIRM: DialogInfo = {
  id: 'confirm-reset',
  title: 'Reset?',
  width: 4,
  url: '/b/board/dashboard/confirm.html',
};

/** A window that collects what is posted to it. */
function fakeWindow() {
  const posted: { message: Record<string, unknown>; targetOrigin: string }[] = [];
  return {
    posted,
    postMessage(message: unknown, targetOrigin: string) {
      posted.push({ message: message as Record<string, unknown>, targetOrigin });
    },
  };
}

function setup() {
  const panel = fakeWindow();
  const other = fakeWindow();
  const dialog = fakeWindow();
  const frames = [
    { element: { isConnected: true, contentWindow: panel as unknown }, bundle: 'board' },
    { element: { isConnected: true, contentWindow: other as unknown }, bundle: 'other' },
  ];
  const shown: (OpenedDialog | undefined)[] = [];
  const host = createDialogHost({
    origin: ORIGIN,
    panels: () => frames,
    dialogsOf: (bundle) => (bundle === 'board' ? [CONFIRM] : []),
    dialogWindow: () => (shown.at(-1) === undefined ? undefined : dialog),
    onChange: (open) => shown.push(open),
  });
  const from = (source: unknown, message: object, origin = ORIGIN) =>
    host.receive({ origin, source, data: { channel: DIALOG_CHANNEL, ...message } });
  const open = (source: unknown = panel, id = 'confirm-reset', request = 1) =>
    from(source, { t: 'open', id: request, dialog: id, data: { home: 2 } });
  return { host, panel, other, dialog, frames, shown, from, open };
}

describe('the dialog host', () => {
  it('opens a dialog of the calling panel’s bundle', () => {
    const { shown, open } = setup();
    open();
    expect(shown).toEqual([{ bundle: 'board', dialog: CONFIRM, title: 'Reset?' }]);
  });

  it('hands the dialog page its data once it is ready, at this origin only', () => {
    const { dialog, from, open } = setup();
    open();
    from(dialog, { t: 'ready' });
    expect(dialog.posted).toEqual([
      {
        targetOrigin: ORIGIN,
        message: { channel: DIALOG_CHANNEL, t: 'init', dialog: 'confirm-reset', data: { home: 2 } },
      },
    ]);
  });

  it('returns the result to the panel that asked and closes the dialog', () => {
    const { panel, dialog, shown, from, open } = setup();
    open();
    from(dialog, { t: 'close', result: { confirmed: true } });
    expect(panel.posted).toEqual([
      {
        targetOrigin: ORIGIN,
        message: { channel: DIALOG_CHANNEL, t: 'result', id: 1, result: { confirmed: true } },
      },
    ]);
    expect(shown.at(-1)).toBeUndefined();
  });

  it('answers null when the user dismisses the dialog', () => {
    const { host, panel, shown, open } = setup();
    open();
    host.dismiss();
    expect(panel.posted[0]?.message).toMatchObject({ t: 'result', id: 1, result: null });
    expect(shown.at(-1)).toBeUndefined();
  });

  it('refuses a dialog of another bundle, and one that does not exist, the same way', () => {
    const { other, panel, shown, open } = setup();
    // The bundle "other" asks for a dialog that only "board" has.
    open(other);
    open(panel, 'nothing', 2);
    expect(other.posted[0]?.message).toMatchObject({ t: 'error', id: 1, code: 'not_found' });
    expect(panel.posted[0]?.message).toMatchObject({ t: 'error', id: 2, code: 'not_found' });
    expect(shown).toEqual([]);
  });

  it('believes no message from another origin', () => {
    const { panel, shown, from } = setup();
    from(panel, { t: 'open', id: 1, dialog: 'confirm-reset', data: null }, 'https://evil.example');
    expect(shown).toEqual([]);
    expect(panel.posted).toEqual([]);
  });

  it('believes no window that is not a panel on the page', () => {
    const { shown, open } = setup();
    const stranger = fakeWindow();
    open(stranger);
    expect(shown).toEqual([]);
    expect(stranger.posted).toEqual([]);
  });

  it('lets only the dialog page close the dialog', () => {
    const { panel, other, shown, from, open } = setup();
    open();
    from(other, { t: 'close', result: 'forged' });
    from(panel, { t: 'close', result: 'forged' });
    from(fakeWindow(), { t: 'close', result: 'forged' });
    expect(shown).toHaveLength(1);
    expect(panel.posted).toEqual([]);
  });

  it('ignores what is no dialog message', () => {
    const { host, panel, shown } = setup();
    host.receive({ origin: ORIGIN, source: panel, data: { t: 'open', id: 1, dialog: 'x' } });
    host.receive({ origin: ORIGIN, source: panel, data: 'open' });
    expect(shown).toEqual([]);
  });

  it('opens one dialog at a time', () => {
    const { panel, shown, open } = setup();
    open();
    open(panel, 'confirm-reset', 2);
    expect(panel.posted[0]?.message).toMatchObject({ t: 'error', id: 2, code: 'conflict' });
    expect(shown).toHaveLength(1);
  });

  it('closes the dialog when the panel that opened it says it goes away', () => {
    const { panel, other, shown, from, open } = setup();
    open();
    from(other, { t: 'gone' });
    expect(shown).toHaveLength(1);
    from(panel, { t: 'gone' });
    expect(shown.at(-1)).toBeUndefined();
    expect(panel.posted).toEqual([]);
  });

  it('closes the dialog when the frame of the panel is taken off the page', () => {
    const { host, frames, shown, open } = setup();
    open();
    host.check();
    expect(shown).toHaveLength(1);
    (frames[0] as { element: { isConnected: boolean } }).element.isConnected = false;
    host.check();
    expect(shown.at(-1)).toBeUndefined();
  });

  it('closes the dialog when the frame of the panel shows another window', () => {
    const { host, frames, shown, open } = setup();
    open();
    (frames[0] as { element: { contentWindow: unknown } }).element.contentWindow = fakeWindow();
    host.check();
    expect(shown.at(-1)).toBeUndefined();
  });

  it('closes the dialog when the frame of the panel loads a page again', () => {
    const { host, frames, shown, open } = setup();
    // The page that asks has loaded once already.
    host.loaded(frames[0]?.element);
    open();
    // Another frame loading is nothing to the dialog.
    host.loaded(frames[1]?.element);
    expect(shown).toHaveLength(1);
    host.loaded(frames[0]?.element);
    expect(shown.at(-1)).toBeUndefined();
  });

  it('keeps the dialog of a panel that asked while it was still loading', () => {
    const { host, frames, shown, open } = setup();
    open();
    host.loaded(frames[0]?.element);
    expect(shown).toHaveLength(1);
  });

  it('tells a dialog page that asks for a dialog that one is open', () => {
    const { dialog, shown, from, open } = setup();
    open();
    from(dialog, { t: 'open', id: 7, dialog: 'confirm-reset', data: null });
    expect(dialog.posted[0]?.message).toMatchObject({ t: 'error', id: 7, code: 'conflict' });
    expect(shown).toHaveLength(1);
  });
});

describe('the dialog host on the page', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    document.body.innerHTML = '';
  });

  /** Puts a panel frame on the page as a workspace does, and returns its window. */
  function panelFrame(bundle?: string) {
    const frame = document.createElement('iframe');
    if (bundle !== undefined) frame.dataset.panelBundle = bundle;
    // The simulated DOM loads no frames, so the frame gets a window of its own here.
    Object.defineProperty(frame, 'contentWindow', { value: fakeWindow() });
    document.body.append(frame);
    return frame;
  }

  const post = (source: unknown, message: object) =>
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: location.origin,
        source: source as MessageEventSource,
        data: { channel: DIALOG_CHANNEL, ...message },
      }),
    );

  it('shows the dialog of a panel on the page over everything, and takes it away', async () => {
    const bundles = useBundles();
    bundles.list = [
      {
        name: 'board',
        state: 'running',
        errors: [],
        panels: [],
        graphics: [],
        dialogs: [CONFIRM],
      },
    ];
    const frame = panelFrame('board');
    const view = mount(DialogHost, { attachTo: document.body });
    expect(view.find('[role="dialog"]').exists()).toBe(false);

    post(frame.contentWindow, { t: 'open', id: 1, dialog: 'confirm-reset', data: null });
    await flushPromises();
    const dialog = view.find('[role="dialog"]');
    expect(dialog.attributes('aria-label')).toBe('Reset?');
    expect(dialog.attributes('aria-modal')).toBe('true');
    expect(dialog.classes()).toContain('dialog-w-4');
    expect(dialog.find('iframe').attributes('src')).toBe('/b/board/dashboard/confirm.html');

    await dialog.find('button[aria-label="Close"]').trigger('click');
    expect(view.find('[role="dialog"]').exists()).toBe(false);
    view.unmount();
  });

  it('opens nothing for a frame that is no panel', async () => {
    const frame = panelFrame();
    const view = mount(DialogHost, { attachTo: document.body });
    post(frame.contentWindow, { t: 'open', id: 1, dialog: 'confirm-reset', data: null });
    await flushPromises();
    expect(view.find('[role="dialog"]').exists()).toBe(false);
    view.unmount();
  });
});
