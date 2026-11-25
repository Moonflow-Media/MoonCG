import { describe, expect, it } from 'vitest';
import {
  createDialogs,
  DIALOG_CHANNEL,
  type DialogMessage,
  type DialogWindow,
  readDialogMessage,
} from '../src/client/index.js';

const ORIGIN = 'http://127.0.0.1:9090';
type Listener = (event: { data: unknown; origin: string; source: unknown }) => void;

/** A page inside a frame: what it posts to its parent is collected, and the test answers. */
function framed(extra: Partial<DialogWindow> = {}) {
  const posted: { message: DialogMessage; targetOrigin: string }[] = [];
  const listeners: Record<string, Listener[]> = {};
  const parent = {
    postMessage(message: unknown, targetOrigin: string) {
      posted.push({ message: message as DialogMessage, targetOrigin });
    },
  };
  const win: DialogWindow = {
    parent,
    origin: ORIGIN,
    addEventListener: (type, listener) => {
      listeners[type] = [...(listeners[type] ?? []), listener as Listener];
    },
    ...extra,
  };
  const emit = (type: string, event: Partial<Parameters<Listener>[0]> = {}) => {
    for (const listener of listeners[type] ?? []) {
      listener({ data: undefined, origin: ORIGIN, source: parent, ...event });
    }
  };
  /** Delivers a message as the dashboard would send it. */
  const fromShell = (message: object, event: Partial<Parameters<Listener>[0]> = {}) =>
    emit('message', { data: { channel: DIALOG_CHANNEL, ...message }, ...event });
  return { win, parent, posted, emit, fromShell };
}

describe('readDialogMessage', () => {
  it.each([
    { channel: DIALOG_CHANNEL, t: 'open', id: 1, dialog: 'confirm', data: { a: 1 } },
    { channel: DIALOG_CHANNEL, t: 'result', id: 1, result: null },
    { channel: DIALOG_CHANNEL, t: 'error', id: 1, code: 'not_found', message: 'No' },
    { channel: DIALOG_CHANNEL, t: 'ready' },
    { channel: DIALOG_CHANNEL, t: 'init', dialog: 'confirm', data: null },
    { channel: DIALOG_CHANNEL, t: 'close', result: true },
    { channel: DIALOG_CHANNEL, t: 'gone' },
  ])('reads $t', (message) => {
    expect(readDialogMessage({ ...message, extra: 'dropped' })).toEqual(message);
  });

  it.each([
    null,
    'open',
    { t: 'open', id: 1, dialog: 'confirm', data: null },
    { channel: 'other', t: 'ready' },
    { channel: DIALOG_CHANNEL, t: 'open', id: 0, dialog: 'confirm', data: null },
    { channel: DIALOG_CHANNEL, t: 'open', id: 1, dialog: 'Not An Id', data: null },
    { channel: DIALOG_CHANNEL, t: 'open', id: 1, dialog: 'confirm' },
    { channel: DIALOG_CHANNEL, t: 'open', id: 1, dialog: 'confirm', data: () => {} },
    { channel: DIALOG_CHANNEL, t: 'error', id: 1, code: 'made_up', message: 'No' },
    { channel: DIALOG_CHANNEL, t: 'result', id: 1 },
    { channel: DIALOG_CHANNEL, t: 'unknown' },
  ])('refuses %j', (message) => {
    expect(readDialogMessage(message)).toBeUndefined();
  });
});

