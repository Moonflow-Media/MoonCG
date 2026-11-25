// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api.js';
import { navigation } from '../src/nav.js';
import { routes } from '../src/router.js';
import { useSession } from '../src/stores/session.js';
import { ModulesView } from '../src/views/Modules.js';
import { RolesView } from '../src/views/Roles.js';
import { SettingsView } from '../src/views/Settings.js';
import { UsersView } from '../src/views/Users.js';

type Call = { method: string; path: string; body: unknown };

/** Answers API calls from a table of `METHOD path` to a value or an error. */
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
const sent = (calls: Call[]) => calls.filter((call) => call.method !== 'GET');

const module = (name: string, extra: object = {}) => ({
  name,
  version: '1.0.0',
  builtin: false,
  internal: false,
  enabled: false,
  state: 'disabled',
  config: false,
  providers: [],
  permissions: [],
  routes: 0,
  ...extra,
});
const MODULES = {
  modules: [
    module('auth-local', {
      title: 'Local accounts',
      builtin: true,
      internal: true,
      enabled: true,
      state: 'running',
    }),
    module('auth-oidc', {
      title: 'External logins',
      builtin: true,
      enabled: true,
      state: 'running',
      config: true,
      providers: ['oidc', 'twitch'],
    }),
    module('broken', { enabled: true, state: 'failed', error: 'The setup broke' }),
    module('hello', { version: '2.1.0', permissions: [{ permission: 'system:module.hello.use' }] }),
  ],
};

beforeEach(() => {
  vi.stubGlobal('confirm', () => true);
  setActivePinia(createPinia());
});

describe('the navigation', () => {
  it('has the modules page for whoever may manage modules, and for nobody else', () => {
    const labels = (permissions: string[]) => navigation(permissions, []).map((item) => item.label);
    expect(labels(['system:modules.manage'])).toEqual(['Modules']);
    expect(labels(['system:dashboard.view', 'system:bundles.manage'])).not.toContain('Modules');
    expect(routes.map((route) => route.path)).toContain('/modules');
  });
});

describe('the modules page', () => {
  async function show(table: Record<string, unknown> = {}) {
    const calls = serve({ 'GET /api/v1/modules': MODULES, ...table });
    const view = mount(ModulesView);
    await flushPromises();
    return { view, calls };
  }
  const row = (view: ReturnType<typeof mount>, name: string) =>
    view.find(`[data-module="${name}"]`);

  it('lists the modules with their state, and why one failed', async () => {
    const { view } = await show();
    expect(view.findAll('[data-module]').map((item) => item.attributes('data-module'))).toEqual([
      'auth-local',
      'auth-oidc',
      'broken',
      'hello',
    ]);
    expect(row(view, 'auth-oidc').find('.state').text()).toBe('running');
    expect(row(view, 'auth-oidc').text()).toContain('External logins');
    expect(row(view, 'auth-oidc').text()).toContain('Sign-in: oidc, twitch');
    expect(row(view, 'broken').find('.state').classes()).toContain('failed');
    expect(row(view, 'broken').text()).toContain('The setup broke');
    expect(row(view, 'hello').text()).toContain('2.1.0');
  });

  it('enables a module that is off', async () => {
    const { view, calls } = await show({
      'POST /api/v1/modules/hello/enable': { module: module('hello', { state: 'running' }) },
    });
    await row(view, 'hello').find('[data-action="enable"]').trigger('click');
    await flushPromises();
    expect(sent(calls)).toEqual([
      { method: 'POST', path: '/api/v1/modules/hello/enable', body: {} },
    ]);
    // The list is asked for again, so the page shows what the server has.
    expect(calls.filter((call) => call.path === '/api/v1/modules')).toHaveLength(2);
  });

  it('disables a running module after asking, and tries a failed one again', async () => {
    const { view, calls } = await show({
      'POST /api/v1/modules/auth-oidc/disable': { module: module('auth-oidc') },
      'POST /api/v1/modules/broken/enable': { module: module('broken') },
    });
    const asked: string[] = [];
    vi.stubGlobal('confirm', (question: string) => {
      asked.push(question);
      return true;
    });
    await row(view, 'auth-oidc').find('[data-action="disable"]').trigger('click');
    await flushPromises();
    expect(asked[0]).toMatch(/oidc, twitch/);
    await row(view, 'broken').find('[data-action="enable"]').trigger('click');
    await flushPromises();
    expect(sent(calls).map((call) => call.path)).toEqual([
      '/api/v1/modules/auth-oidc/disable',
      '/api/v1/modules/broken/enable',
    ]);
    expect(row(view, 'broken').find('[data-action="enable"]').text()).toBe('Try again');
  });

  it('does nothing when the question is answered with no', async () => {
    const { view, calls } = await show();
    vi.stubGlobal('confirm', () => false);
    await row(view, 'auth-oidc').find('[data-action="disable"]').trigger('click');
    await flushPromises();
    expect(sent(calls)).toEqual([]);
  });

  it('has nothing to switch for a module that is part of the server', async () => {
    const { view } = await show();
    expect(row(view, 'auth-local').find('[data-action]').exists()).toBe(false);
    expect(row(view, 'auth-local').text()).toContain('part of the server');
  });

  it('links to the settings of a module that has some', async () => {
    const { view } = await show();
    expect(row(view, 'auth-oidc').find('a[href="/settings"]').exists()).toBe(true);
    expect(row(view, 'hello').find('a[href="/settings"]').exists()).toBe(false);
  });

  it('says why a change was refused', async () => {
    const { view } = await show({
      'POST /api/v1/modules/hello/enable': new ApiError(403, 'forbidden', 'Missing permission'),
    });
    await row(view, 'hello').find('[data-action="enable"]').trigger('click');
    await flushPromises();
    expect(view.find('[role="alert"]').text()).toBe('Missing permission');
  });
});

