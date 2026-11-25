import { defineComponent, h, onMounted, onUnmounted, ref } from 'vue';
import { api, messageOf } from '../api.js';
import {
  type CatalogEntry,
  type IndexInfo,
  type Kind,
  type StageJob,
  useRegistry,
} from '../stores/registry.js';
import { useSession } from '../stores/session.js';
import { field } from './admin.js';
import { pageHead, segmented } from './parts.js';

/** How often a fetch that was started here is asked about. Tests set it to 0. */
export const catalogTiming = { pollMs: 400 };

const MANAGE: Readonly<Record<Kind, string>> = {
  bundle: 'system:bundles.manage',
  module: 'system:modules.manage',
};
const PAGE: Readonly<Record<Kind, { path: string; label: string }>> = {
  bundle: { path: '/bundles', label: 'Bundles' },
  module: { path: '/modules', label: 'Modules' },
};
type Filter = 'all' | Kind;

const over = (job: StageJob) => job.state !== 'queued' && job.state !== 'running';

/** A time as people read it, or what is there instead. */
const when = (time: string | undefined) =>
  time === undefined ? 'never' : new Date(time).toLocaleString();

/** How an index stands, in a sentence. */
function standing(index: IndexInfo): string {
  if (index.status === 'pending') return 'Not fetched yet.';
  if (index.status === 'ok') {
    return `${index.entries} ${index.entries === 1 ? 'entry' : 'entries'}, fetched ${when(index.fetchedAt)}.`;
  }
  if (index.status === 'stale') {
    return `The last fetch failed: ${index.error ?? 'no reason was given'}. The last good copy, from ${when(index.fetchedAt)}, is used.`;
  }
  return `It could not be fetched: ${index.error ?? 'no reason was given'}.`;
}

/**
 * The catalog: what the registry indexes list, for whoever may install it. Installing starts
 * the same fetch, summary and decision as any other source, on the Bundles or Modules page.
 * Nothing of another site is loaded here: no icons, no pictures.
 */
