import { defineComponent, h, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { type BundleAction, type BundleInfo, useBundles } from '../stores/bundles.js';
import { describeSource, jobOver, useInstalls } from '../stores/installs.js';
import { useOnAir } from '../stores/onAir.js';
import { useRegistry } from '../stores/registry.js';
import { sure } from './admin.js';
import { BundleBackupsCard } from './BundleBackups.js';
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
    /** The bundle whose removal is being confirmed, and what is chosen for it. */
    const removing = ref<string>();
    const choices = reactive({ deleteFiles: false, purgeData: false });
    const askRemove = (name: string) => {
      removing.value = name;
      choices.deleteFiles = false;
      choices.purgeData = false;
    };
    /** Whether the files go for good: chosen, or because this server keeps no backups. */
    const filesDeleted = () => choices.deleteFiles || bundles.backupsKept === 0;
    /** What is left to restore a bundle from once the files of this version are deleted. */
    const olderBackups = (name: string) => {
      if (installs.backupsProblem) {
        return 'No backup of this version is kept. Whether older ones remain could not be read.';
      }
      const count = installs.backups.find((of) => of.name === name)?.backups.length ?? 0;
      if (count === 0) return 'No backup of this version is kept, and there is no older one.';
      return `No backup of this version is kept; ${count === 1 ? '1 older backup remains' : `${count} older backups remain`}.`;
    };
    /** The enabled bundles that need `name`, as far as the list shows them. */
    const dependents = (name: string) =>
      bundles.list
        .filter((other) => other.state !== 'disabled' && other.dependencies?.includes(name))
        .map((other) => other.name);
    const remove = (name: string) => {
      // A question of its own, about the bundles that need this one: they fail without it.
      const needed = dependents(name);
      const force =
        needed.length > 0 &&
        sure(
          `"${name}" is needed by ${needed.join(', ')}. Remove it anyway? ` +
            `${needed.length === 1 ? 'That bundle fails' : 'Those bundles fail'} until it is back.`,
        );
      if (needed.length > 0 && !force) return;
      // Then the lock, alone. Overriding it never stands in for the question above.
      const override = onAir.overrideFor(`Remove "${name}"`);
      if (override === undefined) return;
      removing.value = undefined;
      void installs.remove(name, {
        force,
        forceOnAir: override,
        deleteFiles: choices.deleteFiles,
        purgeData: choices.purgeData,
      });
    };

    /** The confirmation of a removal, in the bundle's row: the choices and what is lost. */
    const removePanel = (name: string) => {
      const option = (key: 'deleteFiles' | 'purgeData', text: string) =>
        h('label', { class: 'check' }, [
          h('input', {
            type: 'checkbox',
            name: key,
            checked: choices[key],
            onChange: (event: Event) => {
              choices[key] = (event.target as HTMLInputElement).checked;
            },
          }),
          ` ${text}`,
        ]);
      const files = filesDeleted()
        ? `Its files are deleted. ${olderBackups(name)}`
        : 'Its files are moved to the backups, from where it can be restored.';
      const data = choices.purgeData
        ? 'Its settings, uploaded assets, stored values and the role grants for it are deleted for good.'
        : 'Its settings, uploaded assets, stored values and the role grants for it are kept for when it comes back.';
      return h('div', { class: 'remove-panel', 'data-remove': name, role: 'group' }, [
        h('p', [h('strong', `Remove "${name}"?`), ` It is stopped. ${files} ${data}`]),
        h('div', { class: 'checks stack-checks' }, [
          bundles.backupsKept === 0
            ? null
            : option('deleteFiles', 'Also delete its files instead of keeping a backup'),
          option(
            'purgeData',
            'Also delete its data: settings, uploaded assets, stored values and the role grants for it',
          ),
        ]),
        h('div', { class: 'form-actions' }, [
          h(
            'button',
            {
              type: 'button',
              class: 'ghost',
              onClick: () => {
                removing.value = undefined;
              },
            },
            'Cancel',
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'danger',
              disabled: installs.busy(name),
              onClick: () => remove(name),
            },
            `Remove ${name}`,
          ),
        ]),
      ]);
    };
    const registry = useRegistry();
    onMounted(async () => {
      await bundles.refresh();
      // Update hints are for those who could act on them.
      if (bundles.canManage) await registry.loadUpdates();
    });
    // What an index offers changes once something was installed or updated.
    watch(
      () => installs.jobs.filter((job) => job.operation !== 'stage' && jobOver(job)).length,
      () => {
        if (bundles.canManage) void registry.loadUpdates();
      },
    );
    /** Fetches the newer version an index offers, as the update of the bundle. */
    const updateFromIndex = (name: string, index: string) =>
      registry.stage('bundle', index, name, { update: true });
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
              bundles.canManage && registry.updateFor('bundle', bundle.name)
                ? h(
                    'span',
                    { class: 'badge accent', 'data-badge': 'update' },
                    `Update available: ${registry.updateFor('bundle', bundle.name)?.available}`,
                  )
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
                    ...[registry.updateFor('bundle', bundle.name)].flatMap((hint) =>
                      hint
                        ? [
                            h(
                              'button',
                              {
                                type: 'button',
                                class: 'small primary',
                                'data-action': 'update-from-index',
                                disabled: installs.busy(bundle.name) || registry.sending,
                                title: `From ${hint.index.url}`,
                                onClick: () => updateFromIndex(bundle.name, hint.index.id),
                              },
                              `Update to ${hint.available}`,
                            ),
                          ]
                        : [],
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
                        onClick: () => askRemove(bundle.name),
                      },
                      'Remove',
                    ),
                  ]
                : [],
            ),
          ]),
          removing.value === bundle.name && bundles.canManage ? removePanel(bundle.name) : null,
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
          actions: [
            bundles.canManage
              ? h('a', { class: 'button small', href: '/bundles/catalog' }, 'Catalog')
              : null,
            segmented<Filter>({
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
          ],
        }),
        bundles.problem ? h('p', { class: 'problem', role: 'alert' }, bundles.problem) : null,
        registry.problem ? h('p', { class: 'problem', role: 'alert' }, registry.problem) : null,
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
        bundles.canManage ? h(BundleBackupsCard) : null,
      ]);
    };
  },
});