describe('the settings of modules', () => {
  const DESCRIBED = {
    schema: {
      type: 'object',
      properties: {
        twitch: {
          type: 'object',
          title: 'Twitch',
          properties: {
            enabled: { type: 'boolean' },
            clientId: { type: 'string' },
            clientSecret: { type: 'string', 'x-secret': true },
          },
        },
      },
    },
    values: { twitch: { enabled: true, clientId: 'abc' } },
    secretFields: ['/twitch/clientSecret'],
    secrets: ['/twitch/clientSecret'],
    problems: [],
    module: { name: 'auth-oidc', state: 'running' },
  };
  const table = {
    'GET /api/v1/config': { bundles: [] },
    'GET /api/v1/modules': MODULES,
    'GET /api/v1/modules/auth-oidc/config': DESCRIBED,
  };
  const holding = (...permissions: string[]) => {
    useSession().me = { user: { id: 'user:1', kind: 'user', name: 'ada' }, roles: [], permissions };
  };

  it('shows a form per module with settings to whoever may manage modules', async () => {
    holding('*');
    serve(table);
    const view = mount(SettingsView);
    await flushPromises();
    const form = view.find('[data-config="module:auth-oidc"]');
    expect(form.exists()).toBe(true);
    expect(form.find('h2').text()).toBe('External logins');
    expect((form.find('[data-field="/twitch/clientId"]').element as HTMLInputElement).value).toBe(
      'abc',
    );
    // The secret is never filled in.
    expect(
      (form.find('[data-field="/twitch/clientSecret"]').element as HTMLInputElement).value,
    ).toBe('');
    expect(view.text()).not.toContain('No bundle has settings');
  });

  it('saves to the module and says that it was started again', async () => {
    holding('*');
    const calls = serve({
      ...table,
      'PUT /api/v1/modules/auth-oidc/config': { ...DESCRIBED, restarted: true },
    });
    const view = mount(SettingsView);
    await flushPromises();
    const form = view.find('[data-config="module:auth-oidc"]');
    await form.find('[data-field="/twitch/clientId"]').setValue('xyz');
    await form.find('form').trigger('submit');
    await flushPromises();
    expect(sent(calls)).toEqual([
      {
        method: 'PUT',
        path: '/api/v1/modules/auth-oidc/config',
        body: { values: { twitch: { enabled: true, clientId: 'xyz' } } },
      },
    ]);
    expect(form.find('[role="status"]').text()).toBe(
      'Saved. The module was started again with the new settings.',
    );
  });

  it('says why a module did not start with what was saved', async () => {
    holding('*');
    serve({
      ...table,
      'PUT /api/v1/modules/auth-oidc/config': {
        ...DESCRIBED,
        restarted: false,
        restartNote: 'Twitch is enabled but has no client ID',
        module: { name: 'auth-oidc', state: 'failed' },
      },
    });
    const view = mount(SettingsView);
    await flushPromises();
    const form = view.find('[data-config="module:auth-oidc"]');
    await form.find('form').trigger('submit');
    await flushPromises();
    expect(form.find('[role="status"]').text()).toBe(
      'Saved, but the module is not running. Twitch is enabled but has no client ID',
    );
  });

  it('does not ask for modules without the permission', async () => {
    holding('system:dashboard.view', 'system:settings.manage');
    const calls = serve(table);
    const view = mount(SettingsView);
    await flushPromises();
    expect(calls.map((call) => call.path)).toEqual(['/api/v1/config']);
    expect(view.find('[data-config^="module:"]').exists()).toBe(false);
  });
});

