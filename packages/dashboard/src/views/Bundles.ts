import { defineComponent, h, onMounted } from 'vue';
import { type BundleAction, type BundleInfo, useBundles } from '../stores/bundles.js';

const LABELS: Record<BundleAction, string> = {
  enable: 'Enable',
  disable: 'Disable',
  reload: 'Reload',
};

/** Every bundle the user may see, with its state, and the buttons to change it. */
export const BundlesView = defineComponent({
  name: 'BundlesView',
  setup() {
    const bundles = useBundles();
    onMounted(() => void bundles.refresh());
    const actions = (bundle: BundleInfo): BundleAction[] =>
      bundle.state === 'disabled' ? ['enable'] : ['reload', 'disable'];

    return () =>
      h('div', [
        h('h1', 'Bundles'),
        bundles.problem ? h('p', { class: 'problem', role: 'alert' }, bundles.problem) : null,
        bundles.loaded && bundles.list.length === 0
          ? h('p', { class: 'empty' }, 'There is no bundle you may use.')
          : null,
        h(
          'ul',
          { class: 'rows' },
          bundles.list.map((bundle) =>
            h('li', { key: bundle.name, 'data-bundle': bundle.name }, [
              h('strong', bundle.title ?? bundle.name),
              h('span', { class: 'muted' }, ` ${bundle.name} ${bundle.version ?? ''} `),
              h('span', { class: ['state', bundle.state] }, bundle.state),
              // No button the server would refuse.
              ...(bundles.canManage
                ? actions(bundle).map((action) =>
                    h(
                      'button',
                      { type: 'button', onClick: () => bundles.change(bundle.name, action) },
                      LABELS[action],
                    ),
                  )
                : []),
              ...bundle.errors.map((error) => h('p', { class: 'problem' }, error)),
            ]),
          ),
        ),
      ]);
  },
});
