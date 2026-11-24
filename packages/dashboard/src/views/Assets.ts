import { defineComponent, h, onMounted, onUnmounted, reactive, watch } from 'vue';
import { api, messageOf } from '../api.js';
import { live } from '../live.js';
import { type AssetCategoryInfo, type BundleInfo, useBundles } from '../stores/bundles.js';
import { part, sure } from './admin.js';
import { pageHead } from './parts.js';

/** One stored file, as the server lists it. */
interface AssetFile {
  readonly name: string;
  readonly size: number;
  readonly modified: string;
  readonly url: string;
}

const UNITS = ['bytes', 'KiB', 'MiB', 'GiB'] as const;
/** The files a browser draws as a picture, by the end of their name. */
const PICTURE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;

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

    const tile = (bundle: string, info: AssetCategoryInfo, file: AssetFile) =>
      h('figure', { key: file.name, class: 'asset-tile', 'data-asset': file.name }, [
        h(
          'div',
          { class: 'asset-thumb' },
          // An uploaded file is only ever drawn as a picture, which runs nothing.
          PICTURE.test(file.name)
            ? h('img', { src: file.url, alt: '', loading: 'lazy' })
            : h('span', { class: 'muted' }, file.name.split('.').pop()),
        ),
        h('figcaption', [
          h('div', [
            h(
              'a',
              { class: 'asset-name', href: file.url, target: '_blank', rel: 'noopener' },
              file.name,
            ),
            h('span', { class: 'muted' }, readableSize(file.size)),
          ]),
          // No button the server would refuse.
          info.canWrite
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'small ghost',
                  title: 'Delete',
                  'aria-label': `Delete ${file.name}`,
                  onClick: () => remove(bundle, info.id, file.name),
                },
                '×',
              )
            : null,
        ]),
      ]);

    const category = (bundle: BundleInfo, info: AssetCategoryInfo) => {
      const key = `${bundle.name}:${info.id}`;
      const list = files.get(key);
      const said = notes.get(key) ?? [];
      return h('section', { key, class: 'card assets', 'data-category': key }, [
        h('div', { class: 'card-head' }, [
          h('h2', info.title ?? info.id),
          h(
            'span',
            { class: 'muted' },
            [bundle.title ?? bundle.name, info.accept ? `Takes ${info.accept.join(', ')}` : '']
              .filter((text) => text !== '')
              .join(' · '),
          ),
          info.canWrite
            ? h(
                'div',
                { class: 'card-actions' },
                h('label', { class: 'upload primary' }, [
                  busy.has(key) ? 'Uploading… ' : 'Upload ',
                  h('input', {
                    type: 'file',
                    multiple: true,
                    disabled: busy.has(key),
                    ...(info.accept ? { accept: info.accept.join(',') } : {}),
                    onChange: (event: Event) => upload(bundle.name, info.id, event),
                  }),
                ]),
              )
            : null,
        ]),
        h('div', { class: 'card-body' }, [
          // Two files of one upload can be refused in the same words.
          ...said.map((note, index) =>
            h(
              'p',
              {
                key: `${index}:${note.text}`,
                class: note.bad ? 'problem' : 'muted',
                role: 'alert',
              },
              note.text,
            ),
          ),
          list !== undefined && list.length === 0
            ? h('p', { class: 'muted' }, 'No files yet.')
            : null,
          list !== undefined && list.length > 0
            ? h(
                'div',
                { class: 'asset-grid' },
                list.map((file) => tile(bundle.name, info, file)),
              )
            : null,
        ]),
      ]);
    };

    return () => {
      const withAssets = bundles.list.filter((bundle) => (bundle.assets ?? []).length > 0);
      return h('div', [
        pageHead('Assets', {
          description:
            'Files a bundle works with, such as logos. Graphics follow what is uploaded here.',
        }),
        bundles.loaded && withAssets.length === 0
          ? h('p', { class: 'empty' }, 'No bundle takes assets you may see.')
          : null,
        h(
          'div',
          { class: 'column' },
          withAssets.flatMap((bundle) =>
            (bundle.assets ?? []).map((info) => category(bundle, info)),
          ),
        ),
      ]);
    };
  },
});
