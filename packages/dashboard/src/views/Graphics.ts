import { defineComponent, h, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { api, messageOf } from '../api.js';
import { live } from '../live.js';
import { type GraphicInfo, useBundles } from '../stores/bundles.js';
import { part } from './admin.js';

/** One page that shows a graphic right now, as the server lists it. */
interface Instance {
  readonly id: string;
  readonly since: string;
}

/** Who a connected page acts as. Told only to whoever may manage bundles. */
interface Holder {
  readonly id: string;
  readonly principal: string;
  readonly kind: string;
  readonly name: string | null;
}

/** The graphics of every bundle: the URL for OBS or vMix, and where each is open right now. */
export const GraphicsView = defineComponent({
  name: 'GraphicsView',
  setup() {
    const bundles = useBundles();
    const problem = ref('');
    /** The connected pages of each graphic, by `bundle:graphic`. */
    const instances = reactive(new Map<string, readonly Instance[]>());
    /** Who each connected page acts as, by instance id; empty for who may not know. */
    const holders = reactive(new Map<string, Holder>());
    const following = new Map<string, () => void>();
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
    const keys = () =>
      bundles.list.flatMap((bundle) => bundle.graphics.map((item) => `${bundle.name}:${item.id}`));

    // Each graphic's list is followed while the graphic is on the page.
    watch(
      () => keys().join(),
      () => {
        const wanted = new Set(keys());
        for (const [key, stop] of following) {
          if (wanted.has(key)) continue;
          stop();
          following.delete(key);
          instances.delete(key);
        }
        for (const key of wanted) {
          if (following.has(key)) continue;
          const [bundle, graphic] = key.split(':');
          following.set(
            key,
            live.follow<readonly Instance[]>(`${bundle}:$instances.${graphic}`, (value) => {
              instances.set(key, Array.isArray(value) ? value : []);
              void loadHolders(bundle as string);
            }),
          );
        }
      },
      { immediate: true },
    );
    onMounted(() => void bundles.refresh());
    onUnmounted(() => {
      for (const stop of following.values()) stop();
      following.clear();
    });

    const copy = (text: string) => navigator.clipboard?.writeText(text);
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
      const list = instances.get(`${bundle}:${graphic.id}`);
      // Not told yet, or not allowed to know.
      if (list === undefined) return null;
      if (list.length === 0) return h('p', { class: 'muted' }, 'Not open anywhere.');
      return h(
        'ul',
        { class: 'instances' },
        list.map((instance) =>
          h('li', { key: instance.id, 'data-instance': instance.id }, [
            h('span', openBy(instance.id)),
            h('span', { class: 'muted' }, ` since ${new Date(instance.since).toLocaleString()} `),
            // No button the server would refuse. Disconnecting frees the place of a
            // graphic that takes one instance; the page does not come back by itself.
            ...(bundles.canManage
              ? (['reload', 'disconnect'] as const).map((action) =>
                  h(
                    'button',
                    {
                      type: 'button',
                      'data-action': action,
                      onClick: () => act(bundle, instance.id, action),
                    },
                    action === 'reload' ? 'Reload' : 'Disconnect',
                  ),
                )
              : []),
          ]),
        ),
      );
    };

    return () => {
      const withGraphics = bundles.list.filter((bundle) => bundle.graphics.length > 0);
      return h('div', [
        h('h1', 'Graphics'),
        h(
          'p',
          { class: 'muted' },
          'A browser source needs an API token in the URL: append ?token=mcg_… to it.',
        ),
        problem.value ? h('p', { class: 'problem', role: 'alert' }, problem.value) : null,
        bundles.loaded && withGraphics.length === 0
          ? h('p', { class: 'empty' }, 'There is no graphic you may open.')
          : null,
        ...withGraphics.map((bundle) =>
          h('section', { key: bundle.name }, [
            h('h2', bundle.title ?? bundle.name),
            h(
              'ul',
              { class: 'rows' },
              bundle.graphics.map((graphic) => {
                const url = `${location.origin}${graphic.url}`;
                return h(
                  'li',
                  { key: graphic.id, 'data-graphic': `${bundle.name}:${graphic.id}` },
                  [
                    h(
                      'a',
                      { href: graphic.url, target: '_blank', rel: 'noopener' },
                      graphic.title ?? graphic.id,
                    ),
                    h('span', { class: 'muted' }, ` ${graphic.width}×${graphic.height} `),
                    graphic.singleInstance
                      ? h('span', { class: 'muted' }, 'takes one instance ')
                      : null,
                    h('input', {
                      readonly: true,
                      value: url,
                      'aria-label': `URL of ${graphic.id}`,
                    }),
                    h('button', { type: 'button', onClick: () => copy(url) }, 'Copy'),
                    open(bundle.name, graphic),
                  ],
                );
              }),
            ),
          ]),
        ),
      ]);
    };
  },
});