describe('external accounts on the users page', () => {
  const table = {
    'GET /api/v1/users': {
      users: [
        { id: 'u1', name: 'ada', disabled: false, roles: ['admin'] },
        { id: 'u2', name: 'bob', disabled: false, roles: [] },
        { id: 'u3', name: 'dev', disabled: false, roles: ['admin'], devMode: true },
      ],
    },
    'GET /api/v1/roles': { roles: [{ name: 'admin' }] },
    'GET /api/v1/identities': {
      identities: [{ userId: 'u1', provider: 'twitch', subject: '42/7' }],
      providers: [
        { id: 'twitch', name: 'Twitch' },
        { id: 'discord', name: 'Discord' },
      ],
      unlinked: [
        { provider: 'discord', subject: '99', name: 'nelly', at: '2026-11-25T10:00:00.000Z' },
      ],
    },
    'DELETE /api/v1/users/u1/identities/twitch/42%2F7': undefined,
    'PUT /api/v1/users/u2/identities/discord': undefined,
  };
  async function show(extra: Record<string, unknown> = {}) {
    const calls = serve({ ...table, ...extra });
    const view = mount(UsersView);
    await flushPromises();
    return { view, calls };
  }

  it('shows the accounts each user can sign in with', async () => {
    const { view } = await show();
    const linked = view.find('[data-user="ada"]').findAll('[data-identity]');
    expect(linked.map((item) => item.text())).toEqual(['Twitch: 42/7 Unlink']);
    expect(view.find('[data-user="bob"]').findAll('[data-identity]')).toHaveLength(0);
  });

  it('unlinks an account after asking', async () => {
    const { view, calls } = await show();
    await view.find('[data-user="ada"] [data-action="unlink"]').trigger('click');
    await flushPromises();
    expect(sent(calls)).toEqual([
      { method: 'DELETE', path: '/api/v1/users/u1/identities/twitch/42%2F7', body: undefined },
    ]);
  });

  it('links an account by its id at the provider', async () => {
    const { view, calls } = await show();
    const form = view.find('[data-user="bob"] form[data-form="link"]');
    await form.find('select').setValue('discord');
    await form.find('input[name="subject"]').setValue(' 99 ');
    await form.trigger('submit');
    await flushPromises();
    expect(sent(calls)).toEqual([
      { method: 'PUT', path: '/api/v1/users/u2/identities/discord', body: { subject: '99' } },
    ]);
  });

  it('lists the accounts that tried to sign in and belong to nobody, to be linked', async () => {
    const { view, calls } = await show();
    const attempt = view.find('[data-unlinked="discord:99"]');
    expect(attempt.text()).toContain('Discord');
    expect(attempt.text()).toContain('nelly');
    expect(attempt.text()).toContain('99');
    // The user of dev mode cannot be linked, so it is not on offer.
    expect(attempt.findAll('option').map((option) => option.text())).toEqual([
      'Link to…',
      'ada',
      'bob',
    ]);
    await attempt.find('select').setValue('u2');
    await attempt.find('[data-action="link"]').trigger('click');
    await flushPromises();
    expect(sent(calls)).toEqual([
      { method: 'PUT', path: '/api/v1/users/u2/identities/discord', body: { subject: '99' } },
    ]);
  });

  it('shows the realm a link is bound to, and links an attempt for the realm it came from', async () => {
    const { view, calls } = await show({
      'GET /api/v1/identities': {
        identities: [
          { userId: 'u1', provider: 'oidc', subject: 'a1', realm: 'https://id.example' },
          { userId: 'u1', provider: 'oidc', subject: 'a2' },
        ],
        providers: [{ id: 'oidc', name: 'Company' }],
        unlinked: [
          {
            provider: 'oidc',
            subject: '99',
            realm: 'https://other.example',
            name: 'nelly',
            at: '2026-11-25T10:00:00.000Z',
          },
        ],
      },
      'PUT /api/v1/users/u2/identities/oidc': undefined,
    });
    const linked = view.find('[data-user="ada"]').findAll('[data-identity]');
    expect(linked.map((item) => item.find('[data-realm]').exists())).toEqual([true, false]);
    expect(linked[0]?.find('[data-realm]').text()).toBe('https://id.example');
    const attempt = view.find('[data-unlinked="oidc:99"]');
    expect(attempt.find('[data-realm]').text()).toBe('https://other.example');
    await attempt.find('select').setValue('u2');
    await attempt.find('[data-action="link"]').trigger('click');
    await flushPromises();
    expect(sent(calls)).toEqual([
      {
        method: 'PUT',
        path: '/api/v1/users/u2/identities/oidc',
        body: { subject: '99', realm: 'https://other.example' },
      },
    ]);
  });

  it('puts the provider and the id of an attempt before the name, which it marks as chosen by the account', async () => {
    const { view } = await show();
    const attempt = view.find('[data-unlinked="discord:99"]');
    const text = attempt.text();
    expect(text.indexOf('Discord')).toBeLessThan(text.indexOf('nelly'));
    expect(text.indexOf('99')).toBeLessThan(text.indexOf('nelly'));
    expect(attempt.find('[data-claimed-name]').text()).toBe('calls itself "nelly"');
    expect(attempt.find('strong').text()).toBe('Discord');
    expect(attempt.find('strong + code').text()).toBe('99');
  });

  it('offers nothing to link where there is no provider, and nothing for the user of dev mode', async () => {
    const { view } = await show({
      'GET /api/v1/identities': { identities: [], providers: [], unlinked: [] },
    });
    expect(view.find('form[data-form="link"]').exists()).toBe(false);
    expect(view.find('[data-unlinked]').exists()).toBe(false);
    const withProviders = await show();
    expect(withProviders.view.find('[data-user="dev"] form[data-form="link"]').exists()).toBe(
      false,
    );
  });

  it('works without the list of accounts, as on a server without modules', async () => {
    const { view } = await show({
      'GET /api/v1/identities': new ApiError(404, 'not_found', 'Not found'),
    });
    expect(view.findAll('[data-user]')).toHaveLength(3);
    expect(view.find('[role="alert"]').exists()).toBe(false);
  });
});

