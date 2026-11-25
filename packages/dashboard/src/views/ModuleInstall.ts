import { defineComponent, h, ref } from 'vue';
import { api, messageOf } from '../api.js';
import { describeSource, type SourceInfo } from '../stores/installs.js';
import { useOnAir } from '../stores/onAir.js';
import { readableSize } from './Assets.js';
import { field, part } from './admin.js';
import { counted, segmented } from './parts.js';

/** A module that was fetched and checked, as the server tells it. */
export interface StagedModule {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly title?: string | undefined;
  readonly target?: string | undefined;
  readonly replaces?: string | undefined;
  /** For an update: whether the installed module is enabled and is started again. */
  readonly enabled?: boolean | undefined;
  readonly source: SourceInfo;
  readonly engine?: string | undefined;
  readonly main: string;
  readonly config: boolean;
  /** What the server says about the access a module has: all of it. */
  readonly access: string;
  readonly npm: { readonly needed: boolean; readonly dependencies: readonly string[] };
  readonly installCode?: 'none' | 'on-request' | 'allowed' | undefined;
  readonly files: number;
  readonly bytes: number;
}

interface ModuleJob {
  readonly id: string;
  readonly operation: 'stage' | 'install' | 'update' | 'remove';
  readonly state: 'queued' | 'running' | 'succeeded' | 'failed' | 'rolled-back';
  readonly module?: string | undefined;
  readonly staged?: StagedModule | undefined;
  readonly error?: string | undefined;
  readonly rollbackError?: string | undefined;
}

const INSTALLS = '/api/v1/modules/-';
/** How often a running job is asked about. Tests set it to 0. */
export const moduleInstallTiming = { pollMs: 400 };

const over = (job: ModuleJob) => job.state !== 'queued' && job.state !== 'running';

/** Waits for a job of the module installer to end, asking the server about it. */
export async function settled(answer: { job: ModuleJob }): Promise<ModuleJob> {
  let { job } = answer;
  while (!over(job)) {
    await new Promise((resolve) => setTimeout(resolve, moduleInstallTiming.pollMs));
    job = (await api.request<{ job: ModuleJob }>('GET', `${INSTALLS}/jobs/${part(job.id)}`)).job;
  }
  return job;
}

/** What a job does, as a sentence begins. */
function label(job: ModuleJob): string {
  const name = job.module ?? 'the module';
  if (job.operation === 'stage') return 'Fetching the module';
  if (job.operation === 'install') return `Installing ${name}`;
  return job.operation === 'update' ? `Updating ${name}` : `Removing ${name}`;
}

/** How a job ended, as a sentence, and whether that is good news. */
export function outcomeOf(job: ModuleJob): { text: string; ok: boolean } {
  if (job.state === 'succeeded') return { text: `${label(job)} is done.`, ok: true };
  if (job.state === 'rolled-back') {
    return {
      text: `${label(job)} failed and was rolled back; the earlier version runs again: ${job.error ?? ''}`,
      ok: false,
    };
  }
  const restore =
    job.rollbackError === undefined
      ? ''
      : ` The earlier version could not be put back: ${job.rollbackError}`;
  return {
    text: `${label(job)} failed: ${job.error ?? 'no reason was given'}${restore}`,
    ok: false,
  };
}

function facts(staged: StagedModule): [string, string][] {
  return [
    ['Source', describeSource(staged.source)],
    ['Main file', staged.main],
    [
      'Runs code on install',
      staged.installCode === 'allowed'
        ? 'Yes, the install scripts of its npm packages, as was allowed when it was fetched'
        : staged.installCode === 'on-request'
          ? 'No, unless the install scripts of its npm packages are allowed'
          : 'No',
    ],
    ...(staged.engine === undefined ? [] : [['Needs MoonCG', staged.engine] as [string, string]]),
    [
      'npm packages',
      staged.npm.dependencies.length === 0 ? 'none' : staged.npm.dependencies.join(', '),
    ],
    ['Settings', staged.config ? 'yes' : 'no'],
    ['Size', `${counted(staged.files, 'file')}, ${readableSize(staged.bytes)}`],
  ];
}

/**
 * Installing a module the way a bundle is installed: fetched from a Git address or a ZIP
 * upload, shown with what it declares and that it runs inside the server, and only then put
 * in place, disabled. Also shows a fetched update, which a row's **Update** starts. Emits
 * `changed` whenever the list of modules may be different.
 */
