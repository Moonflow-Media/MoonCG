// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api.js';
import { collect, fieldsOf, initialState } from '../src/schema-form.js';
import { SettingsView } from '../src/views/Settings.js';

const SCHEMA = {
  type: 'object',
  required: ['league'],
  properties: {
    league: { type: 'string', title: 'League', description: 'Shown in the corner' },
    periods: { type: 'integer', default: 2 },
    ratio: { type: 'number' },
    overtime: { type: 'boolean' },
    theme: { enum: ['dark', 'light'] },
    apiKey: { type: 'string', 'x-secret': true },
    mail: {
      type: 'object',
      properties: { host: { type: 'string' }, password: { type: 'string', 'x-secret': true } },
    },
    teams: { type: 'array', items: { type: 'string' } },
    limits: { type: 'array', items: { type: 'integer' } },
    extra: { oneOf: [{ type: 'string' }, { type: 'number' }] },
  },
};
const SECRETS = ['/apiKey', '/mail/password'];

describe('the fields of a schema', () => {
  const fields = fieldsOf(SCHEMA, SECRETS);
  const kinds = Object.fromEntries(fields.map((field) => [field.name, field.kind]));

  it('gives each kind of property its kind of field', () => {
    expect(kinds).toEqual({
      league: 'string',
      periods: 'integer',
      ratio: 'number',
      overtime: 'boolean',
      theme: 'enum',
      apiKey: 'secret',
      mail: 'object',
      teams: 'list',
      limits: 'list',
      extra: 'json',
    });
  });

  it('takes title, description and whether a field is required from the schema', () => {
    expect(fields[0]).toMatchObject({
      path: '/league',
      title: 'League',
      description: 'Shown in the corner',
      required: true,
    });
    expect(fields[1]).toMatchObject({ path: '/periods', title: 'periods', required: false });
  });

  it('goes into nested objects', () => {
    const mail = fields.find((field) => field.name === 'mail');
    expect(
      mail?.kind === 'object' ? mail.fields.map((field) => [field.path, field.kind]) : [],
    ).toEqual([
      ['/mail/host', 'string'],
      ['/mail/password', 'secret'],
    ]);
  });

  it('falls back to one JSON field for a schema that is no object with properties', () => {
    expect(fieldsOf({ type: 'array' }, [])).toEqual([
      expect.objectContaining({ kind: 'json', path: '' }),
    ]);
  });
});

describe('the state of a form', () => {
  const fields = fieldsOf(SCHEMA, SECRETS);

  it('starts from the stored values, then the defaults, and never holds a secret', () => {
    const state = initialState(fields, {
      league: 'A',
      overtime: true,
      theme: 'light',
      teams: ['Red', 'Blue'],
      limits: [1, 2],
      extra: 5,
      mail: { host: 'smtp' },
    });
    expect(state).toEqual({
      '/league': 'A',
      '/periods': '2',
      '/ratio': '',
      '/overtime': true,
      '/theme': '1',
      '/apiKey': '',
      '/mail/host': 'smtp',
      '/mail/password': '',
      '/teams': 'Red\nBlue',
      '/limits': '1\n2',
      '/extra': '5',
    });
  });

  it('collects what was entered as the values to store', () => {
    const state = {
      ...initialState(fields, {}),
      '/league': 'B',
      '/periods': '3',
      '/ratio': '1.5',
      '/overtime': true,
      '/theme': '0',
      '/apiKey': 'new-key',
      '/mail/host': 'smtp',
      '/teams': 'Red\n\n Blue \n',
      '/limits': '4\n5',
      '/extra': '{"a":1}',
    };
    expect(collect(fields, state)).toEqual({
      problems: [],
      values: {
        league: 'B',
        periods: 3,
        ratio: 1.5,
        overtime: true,
        theme: 'dark',
        apiKey: 'new-key',
        mail: { host: 'smtp' },
        teams: ['Red', 'Blue'],
        limits: [4, 5],
        extra: { a: 1 },
      },
    });
  });

  it('leaves out what is empty, so that a secret is kept, and sends null to remove one', () => {
    const state = { ...initialState(fields, {}), '/league': 'B', '/periods': '' };
    expect(collect(fields, state).values).toEqual({ league: 'B', overtime: false });
    expect(collect(fields, state, new Set(['/apiKey'])).values).toEqual({
      league: 'B',
      overtime: false,
      apiKey: null,
    });
  });

  it('keeps what is stored under keys the form does not draw', () => {
    const stored = { league: 'A', legacy: { since: 2019 }, mail: { host: 'smtp', port: 25 } };
    const state = { ...initialState(fields, stored), '/league': 'B' };
    expect(collect(fields, state, new Set(), stored).values).toEqual({
      league: 'B',
      periods: 2,
      overtime: false,
      legacy: { since: 2019 },
      mail: { host: 'smtp', port: 25 },
    });
    // A drawn field that was emptied is gone all the same.
    const emptied = { ...state, '/mail/host': '' };
    expect(collect(fields, emptied, new Set(), stored).values).toMatchObject({
      mail: { port: 25 },
    });
  });

  it('stores an emptied text as empty where leaving it out would mean something else', () => {
    const schema = {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        title: { type: 'string', default: 'Scoreboard' },
        note: { type: 'string' },
      },
    };
    const some = fieldsOf(schema, []);
    const state = { ...initialState(some, {}), '/title': '' };
    // Required, or with a default that would come back: stored as empty. Else: left out.
    expect(collect(some, state).values).toEqual({ name: '', title: '' });
  });

  it('says what cannot be understood instead of sending it', () => {
    const state = {
      ...initialState(fields, {}),
      '/periods': 'two',
      '/limits': '1\nx',
      '/extra': '{nope',
    };
    expect(collect(fields, state).problems).toEqual([
      'periods: "two" is not a number',
      'limits: "x" is not a number',
      'extra: not valid JSON',
    ]);
  });
});

