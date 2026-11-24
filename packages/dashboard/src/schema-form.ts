/**
 * Turns the JSON Schema of a bundle's configuration into the fields of a form, and what was
 * entered into the form back into values. It knows the plain cases: text, numbers, switches,
 * a choice among fixed values, objects of these and lists of text or numbers. Anything else
 * is one field that takes JSON, so every schema can be filled in, if not always comfortably.
 */

type Schema = Record<string, unknown>;

interface Common {
  /** Where the value is in the configuration, as a JSON Pointer such as `/mail/host`. */
  readonly path: string;
  /** The property name; empty for the configuration as a whole. */
  readonly name: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly required: boolean;
  /** The schema's `default`, shown until a value is stored. */
  readonly initial?: unknown;
}

export type Field =
  | (Common & { readonly kind: 'string' | 'number' | 'integer' | 'boolean' | 'json' })
  | (Common & { readonly kind: 'enum'; readonly options: readonly unknown[] })
  | (Common & { readonly kind: 'list'; readonly of: 'string' | 'number' | 'integer' })
  | (Common & { readonly kind: 'object'; readonly fields: readonly Field[] })
  /** Write-only: the form never holds the stored value. `of` says how to read what is typed. */
  | (Common & { readonly kind: 'secret'; readonly of: 'string' | 'number' | 'json' });

/** What a form holds: the text or the switch of each field, by its path. */
export type FormState = Record<string, string | boolean>;

const isObject = (value: unknown): value is Schema =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const SCALARS = ['string', 'number', 'integer'] as const;
type Scalar = (typeof SCALARS)[number];
const scalar = (type: unknown): Scalar | undefined => SCALARS.find((known) => known === type);
const segment = (name: string) => name.replaceAll('~', '~0').replaceAll('/', '~1');

function fieldOf(
  schema: unknown,
  path: string,
  name: string,
  required: boolean,
  secrets: ReadonlySet<string>,
): Field {
  const node = isObject(schema) ? schema : {};
  const common: Common = {
    path,
    name,
    title: typeof node.title === 'string' ? node.title : name || 'Configuration',
    ...(typeof node.description === 'string' ? { description: node.description } : {}),
    required,
    ...(node.default === undefined ? {} : { initial: node.default }),
  };
  const { type } = node;
  if (secrets.has(path)) {
    const of =
      type === 'string' ? 'string' : type === 'number' || type === 'integer' ? 'number' : 'json';
    // A secret has no default to show: that would put it on the page.
    return { ...common, initial: undefined, kind: 'secret', of };
  }
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    return { ...common, kind: 'enum', options: node.enum };
  }
  if (type === 'boolean') return { ...common, kind: 'boolean' };
  const simple = scalar(type);
  if (simple) return { ...common, kind: simple };
  if (type === 'object' && isObject(node.properties)) {
    const needed = Array.isArray(node.required) ? node.required : [];
    return {
      ...common,
      kind: 'object',
      fields: Object.entries(node.properties).map(([key, child]) =>
        fieldOf(child, `${path}/${segment(key)}`, key, needed.includes(key), secrets),
      ),
    };
  }
  const items = type === 'array' && isObject(node.items) ? node.items : undefined;
  const of = items && !Array.isArray(items.enum) ? scalar(items.type) : undefined;
  if (of) return { ...common, kind: 'list', of };
  return { ...common, kind: 'json' };
}

/**
 * The fields of a configuration schema. `secrets` are the paths the server says are secret.
 * A schema that is no object with properties is one JSON field for the whole configuration.
 */
export function fieldsOf(schema: unknown, secrets: readonly string[]): Field[] {
  const root = fieldOf(schema, '', '', true, new Set(secrets));
  return root.kind === 'object' ? [...root.fields] : [root];
}

const valueAt = (values: unknown, name: string) =>
  isObject(values) && Object.hasOwn(values, name) ? values[name] : undefined;

