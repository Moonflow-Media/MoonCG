import { defineComponent, h, onMounted, onUnmounted, reactive, ref } from 'vue';
import { api, messageOf } from '../api.js';
import { type BundleInfo, type GraphicInfo, useBundles } from '../stores/bundles.js';
import { useInstances } from '../stores/instances.js';
import { part } from './admin.js';
import { dot, pageHead } from './parts.js';

/** Who a connected page acts as. Told only to whoever may manage bundles. */
interface Holder {
  readonly id: string;
  readonly principal: string;
  readonly kind: string;
  readonly name: string | null;
}

/** How long a button says that it copied. */
const COPIED_MS = 2000;

/**
 * The graphics of every bundle: the URL for OBS or vMix, and where each is open right now.
 * The page draws no preview of a graphic: a page that loads one is an instance of it, and
 * would take the place of a graphic that takes one instance from what is on air.
 */
export const GraphicsView = defineComponent({
  name: 'GraphicsView',
  setup() {
    const bundles = useBundles();
    const instances = useInstances();
    const problem = ref('');
    /** Who each connected page acts as, by instance id; empty for who may not know. */
    const holders = reactive(new Map<string, Holder>());
    /** The graphic whose URL was copied a moment ago, as `bundle:graphic`. */
    const copied = ref('');
    let copiedTimer: ReturnType<typeof setTimeout> | undefined;
    const loadHolders = async (bundle: string) => {
      if (!bundles.canManage) return;
      try {
        const answer = await api.request<{ instances: Holder[] }>(
          'GET',
          `/api/v1/bundles/${part(bundle)}/instances`,
        );
        for (const holder of answer.instances) holders.set(holder.id, holder);
      } catch {
        // The list still says that a page is connected; only by whom stays open.
      }
    };

    // Each graphic's list is followed while the page is open; who holds a place is asked
    // again whenever a list changes.
    const stop = instances.follow((bundle) => void loadHolders(bundle));
    onMounted(() => void bundles.refresh());
    onUnmounted(() => {
      stop();
      clearTimeout(copiedTimer);
    });

    const copy = async (key: string, text: string, event: Event) => {
      const field = (event.currentTarget as HTMLElement).parentElement?.querySelector('input');
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Not allowed, or no clipboard on a page that is not served securely. Nothing is
        // claimed; the URL is selected, so that copying it by hand is one key away.
        field?.select();
        return;
      }
      copied.value = key;
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => {
        copied.value = '';
      }, COPIED_MS);
    };
    const act = async (bundle: string, id: string, action: 'reload' | 'disconnect') => {
      problem.value = '';
      try {
        await api.request(
          'POST',
          `/api/v1/bundles/${part(bundle)}/instances/${part(id)}/${action}`,
        );
      } catch (error) {
        problem.value = `Could not ${action} the graphic: ${messageOf(error)}`;
      }
    };
    const openBy = (id: string) => {
      const holder = holders.get(id);
      if (!holder) return 'Open';
      return `Open by ${holder.name === null ? holder.principal : `${holder.name} (${holder.kind})`}`;
    };

    const open = (bundle: string, graphic: GraphicInfo) => {
      const list = instances.byGraphic.get(`${bundle}:${graphic.id}`);
      // Not told yet, or not allowed to know.
      if (list === undefined) return [];
      if (list.length === 0) return [h('p', { class: 'muted' }, 'Not open anywhere.')];
      return list.map((instance) =>
        h('div', { key: instance.id, class: 'instance', 'data-instance': instance.id }, [
          dot('running'),
          h('span', openBy(instance.id)),
          h('span', { class: 'muted' }, ` since ${new Date(instance.since).toLocaleString()} `),
          // No button the server would refuse. Disconnecting frees the place of a
          // graphic that takes one instance; the page does not come back by itself.
          bundles.canManage
            ? h(
                'span',
                { class: 'actions' },
                (['reload', 'disconnect'] as const).map((action) =>
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'small ghost',
                      'data-action': action,
                      onClick: () => act(bundle, instance.id, action),
                    },
                    action === 'reload' ? 'Reload' : 'Disconnect',
                  ),
                ),
              )
            : null,
        ]),
      );
    };

    const card = (bundle: BundleInfo, graphic: GraphicInfo) => {
      const key = `${bundle.name}:${graphic.id}`;
      const url = `${location.origin}${graphic.url}`;
      const onAir = (instances.byGraphic.get(key)?.length ?? 0) > 0;
      return h('section', { key, class: 'card', 'data-graphic': key }, [
        h('div', { class: 'graphic-body' }, [
          h('div', { class: 'graphic-title' }, [
            h(
              'a',
              { href: graphic.url, target: '_blank', rel: 'noopener' },
              `${bundle.title ?? bundle.name} · ${graphic.title ?? graphic.id}`,
            ),
            h('span', { class: 'badge' }, `${graphic.width}×${graphic.height}`),
            graphic.singleInstance
              ? h('span', { class: 'badge accent' }, 'takes one instance')
              : null,
            onAir ? h('span', { class: 'badge live' }, [dot(), 'On air']) : null,
          ]),
          h('div', { class: 'copy-field' }, [
            h('input', { readonly: true, value: url, 'aria-label': `URL of ${graphic.id}` }),
            h(
              'button',
              {
                type: 'button',
                class: 'small',
                'aria-label': `Copy URL of ${graphic.id}`,
                onClick: (event: Event) => copy(key, url, event),
              },
              copied.value === key ? 'Copied' : 'Copy',
            ),
            // Said as well as shown, for whoever does not see the button change.
            h(
              'span',
              { class: 'visually-hidden', role: 'status' },
              copied.value === key ? 'Copied' : '',
            ),
          ]),
          ...open(bundle.name, graphic),
        ]),
      ]);
    };

    return () => {
      const withGraphics = bundles.list.filter((bundle) => bundle.graphics.length > 0);
      return h('div', [
        pageHead('Graphics', {
          badge:
            instances.open > 0
              ? h('span', { class: 'badge live' }, [dot(), `${instances.open} open`])
              : null,
          description: 'A browser source needs an API token in the URL: append ?token=mcg_… to it.',
        }),
        problem.value ? h('p', { class: 'problem', role: 'alert' }, problem.value) : null,
        bundles.loaded && withGraphics.length === 0
          ? h('p', { class: 'empty' }, 'There is no graphic you may open.')
          : null,
        h(
          'div',
          { class: 'cards-2' },
          withGraphics.flatMap((bundle) => bundle.graphics.map((graphic) => card(bundle, graphic))),
        ),
      ]);
    };
  },
});