export const CatalogView = defineComponent({
  name: 'CatalogView',
  setup() {
    const session = useSession();
    const registry = useRegistry();
    const kinds = (['bundle', 'module'] as const).filter((kind) => session.can(MANAGE[kind]));
    const wanted = new URLSearchParams(globalThis.location?.search ?? '').get('kind');
    const filter = ref<Filter>(
      kinds.length === 1
        ? (kinds[0] as Kind)
        : kinds.includes(wanted as Kind)
          ? (wanted as Kind)
          : 'all',
    );
    const query = ref('');
    /** What became of the fetch started here last. */
    const outcome = ref<{ text: string; ok: boolean; kind: Kind }>();

    const load = () =>
      registry.loadCatalog(filter.value === 'all' ? undefined : filter.value, query.value);
    onMounted(async () => {
      await registry.loadIndexes();
      await load();
    });
    const again = async () => {
      await registry.loadIndexes();
      await load();
    };
    // An index was fetched, or something was installed, updated or removed: the entries, what
    // is installed of them and the hints are read again.
    onUnmounted(registry.followUpdates(kinds, () => void again()));

    const search = async (event: Event) => {
      event.preventDefault();
      query.value = field(event, 'search');
      await load();
    };
    const addIndex = async (event: Event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      const url = field(event, 'index-url').trim();
      if (url === '') return;
      if (await registry.add(url)) form.reset();
      await again();
    };

    /** Fetches an entry into staging and follows the fetch until it is over. */
    const stage = async (entry: CatalogEntry, update: boolean) => {
      outcome.value = undefined;
      let job = await registry.stage(entry.kind, entry.index.id, entry.name, { update });
      if (!job) return;
      try {
        while (!over(job)) {
          await new Promise((resolve) => setTimeout(resolve, catalogTiming.pollMs));
          job = (
            await api.request<{ job: StageJob }>(
              'GET',
              `/api/v1/${entry.kind}s/-/jobs/${encodeURIComponent(job.id)}`,
            )
          ).job;
        }
      } catch (error) {
        outcome.value = { text: messageOf(error), ok: false, kind: entry.kind };
        return;
      }
      outcome.value =
        job.state === 'succeeded'
          ? {
              text: `${entry.name} was fetched and waits on the ${PAGE[entry.kind].label} page, where you see what it declares and decide.`,
              ok: true,
              kind: entry.kind,
            }
          : {
              text: `Fetching ${entry.name} failed: ${job.error ?? 'no reason was given'}`,
              ok: false,
              kind: entry.kind,
            };
    };

    const indexRow = (index: IndexInfo) =>
      h('li', { key: index.id, 'data-index': index.id }, [
        h('strong', index.title ?? index.url),
        h('span', { class: ['state', `index-${index.status}`] }, index.status),
        index.origin === 'config' ? h('span', { class: 'badge' }, 'configuration') : null,
        index.origin === 'module'
          ? h('span', { class: 'badge' }, `module ${index.module ?? ''}`.trim())
          : null,
        h('span', { class: 'muted' }, index.url),
        h('p', { class: index.status === 'ok' ? 'muted' : 'problem' }, standing(index)),
        registry.canEdit && index.origin === 'added'
          ? h(
              'span',
              { class: 'row-actions' },
              h(
                'button',
                {
                  type: 'button',
                  class: 'small danger',
                  disabled: registry.sending,
                  onClick: async () => {
                    await registry.remove(index.id);
                    await again();
                  },
                },
                'Remove',
              ),
            )
          : null,
      ]);

    const indexesCard = () =>
      h('section', { class: 'card', 'data-card': 'indexes' }, [
        h('div', { class: 'card-head' }, [
          h('h2', 'Indexes'),
          h(
            'div',
            { class: 'card-actions' },
            h(
              'button',
              {
                type: 'button',
                class: 'small',
                disabled: registry.sending,
                onClick: async () => {
                  // Refused when checked moments ago: the reason stays in view.
                  if (await registry.refresh()) await load();
                },
              },
              'Check now',
            ),
          ),
        ]),
        h('div', { class: 'card-body' }, [
          registry.indexes.length === 0
            ? h('p', { class: 'empty' }, 'No index is set up, so the catalog is empty.')
            : h('ul', { class: 'rows' }, registry.indexes.map(indexRow)),
          registry.canEdit
            ? h('form', { class: 'stack', 'data-form': 'add-index', onSubmit: addIndex }, [
                h('label', [
                  'Address of an index',
                  h('input', {
                    name: 'index-url',
                    required: true,
                    autocomplete: 'off',
                    spellcheck: false,
                    placeholder: 'https://example.org/mooncg-index.json',
                  }),
                ]),
                h(
                  'div',
                  h(
                    'button',
                    { type: 'submit', class: 'primary', disabled: registry.sending },
                    'Add index',
                  ),
                ),
              ])
            : null,
          h(
            'p',
            { class: 'field-note' },
            `An index is a list that anyone can publish. MoonCG does not check what it lists: add only indexes whose authors you trust. They are fetched at start and every ${Math.round((registry.refreshMs ?? 21_600_000) / 3_600_000)} hours.`,
          ),
        ]),
      ]);

    const actions = (entry: CatalogEntry) => {
      const { installed, update } = entry;
      const runnable = entry.versions.some((version) => version.compatible);
      if (installed?.fromThisEntry) {
        return update
          ? h(
              'button',
              {
                type: 'button',
                class: 'small primary',
                disabled: registry.sending,
                onClick: () => stage(entry, true),
              },
              `Update to ${update.version}`,
            )
          : h('span', { class: 'muted' }, 'Up to date');
      }
      if (installed) {
        return h(
          'span',
          { class: 'muted' },
          'Installed from elsewhere: this index offers it no updates.',
        );
      }
      return h(
        'button',
        {
          type: 'button',
          class: 'small primary',
          disabled: registry.sending || !runnable,
          title: runnable ? undefined : 'No version of it runs on this MoonCG',
          onClick: () => stage(entry, false),
        },
        'Install',
      );
    };

    const entryCard = (entry: CatalogEntry) =>
      h(
        'section',
        {
          key: `${entry.index.id}:${entry.kind}:${entry.name}`,
          class: 'card catalog-entry',
          'data-entry': `${entry.kind}:${entry.name}`,
        },
        [
          h('div', { class: 'card-head' }, [
            h('h2', [entry.title ?? entry.name, ' ', h('small', { class: 'muted' }, entry.name)]),
            h('span', { class: 'badge' }, entry.kind),
            entry.update
              ? h(
                  'span',
                  { class: 'badge accent', 'data-badge': 'update' },
                  `Update available: ${entry.update.version}`,
                )
              : null,
          ]),
          h('div', { class: 'card-body' }, [
            entry.description ? h('p', entry.description) : null,
            h('dl', { class: 'facts' }, [
              entry.author ? h('div', [h('dt', 'Author'), h('dd', entry.author)]) : null,
              entry.license ? h('div', [h('dt', 'License'), h('dd', entry.license)]) : null,
              entry.homepage
                ? h('div', [
                    h('dt', 'Homepage'),
                    h(
                      'dd',
                      h(
                        'a',
                        { href: entry.homepage, rel: 'noopener noreferrer', target: '_blank' },
                        entry.homepage,
                      ),
                    ),
                  ])
                : null,
              entry.tags.length > 0
                ? h('div', [h('dt', 'Tags'), h('dd', entry.tags.join(', '))])
                : null,
              h('div', [
                h('dt', 'Index'),
                h(
                  'dd',
                  entry.index.title ? `${entry.index.title} (${entry.index.url})` : entry.index.url,
                ),
              ]),
              entry.installed
                ? h('div', [h('dt', 'Installed'), h('dd', `Installed: ${entry.installed.version}`)])
                : null,
              h('div', [
                h('dt', 'Versions'),
                h(
                  'dd',
                  h(
                    'ul',
                    { class: 'versions' },
                    entry.versions.map((version) =>
                      h(
                        'li',
                        { key: version.version, class: version.compatible ? undefined : 'muted' },
                        [
                          version.version,
                          version.compatible
                            ? ''
                            : ` — ${version.problem ?? 'does not run on this MoonCG'}`,
                        ],
                      ),
                    ),
                  ),
                ),
              ]),
            ]),
            h('div', { class: 'form-actions' }, actions(entry)),
          ]),
        ],
      );

    return () => {
      const choices =
        kinds.length > 1
          ? [
              { value: 'all' as const, label: 'All' },
              { value: 'bundle' as const, label: 'Bundles' },
              { value: 'module' as const, label: 'Modules' },
            ]
          : [];
      return h('div', [
        pageHead('Catalog', {
          description:
            'What the registry indexes list. Installing fetches it and shows what it declares first; nothing is installed until you decide.',
          actions:
            choices.length === 0
              ? undefined
              : segmented<Filter>({
                  label: 'Kind',
                  value: filter.value,
                  choices,
                  onChange: (value) => {
                    filter.value = value;
                    void load();
                  },
                }),
        }),
        registry.problem ? h('p', { class: 'problem', role: 'alert' }, registry.problem) : null,
        outcome.value
          ? h('p', { class: outcome.value.ok ? 'done' : 'problem', role: 'status' }, [
              outcome.value.text,
              outcome.value.ok
                ? [
                    ' ',
                    h(
                      'a',
                      { href: PAGE[outcome.value.kind].path },
                      `Go to ${PAGE[outcome.value.kind].label}`,
                    ),
                  ]
                : null,
            ])
          : null,
        h('form', { class: 'search', 'data-form': 'search', onSubmit: search }, [
          h('input', {
            name: 'search',
            type: 'search',
            'aria-label': 'Search the catalog',
            placeholder: 'Search by name, description or tag',
            autocomplete: 'off',
          }),
          h('button', { type: 'submit' }, 'Search'),
        ]),
        registry.loaded && registry.entries.length === 0
          ? h('p', { class: 'empty' }, 'Nothing in the catalog matches.')
          : null,
        ...registry.entries.map(entryCard),
        indexesCard(),
      ]);
    };
  },
});
