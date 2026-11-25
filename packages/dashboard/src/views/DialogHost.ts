import { defineComponent, h, nextTick, onMounted, onUnmounted, ref, shallowRef } from 'vue';
import { createDialogHost, framedUrl, type OpenedDialog, type PanelFrame } from '../dialogs.js';
import { useBundles } from '../stores/bundles.js';

/** The attribute a workspace puts on each panel frame: the bundle the panel belongs to. */
export const PANEL_BUNDLE_ATTRIBUTE = 'data-panel-bundle';

const MAX_WIDTH = 12;

/**
 * Whether an origin is on this machine, as a development server of dev mode is, over `http:`
 * or `https:`, as the manifest's `dev.url` may be.
 */
const LOOPBACK = /^https?:\/\/(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])(:\d+)?$/;

/**
 * The origin of the development server a bundle's pages come from, as the server lists it in
 * dev mode alone (`devOrigin`), and only one on this machine. Nothing a page says decides it.
 */
export function devOriginOf(
  bundle: { readonly devOrigin?: string | undefined } | undefined,
): string | undefined {
  const origin = bundle?.devOrigin;
  return origin !== undefined && LOOPBACK.test(origin) ? origin : undefined;
}

/**
 * Draws the dialog a panel asked for over the whole dashboard, in a frame of its own. It
 * sits in the dashboard's frame once, whatever page is shown.
 */
export const DialogHost = defineComponent({
  name: 'DialogHost',
  setup() {
    const bundles = useBundles();
    const open = shallowRef<OpenedDialog>();
    const frame = ref<HTMLIFrameElement>();

    const host = createDialogHost({
      origin: location.origin,
      panels: () =>
        [...document.querySelectorAll<HTMLIFrameElement>(`iframe[${PANEL_BUNDLE_ATTRIBUTE}]`)].map(
          (element): PanelFrame => ({
            element,
            bundle: element.getAttribute(PANEL_BUNDLE_ATTRIBUTE) ?? '',
          }),
        ),
      dialogsOf: (bundle) => bundles.list.find((item) => item.name === bundle)?.dialogs ?? [],
      originsOf: (bundle) => {
        const origin = devOriginOf(bundles.list.find((item) => item.name === bundle));
        return origin === undefined ? [] : [origin];
      },
      dialogWindow: () => frame.value?.contentWindow ?? undefined,
      onChange: (next) => {
        open.value = next;
        // Keys go to the dialog while it is open.
        if (next) void nextTick().then(() => frame.value?.focus());
      },
    });

    const onDialogKey = (event: Event) => {
      const { key, isComposing } = event as KeyboardEvent;
      // Not the Escape that ends the composing of a character, and not one the dialog
      // page used for something of its own.
      if (key === 'Escape' && !isComposing && !event.defaultPrevented) host.dismiss();
    };
    const onMessage = (event: MessageEvent) => host.receive(event);
    // A panel that leaves the page takes its dialog with it.
    const observer =
      typeof MutationObserver === 'undefined'
        ? undefined
        : new MutationObserver(() => host.check());
    // `load` does not bubble, so it is caught on its way down.
    const onLoad = (event: Event) => host.loaded(event.target);
    onMounted(() => {
      window.addEventListener('message', onMessage);
      document.addEventListener('load', onLoad, true);
      observer?.observe(document.body, { childList: true, subtree: true });
    });
    onUnmounted(() => {
      window.removeEventListener('message', onMessage);
      document.removeEventListener('load', onLoad, true);
      observer?.disconnect();
    });

    return () => {
      const shown = open.value;
      if (!shown) return null;
      const width = Math.min(Math.max(shown.dialog.width ?? 3, 1), MAX_WIDTH);
      return h(
        'div',
        {
          class: 'dialog-backdrop',
          onKeydown: onDialogKey,
        },
        h(
          'section',
          {
            class: ['dialog', `dialog-w-${width}`],
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': shown.title,
            'data-dialog': `${shown.bundle}:${shown.dialog.id}`,
          },
          [
            h('header', [
              h('h2', shown.title),
              h(
                'button',
                { type: 'button', 'aria-label': 'Close', onClick: () => host.dismiss() },
                '×',
              ),
            ]),
            h('iframe', {
              ref: frame,
              src: framedUrl(
                shown.dialog.url,
                location.origin,
                devOriginOf(bundles.list.find((item) => item.name === shown.bundle)),
              ),
              title: shown.title,
              // The dialog page has the focus, so its window gets the keys, not this one.
              onLoad: (event: Event) => {
                try {
                  (event.target as HTMLIFrameElement).contentWindow?.addEventListener(
                    'keydown',
                    onDialogKey,
                  );
                } catch {
                  // A page of another origin: Escape then works from the dashboard only.
                }
              },
            }),
          ],
        ),
      );
    };
  },
});
