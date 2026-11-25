import {
  BUNDLE_NAME_PATTERN,
  ERROR_CODES,
  type ErrorCode,
  isPlainObject,
  type Json,
  jsonProblem,
  MoonCGError,
} from '@mooncg/core';

/**
 * Dialogs travel as `postMessage` between three windows of one origin: the panel that opens
 * a dialog, the dashboard that frames both, and the dialog page. Every message carries this
 * marker, so nothing else that is posted to a window is taken for one.
 */
export const DIALOG_CHANNEL = 'mooncg.dialog';

export type DialogMessage =
  /** Panel to dashboard: open the dialog `dialog` of my bundle. `id` numbers the request. */
  | {
      readonly channel: typeof DIALOG_CHANNEL;
      readonly t: 'open';
      readonly id: number;
      readonly dialog: string;
      readonly data: Json;
    }
  /** Dashboard to panel: the dialog closed with this result; `null` when it was dismissed. */
  | {
      readonly channel: typeof DIALOG_CHANNEL;
      readonly t: 'result';
      readonly id: number;
      readonly result: Json;
    }
  /** Dashboard to panel: the dialog could not be opened. */
  | {
      readonly channel: typeof DIALOG_CHANNEL;
      readonly t: 'error';
      readonly id: number;
      readonly code: ErrorCode;
      readonly message: string;
    }
  /** Panel to dashboard: this page is going away; close what it opened. */
  | { readonly channel: typeof DIALOG_CHANNEL; readonly t: 'gone' }
  /** Dialog page to dashboard: I am loaded, send me my data. */
  | { readonly channel: typeof DIALOG_CHANNEL; readonly t: 'ready' }
  /** Dashboard to dialog page: which dialog you are and what the panel passed. */
  | {
      readonly channel: typeof DIALOG_CHANNEL;
      readonly t: 'init';
      readonly dialog: string;
      readonly data: Json;
    }
  /** Dialog page to dashboard: close me with this result. */
  | { readonly channel: typeof DIALOG_CHANNEL; readonly t: 'close'; readonly result: Json };

const isId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const isDialogId = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 200 && BUNDLE_NAME_PATTERN.test(value);
const isJson = (value: unknown): value is Json =>
  value !== undefined && jsonProblem(value) === null;

/**
 * Checks something that arrived as a `message` event. Returns the message with nothing but
 * its own fields, or `undefined` for anything that is not a dialog message.
 */
export function readDialogMessage(raw: unknown): DialogMessage | undefined {
  if (!isPlainObject(raw) || raw.channel !== DIALOG_CHANNEL) return undefined;
  const channel = DIALOG_CHANNEL;
  switch (raw.t) {
    case 'open':
      return isId(raw.id) && isDialogId(raw.dialog) && isJson(raw.data)
        ? { channel, t: 'open', id: raw.id, dialog: raw.dialog, data: raw.data }
        : undefined;
    case 'result':
      return isId(raw.id) && isJson(raw.result)
        ? { channel, t: 'result', id: raw.id, result: raw.result }
        : undefined;
    case 'error':
      return isId(raw.id) &&
        (ERROR_CODES as readonly unknown[]).includes(raw.code) &&
        typeof raw.message === 'string'
        ? {
            channel,
            t: 'error',
            id: raw.id,
            code: raw.code as ErrorCode,
            message: raw.message.slice(0, 1000),
          }
        : undefined;
    case 'init':
      return isDialogId(raw.dialog) && isJson(raw.data)
        ? { channel, t: 'init', dialog: raw.dialog, data: raw.data }
        : undefined;
    case 'close':
      return isJson(raw.result) ? { channel, t: 'close', result: raw.result } : undefined;
    case 'ready':
    case 'gone':
      return { channel, t: raw.t };
    default:
      return undefined;
  }
}

/** What a dialog page knows about itself. */
export interface OpenDialog {
  /** The dialog's `id` in the bundle manifest. */
  readonly id: string;
  /** What the panel passed to `open`. */
  readonly data: Json;
  /** Closes the dialog. The panel's `open` resolves with `result`, `null` without one. */
  close(result?: Json): void;
}

export interface Dialogs {
  /**
   * Opens a dialog of this page's bundle over the dashboard and resolves with what the
   * dialog closed with, `null` if it was dismissed. Rejects with `not_found` for a dialog
   * the bundle does not declare or the user may not open, `conflict` while another dialog is
   * open, and `unavailable` when the page is not shown inside the dashboard.
   */
  open(id: string, data?: Json): Promise<Json>;
  /** For the dialog page: resolves with its data and the function that closes it. */
  current(): Promise<OpenDialog>;
}

/** The part of `window` dialogs use. */
export interface DialogWindow {
  /** The framing window, or `null` (or the window itself) when the page is not framed. */
  readonly parent: { postMessage(message: unknown, targetOrigin: string): void } | null;
  /** The page's own origin. Messages go to it and are believed from it, and nowhere else. */
  readonly origin: string;
  /**
   * In dev mode, for a page of a development server: the origin of the dashboard that frames
   * it, as the dashboard put it into the address of the frame (`mooncgHost`). Taken only when
   * both are on this machine, and only when the browser does not say another frames it.
   */
  readonly host?: string | undefined;
  /** The origins of the frames around the page, where the browser tells them. */
  readonly ancestors?: readonly string[] | undefined;
  addEventListener(
    type: 'message' | 'pagehide',
    listener: (event: { data?: unknown; origin?: string; source?: unknown }) => void,
  ): void;
}