type Call = { method: string; path: string; body: unknown };

function serve(table: Record<string, unknown>) {
  const calls: Call[] = [];
  api.request = vi.fn(async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    const answer = table[`${method} ${path}`];
    if (answer instanceof Error) throw answer;
    return structuredClone(answer);
  }) as typeof api.request;
  return calls;
}

const described = (extra: object = {}) => ({
  schema: SCHEMA,
  values: { league: 'A', mail: {} },
  secretFields: SECRETS,
  secrets: ['/apiKey'],
  problems: [],
  bundle: { name: 'venue', state: 'running', errors: [] },
  ...extra,
});
const LIST = { bundles: [{ name: 'venue', title: 'Venue', state: 'running', errors: [] }] };

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('the settings page', () => {
  it('draws a form from the schema of each bundle that has one', async () => {
    serve({ 'GET /api/v1/config': LIST, 'GET /api/v1/bundles/venue/config': described() });
    const view = mount(SettingsView);
    await flushPromises();
    expect(view.find('[data-config="venue"] h2').text()).toBe('Venue');
    expect((view.find('[data-field="/league"]').element as HTMLInputElement).value).toBe('A');
    expect(view.find('[data-field="/overtime"]').attributes('type')).toBe('checkbox');
    expect(view.find('select[data-field="/theme"]').findAll('option')).toHaveLength(3);
    expect(view.find('textarea[data-field="/teams"]').exists()).toBe(true);
    expect(view.find('fieldset[data-group="/mail"] [data-field="/mail/host"]').exists()).toBe(true);
  });

  it('never shows a secret: an empty password field that says whether one is stored', async () => {
    serve({ 'GET /api/v1/config': LIST, 'GET /api/v1/bundles/venue/config': described() });
    const view = mount(SettingsView);
    await flushPromises();
    const key = view.find('[data-field="/apiKey"]');
    expect(key.attributes('type')).toBe('password');
    expect(key.attributes('autocomplete')).toBe('new-password');
    expect((key.element as HTMLInputElement).value).toBe('');
    expect(key.attributes('placeholder')).toContain('stored');
    expect(view.find('[data-field="/mail/password"]').attributes('placeholder')).toContain(
      'Not set',
    );
    // Only a stored secret can be removed.
    expect(view.find('[data-clear="/apiKey"]').exists()).toBe(true);
    expect(view.find('[data-clear="/mail/password"]').exists()).toBe(false);
  });

  it('saves what was entered and says that the extension was restarted', async () => {
    const calls = serve({
      'GET /api/v1/config': LIST,
      'GET /api/v1/bundles/venue/config': described(),
      'PUT /api/v1/bundles/venue/config': described({
        values: { league: 'B', mail: {} },
        restarted: true,
      }),
    });
    const view = mount(SettingsView);
    await flushPromises();
    await view.find('[data-field="/league"]').setValue('B');
    await view.find('[data-field="/mail/password"]').setValue('pw-123');
    await view.find('[data-config="venue"] form').trigger('submit');
    await flushPromises();
    expect(calls.at(-1)).toEqual({
      method: 'PUT',
      path: '/api/v1/bundles/venue/config',
      body: { values: { league: 'B', periods: 2, overtime: false, mail: { password: 'pw-123' } } },
    });
    expect(view.find('[data-config="venue"] [role="status"]').text()).toContain('Saved');
    // What was typed as a secret is gone from the page again.
    expect((view.find('[data-field="/mail/password"]').element as HTMLInputElement).value).toBe('');
  });

  it('sends back what is stored under keys it does not draw', async () => {
    const calls = serve({
      'GET /api/v1/config': LIST,
      'GET /api/v1/bundles/venue/config': described({ values: { league: 'A', legacy: 7 } }),
      'PUT /api/v1/bundles/venue/config': described(),
    });
    const view = mount(SettingsView);
    await flushPromises();
    await view.find('[data-config="venue"] form').trigger('submit');
    await flushPromises();
    expect(calls.at(-1)?.body).toEqual({
      values: { league: 'A', periods: 2, overtime: false, legacy: 7 },
    });
  });

  it('says so when the values were stored but the extension was not restarted', async () => {
    serve({
      'GET /api/v1/config': LIST,
      'GET /api/v1/bundles/venue/config': described(),
      'PUT /api/v1/bundles/venue/config': described({
        restarted: false,
        restartNote: 'The bundle is disabled. The settings apply when it is started.',
        bundle: { name: 'venue', state: 'disabled', errors: [] },
      }),
    });
    const view = mount(SettingsView);
    await flushPromises();
    await view.find('[data-config="venue"] form').trigger('submit');
    await flushPromises();
    const status = view.find('[data-config="venue"] [role="status"]').text();
    expect(status).toContain('Saved, but the extension was not restarted');
    expect(status).toContain('The bundle is disabled. The settings apply when it is started.');
    expect(status).not.toContain('was restarted with');
  });

  it('shows why the server refused, and what is wrong with what is stored', async () => {
    serve({
      'GET /api/v1/config': LIST,
      'GET /api/v1/bundles/venue/config': described({
        problems: ['config: /periods: must be >= 1'],
        bundle: { name: 'venue', state: 'failed', errors: [] },
      }),
      'PUT /api/v1/bundles/venue/config': new ApiError(400, 'invalid', 'Does not match'),
    });
    const view = mount(SettingsView);
    await flushPromises();
    expect(view.find('[data-config="venue"]').text()).toContain('config: /periods: must be >= 1');
    expect(view.find('[data-config="venue"]').text()).toContain('failed');
    await view.find('[data-config="venue"] form').trigger('submit');
    await flushPromises();
    expect(view.find('[data-config="venue"] [role="alert"]').text()).toContain('Does not match');
  });

  it('sends nothing that it could not understand', async () => {
    const calls = serve({
      'GET /api/v1/config': LIST,
      'GET /api/v1/bundles/venue/config': described(),
    });
    const view = mount(SettingsView);
    await flushPromises();
    await view.find('[data-field="/periods"]').setValue('two');
    await view.find('[data-config="venue"] form').trigger('submit');
    await flushPromises();
    expect(calls.filter((call) => call.method === 'PUT')).toEqual([]);
    expect(view.find('[data-config="venue"] [role="alert"]').text()).toContain('not a number');
  });

  it('says so when no bundle has settings', async () => {
    serve({ 'GET /api/v1/config': { bundles: [] } });
    const view = mount(SettingsView);
    await flushPromises();
    expect(view.text()).toContain('No bundle has settings');
  });
});
