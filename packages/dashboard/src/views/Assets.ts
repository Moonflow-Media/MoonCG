import { defineComponent, h, onMounted, onUnmounted, reactive, watch } from 'vue';
import { api, messageOf } from '../api.js';
import { live } from '../live.js';
import { type AssetCategoryInfo, useBundles } from '../stores/bundles.js';
import { part, sure } from './admin.js';

/** One stored file, as the server lists it. */
interface AssetFile {
  readonly name: string;
  readonly size: number;
  readonly modified: string;
  readonly url: string;
}

const UNITS = ['bytes', 'KiB', 'MiB', 'GiB'] as const;

/** A size as people read it: `512 bytes`, `2.0 KiB`. */
export function readableSize(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${value} bytes` : `${value.toFixed(1)} ${UNITS[unit]}`;
}

/** The files people uploaded for each bundle: what is there, and a way to add and remove. */
export const AssetsView = defineComponent({
  name: 'AssetsView',
  setup() {
    const bundles = useBundles();
    /** The files of each category, by `bundle:category`. */
    const files = reactive(new Map<string, readonly AssetFile[]>());
    /** What the last uploads and deletions in a category had to say. */
    const notes = reactive(new Map<string, readonly { text: string; bad: boolean }[]>());
    const busy = reactive(new Set<string>());
    const following = new Map<string, () => void>();
    const keys = () =>
      bundles.list.flatMap((bundle) =>
        (bundle.assets ?? []).map((category) => `${bundle.name}:${category.id}`),
      );

    // Each list is a replicant, followed while its category is on the page.
    watch(
      () => keys().join(),
      () => {
        const wanted = new Set(keys());
        for (const [key, stop] of following) {
          if (wanted.has(key)) continue;
          stop();
          following.delete(key);
          files.delete(key);
        }
        for (const key of wanted) {
          if (following.has(key)) continue;
          const [bundle, category] = key.split(':');
          following.set(
            key,
            live.follow<readonly AssetFile[]>(`${bundle}:$assets.${category}`, (value) =>
              files.set(key, Array.isArray(value) ? value : []),
            ),
          );
        }
      },
      { immediate: true },
    );
    onMounted(() => void bundles.refresh().catch(() => {}));
    onUnmounted(() => {
      for (const stop of following.values()) stop();
      following.clear();
    });

    const base = (bundle: string, category: string) =>
      `/api/v1/bundles/${part(bundle)}/assets/${part(category)}`;

    const upload = async (bundle: string, category: string, event: Event) => {
      const input = event.target as HTMLInputElement;
      const key = `${bundle}:${category}`;
      const said: { text: string; bad: boolean }[] = [];
      busy.add(key);
      for (const file of [...(input.files ?? [])]) {
        try {
          const answer = await api.upload<{ file: AssetFile }>(
            `${base(bundle, category)}/${part(file.name)}`,
            file,
          );
          // The server cleans names; a file that got another one is pointed out.
          if (answer.file.name !== file.name) {
            said.push({ text: `${file.name} was stored as ${answer.file.name}`, bad: false });
          }
        } catch (error) {
          said.push({ text: `${file.name}: ${messageOf(error)}`, bad: true });
        }
      }
      busy.delete(key);
      notes.set(key, said);
      // So that choosing the same file again is a change again.
      input.value = '';
    };

    const remove = async (bundle: string, category: string, name: string) => {
      if (!sure(`Delete "${name}"? Graphics that show it lose it at once.`)) return;
      const key = `${bundle}:${category}`;
      try {
        await api.request('DELETE', `${base(bundle, category)}/${part(name)}`);
        notes.set(key, []);
      } catch (error) {
        notes.set(key, [{ text: `${name}: ${messageOf(error)}`, bad: true }]);
      }
    };

    const category = (bundle: string, info: AssetCategoryInfo) => {
      const key = `${bundle}:${info.id}`;
      const list = files.get(key);
      return h('section', { key, class: 'assets', 'data-category': key }, [
        h('h3', info.title ?? info.id),
        info.accept ? h('p', { class: 'muted' }, `Takes ${info.accept.join(', ')}`) : null,
        ...(notes.get(key) ?? []).map((note) =>
          h(
            'p',
            { key: note.text, class: note.bad ? 'problem' : 'muted', role: 'alert' },
            note.text,
          ),
        ),
        list !== undefined && list.length === 0
          ? h('p', { class: 'muted' }, 'No files yet.')
          : null,
        h(
          'ul',
          { class: 'rows' },
          (list ?? []).map((file) =>
            h('li', { key: file.name, 'data-asset': file.name }, [
              h('a', { href: file.url, target: '_blank', rel: 'noopener' }, file.name),
              h('span', { class: 'muted' }, ` ${readableSize(file.size)} `),
              // No button the server would refuse.
              info.canWrite
                ? h(
                    'button',
                    { type: 'button', onClick: () => remove(bundle, info.id, file.name) },
                    'Delete',
                  )
                : null,
            ]),
          ),
        ),
        info.canWrite
          ? h('label', { class: 'upload' }, [
              busy.has(key) ? 'Uploading… ' : 'Upload ',
              h('input', {
                type: 'file',
                multiple: true,
                disabled: busy.has(key),
                ...(info.accept ? { accept: info.accept.join(',') } : {}),
                onChange: (event: Event) => upload(bundle, info.id, event),
              }),
            ])
          : null,
      ]);
    };

    return () => {
      const withAssets = bundles.list.filter((bundle) => (bundle.assets ?? []).length > 0);
      return h('div', [
        h('h1', 'Assets'),
        h(
          'p',
          { class: 'muted' },
          'Files a bundle works with, such as logos. Graphics follow what is uploaded here.',
        ),
        bundles.loaded && withAssets.length === 0
          ? h('p', { class: 'empty' }, 'No bundle takes assets you may see.')
          : null,
        ...withAssets.map((bundle) =>
          h('section', { key: bundle.name }, [
            h('h2', bundle.title ?? bundle.name),
            ...(bundle.assets ?? []).map((info) => category(bundle.name, info)),
          ]),
        ),
      ]);
    };
  },
});