/** What the form shows at first: the stored values, else the schema's defaults. */
export function initialState(fields: readonly Field[], values: unknown): FormState {
  const state: FormState = {};
  const fill = (field: Field, stored: unknown): void => {
    const value = stored ?? field.initial;
    switch (field.kind) {
      case 'object':
        for (const child of field.fields) fill(child, valueAt(value, child.name));
        return;
      case 'secret':
        state[field.path] = '';
        return;
      case 'boolean':
        state[field.path] = value === true;
        return;
      case 'enum': {
        const index = field.options.findIndex(
          (option) => JSON.stringify(option) === JSON.stringify(value),
        );
        state[field.path] = index < 0 ? '' : String(index);
        return;
      }
      case 'list':
        state[field.path] = Array.isArray(value) ? value.map(String).join('\n') : '';
        return;
      case 'json':
        state[field.path] = value === undefined ? '' : JSON.stringify(value, null, 2);
        return;
      default:
        state[field.path] = value === undefined || value === null ? '' : String(value);
    }
  };
  // The whole configuration as one field has no name to look its value up by.
  for (const field of fields) fill(field, field.path === '' ? values : valueAt(values, field.name));
  return state;
}

/**
 * The values to store for what the form holds. An empty field is left out, which for a
 * secret means that the stored one stays; a secret named in `clear` is sent as `null`, which
 * removes it. An emptied text is stored as empty text where leaving it out would mean
 * something else: when it is required, or has a default. What is in `stored` under keys the
 * form does not draw is kept as it is, so that saving the form loses nothing. What cannot be
 * understood is listed in `problems`, and then nothing is sent.
 */
export function collect(
  fields: readonly Field[],
  state: FormState,
  clear: ReadonlySet<string> = new Set(),
  stored: unknown = undefined,
): { values: unknown; problems: string[] } {
  const problems: string[] = [];
  const NOTHING = Symbol('nothing');
  const number = (field: Field, text: string): number | typeof NOTHING => {
    const value = Number(text);
    if (text.trim() !== '' && Number.isFinite(value)) return value;
    problems.push(`${field.title}: "${text}" is not a number`);
    return NOTHING;
  };
  const json = (field: Field, text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      problems.push(`${field.title}: not valid JSON`);
      return NOTHING;
    }
  };
  /** What is stored in an object under keys that none of the fields draws. */
  const undrawn = (kept: unknown, drawn: readonly Field[]): Record<string, unknown> =>
    isObject(kept)
      ? Object.fromEntries(
          Object.entries(kept).filter(([key]) => !drawn.some((field) => field.name === key)),
        )
      : {};
  const read = (field: Field, kept: unknown): unknown => {
    const held = state[field.path];
    const text = typeof held === 'string' ? held : '';
    switch (field.kind) {
      case 'object': {
        const value = undrawn(kept, field.fields);
        for (const child of field.fields) {
          const part = read(child, valueAt(kept, child.name));
          if (part !== NOTHING) value[child.name] = part;
        }
        return Object.keys(value).length > 0 || field.required ? value : NOTHING;
      }
      case 'boolean':
        return held === true;
      case 'secret':
        if (clear.has(field.path)) return null;
        if (text === '') return NOTHING;
        return field.of === 'string'
          ? text
          : field.of === 'number'
            ? number(field, text)
            : json(field, text);
      case 'enum':
        return text === '' ? NOTHING : field.options[Number(text)];
      case 'list': {
        const lines = text
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== '');
        if (lines.length === 0) return field.required ? [] : NOTHING;
        if (field.of === 'string') return lines;
        const numbers = lines.map((line) => number(field, line));
        return numbers.includes(NOTHING) ? NOTHING : numbers;
      }
      case 'json':
        return text.trim() === '' ? NOTHING : json(field, text);
      case 'string':
        // Left out when empty, unless that would say something else than "empty": a
        // required text must be there, and one with a default would get the default back.
        return text === '' && !field.required && field.initial === undefined ? NOTHING : text;
      default:
        return text.trim() === '' ? NOTHING : number(field, text);
    }
  };
  if (fields.length === 1 && fields[0]?.path === '') {
    const whole = read(fields[0], stored);
    return { values: whole === NOTHING ? {} : whole, problems };
  }
  const values = undrawn(stored, fields);
  for (const field of fields) {
    const value = read(field, valueAt(stored, field.name));
    if (value !== NOTHING) values[field.name] = value;
  }
  return { values, problems };
}
