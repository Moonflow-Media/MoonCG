import { defineComponent, h, nextTick, onMounted, onUnmounted, ref, shallowRef } from 'vue';
import { createDialogHost, type OpenedDialog, type PanelFrame } from '../dialogs.js';
import { useBundles } from '../stores/bundles.js';

/** The attribute a workspace puts on each panel frame: the bundle the panel belongs to. */
export const PANEL_BUNDLE_ATTRIBUTE = 'data-panel-bundle';

const MAX_WIDTH = 12;

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
      dialogWindow: () => frame.value?.contentWindow ?? undefined,
      onChange: (next) => {
        open.value = next;
        // Keys go to the dialog while it is open.
        if (next) void nextTick().then(() => frame.value?.focus());
      },
    });

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
          onKeydown: (event: KeyboardEvent) => {
            if (event.key === 'Escape') host.dismiss();
          },
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
            h('iframe', { ref: frame, src: shown.dialog.url, title: shown.title }),
          ],
        ),
      );
    };
  },
});
