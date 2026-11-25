import {
  DIALOG_CHANNEL,
  DIALOG_HOST_PARAMETER,
  type DialogMessage,
  readDialogMessage,
} from '@mooncg/sdk/client';

/**
 * The address a frame of a panel or a dialog loads. A page that is served by a development
 * server in dev mode (`devOrigin`, where MoonCG sends the browser on to, query and all) is told
 * the dashboard's origin in its address, so that its dialogs speak to it. Every other page is
 * loaded as it is.
 */
export function framedUrl(url: string, origin: string, devOrigin?: string): string {
  if (devOrigin === undefined || !URL.canParse(url, origin)) return url;
  const target = new URL(url, origin);
  target.searchParams.set(DIALOG_HOST_PARAMETER, origin);
  return target.origin === origin
    ? `${target.pathname}${target.search}${target.hash}`
    : target.href;
}

/** A dialog of a bundle, as `GET /api/v1/bundles` lists it. */
export interface DialogInfo {
  readonly id: string;
  readonly title?: string | undefined;
  /** Width in dashboard grid columns. */
  readonly width?: number | undefined;
  readonly url: string;
}

/** The dialog that is open right now, as the page draws it. */
export interface OpenedDialog {
  readonly bundle: string;
  readonly dialog: DialogInfo;
  readonly title: string;
}

/** The part of an `<iframe>` the host looks at. */
interface FrameElement {
  readonly isConnected: boolean;
  readonly contentWindow: unknown;
}

/** A panel the dashboard shows right now, and the bundle it belongs to. */
export interface PanelFrame {
  readonly element: FrameElement;
  readonly bundle: string;
}

interface Postable {
  postMessage(message: unknown, targetOrigin: string): void;
}

export interface DialogHostEnvironment {
  /** The dashboard's own origin. Nothing else is believed, and nothing is sent elsewhere. */
  readonly origin: string;
  /** The panel frames on the page at this moment. */
  panels(): readonly PanelFrame[];
  /** The dialogs of a bundle the signed-in user may open. */
  dialogsOf(bundle: string): readonly DialogInfo[];
  /**
   * The origins besides the dashboard's own whose pages of a bundle are believed: in dev mode,
   * the development server its `dev.url` names, which serves its panels and dialogs. Empty
   * otherwise.
   */
  originsOf(bundle: string): readonly string[];
  /** The window of the dialog's own frame, once the page has drawn it. */
  dialogWindow(): unknown;
  /** Called with the dialog to draw, and with `undefined` when it is to be taken away. */
  onChange(open: OpenedDialog | undefined): void;
}

/**
 * The dashboard's side of dialogs. A panel asks for a dialog with a message; the host checks
 * where the message came from before it believes a word of it:
 *
 * - its source must be the window of a panel frame the dashboard itself put on the page,
 *   which is also how the host knows the bundle that is asking,
 * - its origin must be the dashboard's own, or, in dev mode, the origin of the development
 *   server of that very bundle,
 * - the dialog must be one of that bundle's, and one the user may open.
 *
 * What the dialog page says is believed only from the window of the dialog's own frame, at
 * the origin its address has. Every answer goes to the origin it was believed from, never to
 * `*`.
 */