export const ModuleInstall = defineComponent({
  name: 'ModuleInstall',
  emits: ['changed'],
  setup(_props, { emit, expose }) {
    const onAir = useOnAir();
    const mode = ref<'git' | 'zip'>('git');
    const trust = ref(false);
    const staged = ref<StagedModule[]>([]);
    const problem = ref('');
    const ended = ref<{ text: string; ok: boolean }>();
    const busy = ref(false);

    /** Runs a request that starts a job, follows it, and shows how it ended. */
    const follow = async (start: () => Promise<{ job: ModuleJob }>) => {
      problem.value = '';
      ended.value = undefined;
      busy.value = true;
      try {
        const job = await settled(await start());
        if (job.operation === 'stage') {
          if (job.state === 'succeeded' && job.staged) {
            staged.value = [...staged.value, job.staged];
          } else ended.value = outcomeOf(job);
        } else {
          ended.value = outcomeOf(job);
          emit('changed');
        }
      } catch (error) {
        problem.value = messageOf(error);
      } finally {
        busy.value = false;
      }
    };
    const trusted = () => {
      const given = trust.value;
      trust.value = false;
      return given;
    };

    const fetchGit = async (event: Event) => {
      event.preventDefault();
      const url = field(event, 'url').trim();
      const gitRef = field(event, 'ref').trim();
      if (url === '') return;
      const scripts = trusted();
      await follow(() =>
        api.request('POST', `${INSTALLS}/stage`, {
          source: { type: 'git', url, ...(gitRef === '' ? {} : { ref: gitRef }) },
          ...(scripts ? { scripts: true } : {}),
        }),
      );
    };
    const upload = async (event: Event) => {
      const input = event.target as HTMLInputElement;
      const [file] = [...(input.files ?? [])];
      input.value = '';
      if (!file) return;
      const scripts = trusted();
      await follow(() =>
        api.upload(
          `${INSTALLS}/stage?filename=${part(file.name)}${scripts ? '&scripts=true' : ''}`,
          file,
        ),
      );
    };
    /** Fetches the new version of an installed module from where it came from. */
    const update = (name: string) =>
      follow(() => api.request('POST', `/api/v1/modules/${part(name)}/update`, {}));
    expose({ update });

    const drop = (id: string) => {
      staged.value = staged.value.filter((entry) => entry.id !== id);
    };
    const discard = async (entry: StagedModule) => {
      try {
        await api.request('DELETE', `${INSTALLS}/staged/${part(entry.id)}`);
        drop(entry.id);
      } catch (error) {
        problem.value = messageOf(error);
      }
    };
    const commit = async (entry: StagedModule) => {
      // Only the update of an enabled module interrupts something.
      const override =
        entry.target !== undefined && entry.enabled === true
          ? onAir.overrideFor(`Update the module "${entry.target}"`)
          : false;
      if (override === undefined) return;
      drop(entry.id);
      await follow(() =>
        api.request('POST', `${INSTALLS}/staged/${part(entry.id)}/commit`, {
          scripts: entry.installCode === 'allowed',
          ...(override ? { forceOnAir: true } : {}),
        }),
      );
    };

    const card = (entry: StagedModule) => {
      const isUpdate = entry.target !== undefined;
      return h('section', { key: entry.id, class: 'card staged', 'data-staged-module': entry.id }, [
        h('div', { class: 'card-head' }, [
          h('h2', `${entry.title ?? ''} ${entry.name} ${entry.version}`.trim()),
          h(
            'span',
            { class: 'badge accent' },
            isUpdate ? `Update of ${entry.replaces ?? 'an unknown version'}` : 'New',
          ),
        ]),
        h('div', { class: 'card-body' }, [
          h('p', { class: 'problem', 'data-access': '' }, entry.access),
          h(
            'dl',
            { class: 'facts' },
            facts(entry).map(([term, value]) => h('div', [h('dt', term), h('dd', value)])),
          ),
          h(
            'p',
            { class: 'field-note' },
            isUpdate
              ? entry.enabled
                ? 'It is enabled: the update stops it and starts the new version, and puts the earlier one back if the new one does not start.'
                : 'It is disabled and stays so.'
              : 'Once installed it is disabled until you enable it.',
          ),
          h('div', { class: 'form-actions' }, [
            h(
              'button',
              {
                type: 'button',
                class: 'ghost',
                disabled: busy.value,
                onClick: () => discard(entry),
              },
              'Discard',
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'primary',
                disabled: busy.value,
                onClick: () => commit(entry),
              },
              isUpdate ? 'Update' : 'Install',
            ),
          ]),
        ]),
      ]);
    };

    return () =>
      h('div', { class: 'column', 'data-module-install': '' }, [
        ...staged.value.map(card),
        h('section', { class: 'card install' }, [
          h('div', { class: 'card-head' }, h('h2', 'Install module')),
          h('div', { class: 'card-body' }, [
            segmented<'git' | 'zip'>({
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
                      placeholder: 'https://example.org/owner/module.git',
                    }),
                  ]),
                  h('label', [
                    'Branch, tag or commit (optional)',
                    h('input', { name: 'ref', autocomplete: 'off', spellcheck: false }),
                  ]),
                  h(
                    'div',
                    h(
                      'button',
                      { type: 'submit', class: 'primary', disabled: busy.value },
                      'Fetch',
                    ),
                  ),
                ])
              : h('label', { class: 'upload' }, [
                  'ZIP archive of the module ',
                  h('input', {
                    type: 'file',
                    accept: '.zip,application/zip',
                    disabled: busy.value,
                    onChange: upload,
                  }),
                ]),
            h('p', [
              h('label', { class: 'check' }, [
                h('input', {
                  type: 'checkbox',
                  checked: trust.value,
                  onChange: (event: Event) => {
                    trust.value = (event.target as HTMLInputElement).checked;
                  },
                }),
                ' Trust this module to run code while it is installed: its .npmrc, npm packages from elsewhere than the registry, and install scripts.',
              ]),
            ]),
            h(
              'p',
              { class: 'field-note' },
              'The module is fetched and checked first. Nothing is installed until you have seen what it declares and said so.',
            ),
            busy.value ? h('p', { class: 'muted', role: 'status' }, 'Working…') : null,
            problem.value ? h('p', { class: 'problem', role: 'alert' }, problem.value) : null,
            ended.value
              ? h(
                  'p',
                  {
                    class: ended.value.ok ? 'done' : 'problem',
                    role: ended.value.ok ? 'status' : 'alert',
                  },
                  ended.value.text,
                )
              : null,
          ]),
        ]),
      ]);
  },
});