describe('opening a dialog from a panel', () => {
  it('asks the dashboard, at this origin only, and resolves with the result', async () => {
    const { win, posted, fromShell } = framed();
    const result = createDialogs(win).open('confirm-reset', { home: 2 });
    expect(posted).toEqual([
      {
        targetOrigin: ORIGIN,
        message: {
          channel: DIALOG_CHANNEL,
          t: 'open',
          id: 1,
          dialog: 'confirm-reset',
          data: { home: 2 },
        },
      },
    ]);
    fromShell({ t: 'result', id: 1, result: { confirmed: true } });
    await expect(result).resolves.toEqual({ confirmed: true });
  });

  it('rejects with the error the dashboard answers', async () => {
    const { win, fromShell } = framed();
    const result = createDialogs(win).open('nothing');
    fromShell({ t: 'error', id: 1, code: 'not_found', message: 'There is no dialog "nothing"' });
    await expect(result).rejects.toMatchObject({ code: 'not_found' });
  });

  it('keeps the answers of several dialogs apart', async () => {
    const { win, fromShell } = framed();
    const dialogs = createDialogs(win);
    const first = dialogs.open('a');
    const second = dialogs.open('b');
    fromShell({ t: 'result', id: 2, result: 'second' });
    fromShell({ t: 'result', id: 1, result: 'first' });
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
  });

  it('believes no answer from another origin or another window', async () => {
    const { win, fromShell } = framed();
    let settled = false;
    const result = createDialogs(win).open('confirm');
    void result.then(() => {
      settled = true;
    });
    fromShell({ t: 'result', id: 1, result: 'forged' }, { origin: 'https://evil.example' });
    fromShell({ t: 'result', id: 1, result: 'forged' }, { source: {} });
    await Promise.resolve();
    expect(settled).toBe(false);
    fromShell({ t: 'result', id: 1, result: 'real' });
    await expect(result).resolves.toBe('real');
  });

  it('refuses data that is not JSON without asking', async () => {
    const { win, posted } = framed();
    await expect(createDialogs(win).open('confirm', (() => {}) as never)).rejects.toMatchObject({
      code: 'bad_request',
    });
    expect(posted).toEqual([]);
  });

  it('says that dialogs need the dashboard when the page is not inside it', async () => {
    const standalone: DialogWindow = { parent: null, origin: ORIGIN, addEventListener() {} };
    await expect(createDialogs(standalone).open('confirm')).rejects.toMatchObject({
      code: 'unavailable',
    });
    await expect(createDialogs(undefined).open('confirm')).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('tells the dashboard when the page goes away while a dialog is open', () => {
    const { win, posted, emit } = framed();
    const dialogs = createDialogs(win);
    emit('pagehide');
    expect(posted).toEqual([]);
    void dialogs.open('confirm');
    emit('pagehide');
    expect(posted.at(-1)?.message).toEqual({ channel: DIALOG_CHANNEL, t: 'gone' });
  });
});

describe('the dialog page', () => {
  it('says it is ready, gets its data, and closes with a result', async () => {
    const { win, posted, fromShell } = framed();
    const current = createDialogs(win).current();
    expect(posted.map((item) => item.message)).toEqual([{ channel: DIALOG_CHANNEL, t: 'ready' }]);
    fromShell({ t: 'init', dialog: 'confirm-reset', data: { home: 2 } });
    const dialog = await current;
    expect(dialog.id).toBe('confirm-reset');
    expect(dialog.data).toEqual({ home: 2 });

    dialog.close({ confirmed: true });
    expect(posted.at(-1)).toEqual({
      targetOrigin: ORIGIN,
      message: { channel: DIALOG_CHANNEL, t: 'close', result: { confirmed: true } },
    });
  });

  it('closes with null when it has nothing to say', async () => {
    const { win, posted, fromShell } = framed();
    const current = createDialogs(win).current();
    fromShell({ t: 'init', dialog: 'confirm', data: null });
    (await current).close();
    expect(posted.at(-1)?.message).toEqual({ channel: DIALOG_CHANNEL, t: 'close', result: null });
  });

  it('asks once, however often the page asks for it', async () => {
    const { win, posted, fromShell } = framed();
    const dialogs = createDialogs(win);
    const first = dialogs.current();
    const second = dialogs.current();
    fromShell({ t: 'init', dialog: 'confirm', data: 1 });
    expect((await first).data).toBe(1);
    expect((await second).data).toBe(1);
    expect(posted).toHaveLength(1);
  });

  it('gives up when the page was not opened as a dialog', async () => {
    const { win } = framed();
    await expect(createDialogs(win, { initTimeoutMs: 10 }).current()).rejects.toMatchObject({
      code: 'unavailable',
    });
  });
});

describe('a page of a development server, in dev mode', () => {
  const DEV = 'http://localhost:5173';
  const SHELL = 'http://localhost:9090';

  it('speaks to the dashboard at the origin its frame address names, on this machine', async () => {
    const { win, posted, fromShell } = framed({ origin: DEV, host: SHELL });
    const dialogs = createDialogs(win);
    const result = dialogs.open('confirm', null);
    expect(posted).toEqual([
      { targetOrigin: SHELL, message: expect.objectContaining({ t: 'open', dialog: 'confirm' }) },
    ]);
    // Not believed from its own origin, which is not the dashboard's.
    fromShell({ t: 'result', id: 1, result: 'forged' }, { origin: DEV });
    fromShell({ t: 'result', id: 1, result: true }, { origin: SHELL });
    await expect(result).resolves.toBe(true);
  });

  it('takes no dashboard elsewhere than on this machine, and none another frame names', () => {
    for (const [origin, host, ancestors] of [
      [DEV, 'https://evil.example', undefined],
      ['https://bundle.example', SHELL, undefined],
      [DEV, 'http://localhost:9090/path', undefined],
      [DEV, SHELL, ['https://evil.example']],
    ] as const) {
      const { win, posted } = framed({ origin, host, ancestors });
      void createDialogs(win)
        .open('confirm', null)
        .catch(() => {});
      expect(posted[0]?.targetOrigin).toBe(origin);
    }
    const { win, posted } = framed({ origin: DEV, host: SHELL, ancestors: [SHELL] });
    void createDialogs(win).open('confirm', null);
    expect(posted[0]?.targetOrigin).toBe(SHELL);
  });

  it('takes a development server on this machine that speaks https', () => {
    for (const origin of ['https://localhost:5173', 'https://127.0.0.1:5173', 'https://[::1]']) {
      const { win, posted } = framed({ origin, host: SHELL });
      void createDialogs(win).open('confirm', null);
      expect(posted[0]?.targetOrigin).toBe(SHELL);
    }
    // And a dashboard on this machine behind https, as the same rule says.
    const { win, posted } = framed({ origin: DEV, host: 'https://localhost:9443' });
    void createDialogs(win).open('confirm', null);
    expect(posted[0]?.targetOrigin).toBe('https://localhost:9443');
    // Still nothing elsewhere.
    const other = framed({ origin: 'https://localhost.example', host: SHELL });
    void createDialogs(other.win)
      .open('confirm', null)
      .catch(() => {});
    expect(other.posted[0]?.targetOrigin).toBe('https://localhost.example');
  });
});
