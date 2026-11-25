import { defineComponent, h, onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api.js';
import { useOnAir } from '../stores/onAir.js';
import { useRegistry } from '../stores/registry.js';
import { useSession } from '../stores/session.js';
import { part, sure, useActions } from './admin.js';
import { ModuleInstall, outcomeOf, settled } from './ModuleInstall.js';
import { pageHead } from './parts.js';

export { moduleInstallTiming } from './ModuleInstall.js';

interface Module {
  readonly name: string;
  readonly title?: string;
  readonly version?: string;
  /** Shipped with MoonCG. */
  readonly builtin: boolean;
  /** Part of the server itself: it always runs. */
  readonly internal: boolean;
  readonly enabled: boolean;
  readonly state: 'running' | 'disabled' | 'failed';
  readonly error?: string;
  /** Whether it has settings. */
  readonly config: boolean;
  /** The ids of the ways to sign in it provides. */
  readonly providers: readonly string[];
  readonly permissions: readonly { readonly permission: string }[];
  readonly routes: number;
}

/** What a module is, for whoever is about to turn one on. */
const ABOUT = [
  'A module is code that runs inside the server, with everything the server may do. Enable only what you trust.',
  'A module in the modules folder does nothing until it is enabled here. Enabling starts it at once, and the server remembers the choice.',
  'Disabling stops it and takes away what it added: its ways to sign in, its routes and its permissions.',
  'Install a module below: it is fetched and checked first, and installed disabled. A module that came with MoonCG is updated with MoonCG.',
] as const;

/** The modules of the installation: what runs inside the server, and switching it on and off. */
export const ModulesView = defineComponent({
  name: 'ModulesView',
  setup() {
    const modules = ref<Module[]>([]);
    const { run, send, alert } = useActions(async () => {
      modules.value = (await api.request<{ modules: Module[] }>('GET', '/api/v1/modules')).modules;
    });
    const registry = useRegistry();
    onMounted(() => run(async () => {}));
    // The hints arrive live too, for whoever may install modules.
    const unfollow = useSession().can('system:modules.manage')
      ? registry.followUpdates(['module'])
      : () => {};
    onUnmounted(unfollow);
    onMounted(() => registry.loadUpdates());
    const onAir = useOnAir();
    const installer = ref<{
      update(name: string): Promise<void>;
      updateFromIndex(name: string, index: string): Promise<void>;
    }>();
    const removed = ref<{ text: string; ok: boolean }>();

    const remove = (module: Module) => {
      const question =
        `Remove the module "${module.name}"? It is stopped and its files are deleted. ` +
        'Its configuration is kept for when it is installed again.';
      if (!sure(question)) return;
      // Removing an enabled module interrupts what it does: that is the lock's question.
      const override = module.enabled
        ? onAir.overrideFor(`Remove the module "${module.name}"`)
        : false;
      if (override === undefined) return;
      return run(async () => {
        removed.value = undefined;
        const job = await settled(
          await api.request(
            'POST',
            `/api/v1/modules/${part(module.name)}/remove`,
            override ? { forceOnAir: true } : {},
          ),
        );
        removed.value = outcomeOf(job);
      });
    };

    const change = (module: Module, action: 'enable' | 'disable') =>
      send('POST', `/api/v1/modules/${part(module.name)}/${action}`, {});
    const disable = (module: Module) => {
      // Whoever signs in through the module can no longer do so: that is worth a question.
      const lost =
        module.providers.length === 0
          ? ''
          : ` Nobody can sign in with ${module.providers.join(', ')} while it is off.`;
      return sure(`Disable the module "${module.name}"?${lost}`) && change(module, 'disable');
    };

    const actions = (module: Module) => {
      if (module.internal) return h('span', { class: 'muted' }, 'part of the server');
      // What came with MoonCG is updated with it; what was installed can be updated here.
      const hint = registry.updateFor('module', module.name);
      const installed = module.builtin
        ? []
        : [
            hint
              ? h(
                  'button',
                  {
                    type: 'button',
                    class: 'small primary',
                    'data-action': 'update-from-index',
                    title: `From ${hint.index.url}`,
                    onClick: () => installer.value?.updateFromIndex(module.name, hint.index.id),
                  },
                  `Update to ${hint.available}`,
                )
              : null,
            h(
              'button',
              {
                type: 'button',
                class: 'small',
                'data-action': 'update',
                onClick: () => installer.value?.update(module.name),
              },
              'Update',
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'small danger',
                'data-action': 'remove',
                onClick: () => remove(module),
              },
              'Remove',
            ),
          ];
      return [
        module.config ? h('a', { href: '/settings' }, 'Settings') : null,
        module.state === 'running'
          ? h(
              'button',
              {
                type: 'button',
                class: 'small',
                'data-action': 'disable',
                onClick: () => disable(module),
              },
              'Disable',
            )
          : h(
              'button',
              {
                type: 'button',
                class: 'small primary',
                'data-action': 'enable',
                onClick: () => change(module, 'enable'),
              },
              module.state === 'failed' ? 'Try again' : 'Enable',
            ),
        // A module that failed stays enabled, and would be tried again at the next start.
        module.state === 'failed'
          ? h(
              'button',
              {
                type: 'button',
                class: 'small',
                'data-action': 'disable',
                onClick: () => disable(module),
              },
              'Disable',
            )
          : null,
        ...installed,
      ];
    };

    const row = (module: Module) =>
      h('li', { key: module.name, 'data-module': module.name }, [
        h('strong', module.title ?? module.name),
        h('span', { class: ['state', module.state] }, module.state),
        module.builtin ? h('span', { class: 'badge' }, 'built in') : null,
        registry.updateFor('module', module.name)
          ? h(
              'span',
              { class: 'badge accent', 'data-badge': 'update' },
              `Update available: ${registry.updateFor('module', module.name)?.available}`,
            )
          : null,
        h(
          'span',
          { class: 'muted' },
          [module.title === undefined ? null : module.name, module.internal ? null : module.version]
            .filter((text) => text != null)
            .join(' '),
        ),
        module.providers.length > 0
          ? h('span', { class: 'muted' }, `Sign-in: ${module.providers.join(', ')}`)
          : null,
        h('span', { class: 'row-actions' }, actions(module)),
        module.error === undefined ? null : h('p', { class: 'problem' }, module.error),
      ]);

    return () =>
      h('div', [
        pageHead('Modules', {
          description:
            'Code that runs inside the server, such as sign-in with an external account.',
          actions: h(
            'a',
            { class: 'button small', href: '/bundles/catalog?kind=module' },
            'Catalog',
          ),
        }),
        alert(),
        removed.value
          ? h(
              'p',
              { class: removed.value.ok ? 'done' : 'problem', role: 'status' },
              removed.value.text,
            )
          : null,
        h('div', { class: 'split' }, [
          h('section', { class: 'card' }, h('ul', { class: 'rows' }, modules.value.map(row))),
          h('section', { class: 'card', 'data-help': 'modules' }, [
            h('div', { class: 'card-head' }, h('h2', 'What a module is')),
            h(
              'div',
              { class: 'card-body' },
              h(
                'ul',
                { class: 'help' },
                ABOUT.map((line) => h('li', { key: line }, line)),
              ),
            ),
          ]),
        ]),
        h(ModuleInstall, {
          ref: installer,
          onChanged: () => {
            void run(async () => {});
            void registry.loadUpdates();
          },
        }),
      ]);
  },
});
