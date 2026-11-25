import { defineComponent, h, nextTick, onMounted, ref } from 'vue';
import { type BundleAction, type BundleInfo, useBundles } from '../stores/bundles.js';
import { describeSource, useInstalls } from '../stores/installs.js';
import { useOnAir } from '../stores/onAir.js';
import { sure } from './admin.js';
import { BundleInstall } from './BundleInstall.js';
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
    const installs = useInstalls();
    const onAir = useOnAir();
    const filter = ref<Filter>('all');
    /** Changes a bundle's state. While on air, what interrupts it is asked about first. */
    const change = (name: string, action: BundleAction) => {
      const override =
        action === 'enable' ? false : onAir.overrideFor(`${LABELS[action]} "${name}"`);
      if (override !== undefined) void bundles.change(name, action, override);
    };
    /** The bundle the install form is set to update. */
    const updating = ref<string>();
    const update = async (name: string) => {
      updating.value = name;
      await nextTick();
      // The form is below the list; whoever pressed the button is taken to it.
      document.querySelector('.install')?.scrollIntoView?.({ block: 'nearest' });
    };
    const remove = (name: string) => {
      // A server that keeps no backups deletes the files; the question says what happens.
      const files =
        bundles.backupsKept === 0 ? 'its files are deleted' : 'its files are moved to the backups';
      const question =
        `Remove "${name}"? It is stopped and ${files}. ` +
        'Its settings, uploaded assets and stored values are kept.';
      if (!sure(question)) return;
      // A second question, about being on air alone. It overrides the lock and nothing
      // else: a bundle that others still need is refused by the server as it always was.
      const override = onAir.overrideFor(`Remove "${name}"`);
      if (override !== undefined) void installs.remove(name, override);
    };
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
      bundle.source ? h('div', `from ${describeSource(bundle.source)}`) : null,
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
            h('div', { class: 'bundle-state' }, [
              h('span', { class: ['state', bundle.state] }, bundle.state),
              bundle.reloadErrors?.length
                ? h('span', { class: 'badge failed', 'data-badge': 'not-reloaded' }, 'not reloaded')
                : null,
              bundle.pendingChanges?.length
                ? h(
                    'span',
                    {
                      class: 'badge warn',
                      'data-badge': 'pending',
                      title: `Changed on disk while on air: ${bundle.pendingChanges.join(', ')}. Applied when On Air ends.`,
                    },
                    'changes pending',
                  )
                : null,
            ]),
            h(
              'div',
              { class: 'bundle-actions' },
              // No button the server would refuse.
              bundles.canManage
                ? [
                    ...actions(bundle).map((action) =>
                      h(
                        'button',
                        {
                          type: 'button',
                          class: LOOKS[action],
                          // Not while it is being updated or removed.
                          disabled: installs.busy(bundle.name),
                          onClick: () => change(bundle.name, action),
                        },
                        LABELS[action],
                      ),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        class: 'small',
                        disabled: installs.busy(bundle.name),
                        onClick: () => update(bundle.name),
                      },
                      'Update',
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        class: 'small danger',
                        disabled: installs.busy(bundle.name),
                        onClick: () => remove(bundle.name),
                      },
                      'Remove',
                    ),
                  ]
                : [],
            ),
          ]),
          ...bundle.errors.map((error) => h('p', { class: 'problem' }, error)),
          // The files on disk could not be loaded; what ran before keeps running.
          ...(bundle.reloadErrors ?? []).map((error) =>
            h(
              'p',
              { class: 'problem' },
              `Not reloaded, the version from before keeps running: ${error}`,
            ),
          ),
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
        onAir.onAir
          ? h(
              'p',
              { class: 'on-air-note', 'data-on-air-note': '' },
              'On Air: updating, removing, disabling and reloading a bundle is blocked, and changed files wait. Each button asks before it does it anyway.',
            )
          : null,
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
        // Installing is for those who manage bundles; nobody else is shown any of it.
        bundles.canManage
          ? h(BundleInstall, {
              target: updating.value,
              onCancel: () => {
                updating.value = undefined;
              },
            })
          : null,
      ]);
    };
  },
});
