import { defineComponent, h, onMounted, reactive, ref, type VNode } from 'vue';
import { api, messageOf } from '../api.js';
import { collect, type Field, type FormState, fieldsOf, initialState } from '../schema-form.js';
import { part } from './admin.js';

interface BundleState {
  readonly name: string;
  readonly title?: string | undefined;
  readonly state: string;
  readonly lastError?: string | undefined;
}

/** A bundle's configuration as the server tells it: everything but the secrets. */
interface Described {
  readonly schema: unknown;
  readonly values: unknown;
  readonly secretFields: readonly string[];
  readonly secrets: readonly string[];
  readonly problems: readonly string[];
  readonly bundle: BundleState;
  /** In the answer to a save: whether the extension now runs with the stored values. */
  readonly restarted?: boolean | undefined;
  readonly restartNote?: string | undefined;
}

/** The form for one bundle's configuration, drawn from the bundle's schema. */
const ConfigForm = defineComponent({
  name: 'ConfigForm',
  props: { bundle: { type: String, required: true }, title: { type: String, required: true } },
  setup(props) {
    const described = ref<Described>();
    const fields = ref<readonly Field[]>([]);
    const state = reactive<FormState>({});
    /** The stored secrets that are to be removed with the next save. */
    const clear = reactive(new Set<string>());
    const problem = ref('');
    const saved = ref('');
    const path = () => `/api/v1/bundles/${part(props.bundle)}/config`;

    const show = (answer: Described) => {
      described.value = answer;
      fields.value = fieldsOf(answer.schema, answer.secretFields);
      for (const key of Object.keys(state)) delete state[key];
      // Also empties every secret field: what was typed does not stay on the page.
      Object.assign(state, initialState(fields.value, answer.values));
      clear.clear();
    };
    onMounted(async () => {
      try {
        show(await api.request<Described>('GET', path()));
      } catch (error) {
        problem.value = `Could not load the settings: ${messageOf(error)}`;
      }
    });

    const save = async (event: Event) => {
      event.preventDefault();
      problem.value = '';
      saved.value = '';
      const { values, problems } = collect(fields.value, state, clear, described.value?.values);
      if (problems.length > 0) {
        problem.value = problems.join('; ');
        return;
      }
      try {
        const answer = await api.request<Described>('PUT', path(), { values });
        show(answer);
        // The server says whether the extension runs with the new values, and if not, why.
        saved.value =
          answer.restarted === false
            ? `Saved, but the extension was not restarted. ${answer.restartNote ?? ''}`.trim()
            : 'Saved. The extension was restarted with the new settings.';
      } catch (error) {
        problem.value = messageOf(error);
      }
    };

    const text = (field: Field) => String(state[field.path] ?? '');
    const set = (field: Field) => (event: Event) => {
      const input = event.target as HTMLInputElement;
      state[field.path] = input.type === 'checkbox' ? input.checked : input.value;
    };
    const id = (field: Field) => `config-${props.bundle}-${field.path}`;

    const control = (field: Field): VNode => {
      const common = { id: id(field), 'data-field': field.path, onInput: set(field) };
      switch (field.kind) {
        case 'boolean':
          return h('input', {
            ...common,
            type: 'checkbox',
            checked: state[field.path] === true,
            onChange: set(field),
          });
        case 'enum':
          return h('select', { ...common, value: text(field), onChange: set(field) }, [
            // A choice that is required still starts empty when nothing is stored.
            h('option', { value: '' }, field.required ? 'Choose…' : '(not set)'),
            ...field.options.map((option, index) =>
              h('option', { key: index, value: String(index) }, String(option)),
            ),
          ]);
        case 'list':
          return h('textarea', {
            ...common,
            rows: 4,
            value: text(field),
            placeholder: 'One per line',
          });
        case 'json':
          return h('textarea', { ...common, rows: 6, value: text(field), placeholder: 'JSON' });
        case 'secret': {
          const stored = described.value?.secrets.includes(field.path) === true;
          return h('span', { class: 'secret-field' }, [
            h('input', {
              ...common,
              type: 'password',
              autocomplete: 'new-password',
              value: text(field),
              placeholder: stored ? 'A value is stored. Leave empty to keep it.' : 'Not set',
              disabled: clear.has(field.path),
            }),
            // Only what is stored can be removed.
            stored
              ? h('label', { class: 'inline' }, [
                  h('input', {
                    type: 'checkbox',
                    'data-clear': field.path,
                    checked: clear.has(field.path),
                    onChange: (event: Event) => {
                      if ((event.target as HTMLInputElement).checked) clear.add(field.path);
                      else clear.delete(field.path);
                    },
                  }),
                  ' Remove the stored value',
                ])
              : null,
          ]);
        }
        case 'number':
        case 'integer':
          // Text, so that what cannot be a number is told instead of silently dropped.
          return h('input', { ...common, type: 'text', inputmode: 'decimal', value: text(field) });
        default:
          return h('input', { ...common, type: 'text', value: text(field) });
      }
    };

    const draw = (field: Field): VNode => {
      if (field.kind === 'object') {
        return h('fieldset', { key: field.path, 'data-group': field.path }, [
          h('legend', field.title),
          field.description ? h('p', { class: 'muted' }, field.description) : null,
          ...field.fields.map(draw),
        ]);
      }
      return h('div', { key: field.path, class: 'field' }, [
        h('label', { for: id(field) }, field.required ? `${field.title} *` : field.title),
        control(field),
        field.description ? h('p', { class: 'muted field-note' }, field.description) : null,
      ]);
    };

    return () => {
      const current = described.value;
      return h('section', { class: 'config', 'data-config': props.bundle }, [
        h('h2', props.title),
        current && current.bundle.state !== 'running'
          ? h('p', { class: 'muted' }, `The bundle is ${current.bundle.state}.`)
          : null,
        current && current.problems.length > 0
          ? h(
              'ul',
              { class: 'problem' },
              current.problems.map((line) => h('li', { key: line }, line)),
            )
          : null,
        problem.value ? h('p', { class: 'problem', role: 'alert' }, problem.value) : null,
        saved.value ? h('p', { class: 'done', role: 'status' }, saved.value) : null,
        current
          ? h('form', { onSubmit: save, novalidate: true }, [
              ...fields.value.map(draw),
              h('button', { type: 'submit' }, 'Save and restart'),
            ])
          : null,
      ]);
    };
  },
});

/** The settings of every bundle that has a config schema. */
export const SettingsView = defineComponent({
  name: 'SettingsView',
  setup() {
    const bundles = ref<readonly BundleState[]>();
    const problem = ref('');
    onMounted(async () => {
      try {
        const answer = await api.request<{ bundles: BundleState[] }>('GET', '/api/v1/config');
        bundles.value = answer.bundles;
      } catch (error) {
        problem.value = `Could not load the settings: ${messageOf(error)}`;
      }
    });
    return () =>
      h('div', [
        h('h1', 'Settings'),
        h(
          'p',
          { class: 'muted' },
          'Saving restarts the extension of the bundle. Secrets are stored but never shown.',
        ),
        problem.value ? h('p', { class: 'problem', role: 'alert' }, problem.value) : null,
        bundles.value?.length === 0 ? h('p', { class: 'empty' }, 'No bundle has settings.') : null,
        ...(bundles.value ?? []).map((bundle) =>
          h(ConfigForm, {
            key: bundle.name,
            bundle: bundle.name,
            title: bundle.title ?? bundle.name,
          }),
        ),
      ]);
  },
});
