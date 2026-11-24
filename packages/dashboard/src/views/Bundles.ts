import { defineComponent, h, onMounted, ref } from 'vue';
import { type BundleAction, type BundleInfo, useBundles } from '../stores/bundles.js';
import { counted, dot, pageHead, segmented } from './parts.js';

const LABELS: Record<BundleAction, string> = {
  enable: 'Enable',
  disable: 'Disable',
  reload: 'Reload',
};
/** What makes each button stand out: the one way forward for a bundle that is off, most. */
const LOOKS: Record<BundleAction, string> = {
  enable: 'small primary',
  disable: 'small ghost',
  reload: 'small',
};

/** The states the list can be narrowed to. A bundle on its way between them shows under All. */
const STATES = ['running', 'failed', 'disabled'] as const;
type Filter = 'all' | (typeof STATES)[number];

/** Every bundle the user may see, with its state, and the buttons to change it. */
export const BundlesView = defineComponent({
  name: 'BundlesView',
  setup() {
    const bundles = useBundles();
    const filter = ref<Filter>('all');
    onMounted(() => void bundles.refresh());
    const actions = (bundle: BundleInfo): BundleAction[] =>
      bundle.state === 'disabled' ? ['enable'] : ['reload', 'disable'];
    const inState = (state: string) => bundles.list.filter((bundle) => bundle.state === state);

    /** What the list tells about a bundle besides its state. Nothing is made up. */
    const facts = (bundle: BundleInfo) => [
      // Panels and graphics are listed for a running bundle only, and only those the user
      // may use; what a bundle that does not run would bring is not known here.
      bundle.state === 'running'
        ? h(
            'div',
            `${counted(bundle.panels.length, 'panel')} · ${counted(bundle.graphics.length, 'graphic')}`,
          )
        : null,
      bundle.dependencies?.length ? h('div', `needs ${bundle.dependencies.join(', ')}`) : null,
    ];

    const row = (bundle: BundleInfo) =>
      h(
        'div',
        {
          key: bundle.name,
          class: ['bundle-row', { failed: bundle.state === 'failed' }],
          'data-bundle': bundle.name,
        },
        [
          h('div', { class: 'bundle-main' }, [
            h('div', { class: 'bundle-id' }, [
              dot(bundle.state),
              h('div', [
                h('strong', bundle.title ?? bundle.name),
                h('small', `${bundle.name} ${bundle.version ?? ''}`.trim()),
              ]),
            ]),
            h('div', { class: 'bundle-facts' }, facts(bundle)),
            h('div', h('span', { class: ['state', bundle.state] }, bundle.state)),
            h(
              'div',
              { class: 'bundle-actions' },
              // No button the server would refuse.
              bundles.canManage
                ? actions(bundle).map((action) =>
                    h(
                      'button',
                      {
                        type: 'button',
                        class: LOOKS[action],
                        onClick: () => bundles.change(bundle.name, action),
                      },
                      LABELS[action],
                    ),
                  )
                : [],
            ),
          ]),
          ...bundle.errors.map((error) => h('p', { class: 'problem' }, error)),
        ],
      );

    /** A key figure that is also a way to narrow the list to it; pressed again, it lets go. */
    const figure = (state: (typeof STATES)[number]) => {
      const names = inState(state).map((bundle) => bundle.name);
      return h(
        'button',
        {
          type: 'button',
          class: 'stat',
          'data-stat': state,
          'aria-pressed': String(filter.value === state),
          onClick: () => {
            filter.value = filter.value === state ? 'all' : state;
          },
        },
        [
          h('span', { class: 'stat-label' }, [dot(state), state]),
          h('span', { class: 'stat-value' }, String(names.length)),
          // Which ones failed is what there is to do next.
          state === 'failed' && names.length > 0
            ? h('span', { class: 'stat-hint' }, names.join(', '))
            : null,
        ],
      );
    };

    return () => {
      const shown =
        filter.value === 'all'
          ? bundles.list
          : bundles.list.filter((bundle) => bundle.state === filter.value);
      const graphics = inState('running').reduce((sum, bundle) => sum + bundle.graphics.length, 0);
      return h('div', [
        pageHead('Bundles', {
          description:
            'Reload a bundle to start it from what is on disk now. A disabled bundle stays disabled across restarts.',
          actions: segmented<Filter>({
            label: 'Filter',
            value: filter.value,
            choices: [
              { value: 'all', label: 'All', count: bundles.list.length },
              ...STATES.map((state) => ({
                value: state,
                label: state,
                count: inState(state).length,
              })),
            ],
            onChange: (value) => {
              filter.value = value;
            },
          }),
        }),
        bundles.problem ? h('p', { class: 'problem', role: 'alert' }, bundles.problem) : null,
        h('div', { class: 'stats' }, [
          ...STATES.map(figure),
          h('div', { class: 'stat', 'data-stat': 'graphics' }, [
            h('span', { class: 'stat-label' }, [dot('accent'), 'graphics']),
            h('span', { class: 'stat-value' }, String(graphics)),
            h('span', { class: 'stat-hint' }, 'served by running bundles'),
          ]),
        ]),
        bundles.loaded && bundles.list.length === 0
          ? h('p', { class: 'empty' }, 'There is no bundle you may use.')
          : null,
        bundles.list.length > 0 && shown.length === 0
          ? h('p', { class: 'empty' }, `No bundle is ${filter.value}.`)
          : null,
        shown.length > 0 ? h('section', { class: 'card' }, shown.map(row)) : null,
      ]);
    };
  },
});
