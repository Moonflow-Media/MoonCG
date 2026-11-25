import { defineComponent, h, onUnmounted, type PropType, reactive, ref } from 'vue';
import { useBundles } from '../stores/bundles.js';
import {
  describeSource,
  type JobInfo,
  jobOver,
  type StagedInfo,
  useInstalls,
} from '../stores/installs.js';
import { readableSize } from './Assets.js';
import { field } from './admin.js';
import { counted, segmented } from './parts.js';

type Mode = 'git' | 'zip';

/** What a job does, as a sentence begins. */
function label(job: JobInfo): string {
  const bundle = job.bundle ?? 'the bundle';
  if (job.operation === 'stage') return 'Fetching the bundle';
  if (job.operation === 'install') return `Installing ${bundle}`;
  if (job.operation === 'update') return `Updating ${bundle}`;
  return job.operation === 'remove' ? `Removing ${bundle}` : `Restoring ${bundle}`;
}

const list = (items: readonly string[]) => (items.length === 0 ? 'none' : items.join(', '));

/** Whether installing the bundle runs code on the server before the bundle is ever started. */
function installCode(staged: StagedInfo): string {
  const { npm } = staged;
  const kind = staged.installCode ?? (npm.needed ? 'on-request' : 'none');
  if (kind === 'none') return 'No';
  if (kind === 'on-request') {
    return 'No, unless the install scripts of its npm packages are allowed below';
  }
  const what = [
    ...(npm.config ?? []).map((file) => `it brings ${file}`),
    ...(npm.unusual ?? []),
    'the install scripts of its npm packages',
  ];
  return `Yes, as was allowed when it was fetched: ${what.join('; ')}`;
}

/** The role grants a bundle proposes, and whether installing it makes them. */
function roleGrants(staged: StagedInfo): string {
  const grants = Object.entries(staged.roles?.grants ?? {})
    .filter(([, permissions]) => permissions.length > 0)
    .map(([role, permissions]) => `${role}: ${permissions.join(', ')}`);
  if (grants.length === 0) return 'none';
  const applied = staged.roles?.applies
    ? 'granted when it is installed'
    : 'not granted: a bundle of this name was installed before, and the roles are as they were left';
  return `${grants.join('; ')} (${applied})`;
}

/** What a fetched bundle declares, as terms and what is to be said about each. */
function facts(staged: StagedInfo): [term: string, value: string][] {
  const { npm } = staged;
  return [
    ['Source', describeSource(staged.source)],
    [
      'Server code',
      staged.extension ? 'Yes: it brings an extension that runs on the server' : 'No',
    ],
    ['Runs code on install', installCode(staged)],
    [
      'Permissions',
      list(
        staged.permissions.map(({ name, description }) =>
          description === '' ? name : `${name} (${description})`,
        ),
      ),
    ],
    ['Role grants', roleGrants(staged)],
    ['Capabilities', list(staged.capabilities)],
    [
      'Needs bundles',
      list(Object.entries(staged.dependencies).map(([name, range]) => `${name} ${range}`)),
    ],
    ...(staged.engine === undefined ? [] : [['Needs MoonCG', staged.engine] as [string, string]]),
    [
      'npm packages',
      npm.dependencies.length === 0
        ? 'none'
        : `${npm.dependencies.join(', ')}, ${
            npm.needed ? 'installed before the bundle starts' : 'brought along with the bundle'
          }`,
    ],
    [
      'Provides',
      [
        counted(staged.panels, 'panel'),
        counted(staged.dialogs, 'dialog'),
        counted(staged.graphics, 'graphic'),
        counted(staged.assets, 'asset category', 'asset categories'),
        ...(staged.config ? ['settings'] : []),
      ].join(', '),
    ],
    ['Size', `${counted(staged.files, 'file')}, ${readableSize(staged.bytes)}`],
  ];
}

/**
 * Installing a bundle, or updating the bundle `target`: where to fetch it from, what is
 * going on, and each fetched bundle with what it declares and the two ways to decide about
 * it. Drawn only for those who may manage bundles.
 */