export function createDialogHost(env: DialogHostEnvironment) {
  let open:
    | {
        readonly request: number;
        readonly opener: Postable;
        /** The origin the panel spoke from, which its answer goes to. */
        readonly openerOrigin: string;
        /** The bundle of the dialog, whose pages are believed from its origins alone. */
        readonly bundle: string;
        readonly frame: FrameElement;
        readonly dialog: DialogInfo;
        readonly data: Extract<DialogMessage, { t: 'open' }>['data'];
      }
    | undefined;

  /** The frames that have finished loading a page at least once. */
  const loadedOnce = new WeakSet<object>();

  const post = (target: Postable, message: DialogMessage, origin = env.origin) =>
    target.postMessage(message, origin);
  /** Whether a page of `bundle` may speak from `origin`. */
  const believed = (bundle: string, origin: string) =>
    origin === env.origin || env.originsOf(bundle).includes(origin);
  const forget = () => {
    open = undefined;
    env.onChange(undefined);
  };
  /** Closes the dialog and tells the panel that opened it. */
  const finish = (result: Extract<DialogMessage, { t: 'result' }>['result']) => {
    if (!open) return;
    post(
      open.opener,
      { channel: DIALOG_CHANNEL, t: 'result', id: open.request, result },
      open.openerOrigin,
    );
    forget();
  };

  return {
    /** Takes a `message` event of the dashboard's window. */
    receive(event: { readonly origin: string; readonly source: unknown; readonly data: unknown }) {
      if (event.source === null || event.source === undefined) return;
      const message = readDialogMessage(event.data);
      if (!message) return;

      if (open && event.source === env.dialogWindow()) {
        // From the dialog's own frame, at an origin of its bundle alone: the dashboard's, or in
        // dev mode the development server MoonCG sends the dialog page on to.
        if (!believed(open.bundle, event.origin)) return;
        const dialogPage = event.source as Postable;
        const dialogOrigin = event.origin;
        if (message.t === 'ready') {
          post(
            dialogPage,
            { channel: DIALOG_CHANNEL, t: 'init', dialog: open.dialog.id, data: open.data },
            dialogOrigin,
          );
        } else if (message.t === 'close') finish(message.result);
        else if (message.t === 'open') {
          // A dialog opens no dialog; it is told so instead of waiting for ever.
          post(
            dialogPage,
            {
              channel: DIALOG_CHANNEL,
              t: 'error',
              id: message.id,
              code: 'conflict',
              message: 'Another dialog is open',
            },
            dialogOrigin,
          );
        }
        return;
      }

      const panel = env.panels().find((frame) => frame.element.contentWindow === event.source);
      if (!panel || !believed(panel.bundle, event.origin)) return;
      const opener = event.source as Postable;
      const openerOrigin = event.origin;
      if (message.t === 'gone') {
        // Nobody is left to take a result.
        if (open?.opener === opener) forget();
        return;
      }
      if (message.t !== 'open') return;
      const refuse = (code: 'conflict' | 'not_found', text: string) =>
        post(
          opener,
          { channel: DIALOG_CHANNEL, t: 'error', id: message.id, code, message: text },
          openerOrigin,
        );
      if (open) {
        refuse('conflict', 'Another dialog is open');
        return;
      }
      // Looked up among the dialogs of the bundle the calling panel belongs to, and nowhere
      // else. A dialog the user may not open is not in that list, so it is not there.
      const dialog = env.dialogsOf(panel.bundle).find((item) => item.id === message.dialog);
      if (!dialog) {
        refuse('not_found', `There is no dialog "${message.dialog}"`);
        return;
      }
      open = {
        request: message.id,
        opener,
        openerOrigin,
        bundle: panel.bundle,
        frame: panel.element,
        dialog,
        data: message.data,
      };
      env.onChange({ bundle: panel.bundle, dialog, title: dialog.title ?? dialog.id });
    },
    /** The user closed the dialog: the panel gets `null`. */
    dismiss() {
      finish(null);
    },
    /**
     * Closes the dialog if the panel that opened it is no longer there: its frame was taken
     * off the page, or shows another window than the one that asked.
     */
    check() {
      if (!open) return;
      if (!open.frame.isConnected || open.frame.contentWindow !== open.opener) forget();
    },
    /**
     * A frame on the page finished loading. If it is the frame of the panel that opened the
     * dialog, the page that asked is gone, whether or not it managed to say so: a frame
     * keeps its window object when it loads another page. The first load of a frame is the
     * page itself arriving, which may have asked for a dialog while it was still loading.
     */
    loaded(frame: unknown) {
      if (typeof frame !== 'object' || frame === null) return;
      if (!loadedOnce.has(frame)) loadedOnce.add(frame);
      else if (open && open.frame === frame) forget();
    },
  };
}