describe('the permissions on the roles page', () => {
  it('lists what there is to grant, with what the modules defined', async () => {
    serve({
      'GET /api/v1/roles': { roles: [{ name: 'admin', builtin: true, grants: ['*'] }] },
      'GET /api/v1/permissions': {
        permissions: [
          { permission: 'system:logs.view', description: 'Read the server log' },
          {
            permission: 'system:module.hello.use',
            description: 'Use the greeting',
            module: 'hello',
          },
        ],
      },
    });
    const view = mount(RolesView);
    await flushPromises();
    const known = view.findAll('[data-permission]');
    expect(known.map((item) => item.attributes('data-permission'))).toEqual([
      'system:logs.view',
      'system:module.hello.use',
    ]);
    expect(known[1]?.text()).toContain('Use the greeting');
    expect(known[1]?.text()).toContain('module hello');
  });

  it('shows the roles also when the list of permissions is not to be had', async () => {
    serve({
      'GET /api/v1/roles': { roles: [{ name: 'admin', builtin: true, grants: ['*'] }] },
      'GET /api/v1/permissions': new ApiError(404, 'not_found', 'Not found'),
    });
    const view = mount(RolesView);
    await flushPromises();
    expect(view.find('[data-role="admin"]').exists()).toBe(true);
    expect(view.find('[data-permission]').exists()).toBe(false);
    expect(view.find('[role="alert"]').exists()).toBe(false);
  });
});