export const BundleInstall = defineComponent({
  name: 'BundleInstall',
  props: {
    /** The installed bundle the form updates. Without it, the form installs a new one. */
    target: { type: String as PropType<string | undefined>, default: undefined },
  },
  emits: ['cancel'],
  setup(props, { emit }) {
    const bundles = useBundles();
    const installs = useInstalls();
    const mode = ref<Mode>('git');
    /** Whether the install scripts of npm packages may run, by staged bundle. */
    const scripts = reactive(new Map<string, boolean>());
    /** Whether the bundle that is fetched next is trusted to run code while it is installed. */
    const trust = ref(false);
    /** Takes the trust for one fetch: it is asked for again every time. */
    const trusted = () => {
      const given = trust.value;
      trust.value = false;
      return given;
    };
    const stop = installs.follow();
    onUnmounted(stop);

    const fetchGit = async (event: Event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      const url = field(event, 'url');
      if (url.trim() === '') return;
      await installs.stageGit(url, field(event, 'ref'), props.target, trusted());
      if (installs.problem === '') form.reset();
    };
    const upload = async (event: Event) => {
      const input = event.target as HTMLInputElement;
      const [file] = [...(input.files ?? [])];
      if (file) await installs.stageUpload(file, props.target, trusted());
      // So that choosing the same file again is a change again.
      input.value = '';
    };

    /** How the job this page started last ended, if it has. */
    const outcome = (job: JobInfo) => {
      if (job.state === 'failed') {
        const restore =
          job.rollbackError === undefined
            ? ''
            : ` The earlier version could not be restored: ${job.rollbackError}`;
        return h(
          'p',
          { key: job.id, class: 'problem', role: 'alert' },
          `${label(job)} failed: ${job.error ?? 'no reason was given'}${restore}`,
        );
      }
      if (job.state === 'rolled-back') {
        return h(
          'p',
          { key: job.id, class: 'problem', role: 'alert' },
          `${label(job)} failed and was rolled back; the earlier version is in place again: ${job.error ?? ''}`,
        );
      }
      // A fetch that worked shows as the bundle it fetched.
      return job.operation === 'stage'
        ? null
        : h('p', { key: job.id, class: 'done', role: 'status' }, `${label(job)} is done.`);
    };

    const card = (staged: StagedInfo) => {
      const isUpdate = staged.target !== undefined;
      return h('section', { key: staged.id, class: 'card staged', 'data-staged': staged.id }, [
        h('div', { class: 'card-head' }, [
          h('h2', `${staged.title ?? ''} ${staged.name} ${staged.version}`.trim()),
          h(
            'span',
            { class: 'badge accent' },
            isUpdate ? `Update of ${staged.replaces ?? 'an unknown version'}` : 'New',
          ),
        ]),
        h('div', { class: 'card-body' }, [
          h(
            'dl',
            { class: 'facts' },
            facts(staged).map(([term, value]) => h('div', [h('dt', term), h('dd', value)])),
          ),
          staged.npm.needed && staged.installCode !== 'allowed'
            ? h('label', { class: 'check' }, [
                h('input', {
                  type: 'checkbox',
                  checked: scripts.get(staged.id) === true,
                  onChange: (event: Event) =>
                    scripts.set(staged.id, (event.target as HTMLInputElement).checked),
                }),
                ' Let the install scripts of these packages run. They are programs that run on the server.',
              ])
            : null,
          h('div', { class: 'form-actions' }, [
            h(
              'button',
              {
                type: 'button',
                class: 'ghost',
                disabled: installs.sending,
                onClick: () => installs.discard(staged.id),
              },
              'Discard',
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'primary',
                disabled: installs.sending,
                onClick: () =>
                  installs.commit(
                    staged.id,
                    staged.installCode === 'allowed' || scripts.get(staged.id) === true,
                  ),
              },
              isUpdate ? 'Update' : 'Install',
            ),
          ]),
        ]),
      ]);
    };

    return () => {
      const { target } = props;
      const source = bundles.list.find((bundle) => bundle.name === target)?.source;
      const running = installs.jobs.filter((job) => !jobOver(job));
      const ended = installs.jobs.filter((job) => installs.mine.includes(job.id) && jobOver(job));
      // One thing at a time from this form: what it started is still on its way.
      const working = installs.sending || running.some((job) => installs.mine.includes(job.id));
      return h('div', { class: 'column' }, [
        ...installs.staged.map(card),
        h('section', { class: 'card install' }, [
          h('div', { class: 'card-head' }, [
            h('h2', target === undefined ? 'Install bundle' : `Update ${target}`),
            target === undefined
              ? null
              : h(
                  'div',
                  { class: 'card-actions' },
                  h(
                    'button',
                    { type: 'button', class: 'small ghost', onClick: () => emit('cancel') },
                    'Cancel',
                  ),
                ),
          ]),
          h('div', { class: 'card-body' }, [
            // An upload cannot be fetched again; everything else can.
            target !== undefined && source !== undefined && source.type !== 'upload'
              ? h(
                  'p',
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'primary',
                      disabled: working,
                      onClick: () => installs.refetch(target, trusted()),
                    },
                    `Fetch from ${describeSource(source)}`,
                  ),
                )
              : null,
            segmented<Mode>({
              label: 'Source',
              value: mode.value,
              choices: [
                { value: 'git', label: 'Git address' },
                { value: 'zip', label: 'ZIP upload' },
              ],
              onChange: (value) => {
                mode.value = value;
              },
            }),
            mode.value === 'git'
              ? h('form', { class: 'stack', onSubmit: fetchGit }, [
                  h('label', [
                    'Git address',
                    h('input', {
                      name: 'url',
                      required: true,
                      autocomplete: 'off',
                      spellcheck: false,
                      placeholder: 'https://example.org/owner/bundle.git',
                    }),
                  ]),
                  h('label', [
                    'Branch, tag or commit (optional)',
                    h('input', { name: 'ref', autocomplete: 'off', spellcheck: false }),
                  ]),
                  h(
                    'div',
                    h('button', { type: 'submit', class: 'primary', disabled: working }, 'Fetch'),
                  ),
                ])
              : h('label', { class: 'upload' }, [
                  'ZIP archive of the bundle ',
                  h('input', {
                    type: 'file',
                    accept: '.zip,application/zip',
                    disabled: working,
                    onChange: upload,
                  }),
                ]),
            h('p', [
              h('label', { class: 'check' }, [
                h('input', {
                  type: 'checkbox',
                  name: 'scripts',
                  checked: trust.value,
                  onChange: (event: Event) => {
                    trust.value = (event.target as HTMLInputElement).checked;
                  },
                }),
                ' Trust this bundle to run code while it is installed: its .npmrc, npm packages from elsewhere than the registry, and install scripts. Without this a bundle that needs any of it is refused.',
              ]),
            ]),
            h(
              'p',
              { class: 'field-note' },
              'The bundle is fetched and checked first. Nothing is installed until you have seen what it declares and said so.',
            ),
            ...running.map((job) =>
              h(
                'p',
                { key: job.id, class: 'muted', role: 'status' },
                `${label(job)}${job.step === undefined ? '' : ` (${job.step})`}`,
              ),
            ),
            installs.problem ? h('p', { class: 'problem', role: 'alert' }, installs.problem) : null,
            ...ended.map(outcome),
          ]),
        ]),
      ]);
    };
  },
});