export interface DialogOptions {
  /** How long a dialog page waits to be told its data. Defaults to 5000. */
  readonly initTimeoutMs?: number;
}

/** The query parameter a dashboard in dev mode names itself by to a page of another origin. */
export const DIALOG_HOST_PARAMETER = 'mooncgHost';

/** An origin on this machine, over `http:` or `https:`, as the dashboard's `devOriginOf` takes. */
const LOOPBACK_ORIGIN =
  /^https?:\/\/(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])(:\d{1,5})?$/;

/**
 * The origin of the dashboard a page speaks to: its own, as a page MoonCG serves has. A page
 * of a development server in dev mode speaks to the origin the dashboard named in the address
 * of its frame, but only when both are on this machine (dev mode runs nowhere else) and the
 * browser, where it tells the origins of the frames around a page, says the same.
 */
export function dialogHostOrigin(win: DialogWindow): string {
  const { host, origin, ancestors } = win;
  if (host === undefined || host === origin) return origin;
  if (!LOOPBACK_ORIGIN.test(host) || !LOOPBACK_ORIGIN.test(origin)) return origin;
  if (ancestors !== undefined && ancestors[0] !== host) return origin;
  return host;
}

function pageWindow(): DialogWindow | undefined {
  if (typeof window === 'undefined') return undefined;
  const ancestors = window.location.ancestorOrigins;
  return {
    parent: window.parent === window ? null : window.parent,
    origin: window.location.origin,
    host: new URLSearchParams(window.location.search).get(DIALOG_HOST_PARAMETER) ?? undefined,
    ancestors: ancestors === undefined ? undefined : [...ancestors],
    addEventListener: (type, listener) =>
      window.addEventListener(type, listener as (event: Event) => void),
  };
}

/** Builds `mc.dialogs` for a page. Without a framing window every call is `unavailable`. */
export function createDialogs(
  win: DialogWindow | undefined = pageWindow(),
  options: DialogOptions = {},
): Dialogs {
  const parent = win?.parent ?? null;
  const pending = new Map<
    number,
    { resolve(result: Json): void; reject(error: MoonCGError): void }
  >();
  let nextId = 1;
  let current: Promise<OpenDialog> | undefined;
  let init: ((message: Extract<DialogMessage, { t: 'init' }>) => void) | undefined;
  let listening = false;

  /** The dashboard's origin: messages go to it and are believed from it alone, never `*`. */
  const host = win ? dialogHostOrigin(win) : '';
  const post = (message: DialogMessage) => parent?.postMessage(message, host);
  const unavailable = () =>
    new MoonCGError('unavailable', 'Dialogs need the dashboard: this page is not shown inside it');

  const listen = () => {
    if (listening || !win) return;
    listening = true;
    win.addEventListener('message', (event) => {
      // Only the dashboard that frames this page is believed, and only from this origin.
      if (event.source !== parent || event.origin !== host) return;
      const message = readDialogMessage(event.data);
      if (message?.t === 'result') {
        pending.get(message.id)?.resolve(message.result);
        pending.delete(message.id);
      } else if (message?.t === 'error') {
        pending.get(message.id)?.reject(new MoonCGError(message.code, message.message));
        pending.delete(message.id);
      } else if (message?.t === 'init') init?.(message);
    });
    // A page that is reloaded or navigated away can take no answer; its dialog is closed.
    win.addEventListener('pagehide', () => {
      if (pending.size > 0) post({ channel: DIALOG_CHANNEL, t: 'gone' });
    });
  };

  return {
    open(id, data = null) {
      if (!parent) return Promise.reject(unavailable());
      if (!isDialogId(id)) {
        return Promise.reject(new MoonCGError('not_found', `There is no dialog "${id}"`));
      }
      const problem = jsonProblem(data);
      if (problem !== null) {
        return Promise.reject(
          new MoonCGError('bad_request', `Dialog data must be JSON: ${problem}`),
        );
      }
      listen();
      const request = nextId++;
      return new Promise<Json>((resolve, reject) => {
        pending.set(request, { resolve, reject });
        post({ channel: DIALOG_CHANNEL, t: 'open', id: request, dialog: id, data });
      });
    },
    current() {
      if (!parent) return Promise.reject(unavailable());
      current ??= new Promise<OpenDialog>((resolve, reject) => {
        listen();
        const timer = setTimeout(
          () => reject(new MoonCGError('unavailable', 'This page was not opened as a dialog')),
          options.initTimeoutMs ?? 5000,
        );
        init = (message) => {
          clearTimeout(timer);
          resolve({
            id: message.dialog,
            data: message.data,
            close: (result = null) => post({ channel: DIALOG_CHANNEL, t: 'close', result }),
          });
        };
        post({ channel: DIALOG_CHANNEL, t: 'ready' });
      });
      return current;
    },
  };
}
