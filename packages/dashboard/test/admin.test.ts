// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api.js';
import { RolesView } from '../src/views/Roles.js';
import { TokensView } from '../src/views/Tokens.js';
import { UsersView } from '../src/views/Users.js';

type Call = { method: string; path: string; body: unknown };

/** Answers API calls from a table of `METHOD path` to a value, an error or a function. */
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

const USERS = {
  users: [
    { id: 'u1', name: 'ada', disabled: false, roles: ['admin'] },
    { id: 'u2', name: 'vera', disabled: true, roles: ['viewer'] },
  ],
};
const ROLES = {
  roles: [
    { name: 'admin', builtin: true, grants: ['*'] },
    { name: 'replay', builtin: false, grants: ['bundle:replay:view'] },
    { name: 'viewer', builtin: true, grants: ['system:dashboard.view'] },
  ],
};

beforeEach(() => {
  vi.stubGlobal('confirm', () => true);
  setActivePinia(createPinia());
});

describe('the users page', () => {
  const table = {
    'GET /api/v1/users': USERS,
    'GET /api/v1/roles': ROLES,
    'POST /api/v1/users': { user: {} },
    'PATCH /api/v1/users/u2': { user: {} },
    'PUT /api/v1/users/u2/roles/replay': undefined,
    'DELETE /api/v1/users/u1/roles/admin': new ApiError(
      409,
      'conflict',
      'The last administrator stays',
    ),
    'PUT /api/v1/users/u2/password': undefined,
    'DELETE /api/v1/users/u2': undefined,
  };
  async function show() {
    const calls = serve(table);
    const view = mount(UsersView);
    await flushPromises();
    return { view, calls };
  }

  it('lists the users with their roles and state', async () => {
    const { view } = await show();
    const rows = view.findAll('[data-user]');
    expect(rows.map((row) => row.attributes('data-user'))).toEqual(['ada', 'vera']);
    expect(rows[1]?.text()).toContain('disabled');
    const checked = rows[0]
      ?.findAll('input[type="checkbox"]')
      .filter((box) => (box.element as HTMLInputElement).checked);
    expect(checked?.map((box) => box.attributes('data-role'))).toEqual(['admin']);
  });

  it('creates a user with the chosen roles', async () => {
    const { view, calls } = await show();
    const form = view.find('form[data-form="create"]');
    await form.find('input[name="name"]').setValue('bob');
    await form.find('input[name="password"]').setValue('correct horse');
    await form.find('input[data-role="viewer"]').setValue(true);
    await form.trigger('submit');
    await flushPromises();
    expect(sent(calls)[0]).toEqual({
      method: 'POST',
      path: '/api/v1/users',
      body: { name: 'bob', password: 'correct horse', roles: ['viewer'] },
    });
  });

  it('enables, assigns a role, resets a password and deletes', async () => {
    const { view, calls } = await show();
    const row = view.find('[data-user="vera"]');
    await row.find('[data-action="toggle"]').trigger('click');
    await row.find('input[data-role="replay"]').setValue(true);
    await row.find('input[name="new-password"]').setValue('brand new password');
    await row.find('form').trigger('submit');
    await row.find('[data-action="delete"]').trigger('click');
    await flushPromises();
    expect(sent(calls)).toEqual([
      { method: 'PATCH', path: '/api/v1/users/u2', body: { disabled: false } },
      { method: 'PUT', path: '/api/v1/users/u2/roles/replay', body: undefined },
      {
        method: 'PUT',
        path: '/api/v1/users/u2/password',
        body: { password: 'brand new password' },
      },
      { method: 'DELETE', path: '/api/v1/users/u2', body: undefined },
    ]);
  });

  it('shows why the server refused', async () => {
    const { view } = await show();
    await view.find('[data-user="ada"] input[data-role="admin"]').setValue(false);
    await flushPromises();
    expect(view.find('[role="alert"]').text()).toBe('The last administrator stays');
  });
});

describe('the roles page', () => {
  async function show() {
    const calls = serve({
      'GET /api/v1/roles': ROLES,
      'POST /api/v1/roles': { role: {} },
      'POST /api/v1/roles/replay/grants': { role: {} },
      'DELETE /api/v1/roles/replay/grants/bundle%3Areplay%3Aview': { role: {} },
      'DELETE /api/v1/roles/replay': undefined,
    });
    const view = mount(RolesView);
    await flushPromises();
    return { view, calls };
  }

  it('lists roles with their grants and protects the built-in ones', async () => {
    const { view } = await show();
    expect(view.findAll('[data-role]').map((row) => row.attributes('data-role'))).toEqual([
      'admin',
      'replay',
      'viewer',
    ]);
    expect(view.find('[data-role="replay"]').text()).toContain('bundle:replay:view');
    expect(view.find('[data-role="admin"] [data-action="delete"]').exists()).toBe(false);
    expect(view.find('[data-role="replay"] [data-action="delete"]').exists()).toBe(true);
  });

  it('adds and removes a grant, creates and deletes a role', async () => {
    const { view, calls } = await show();
    const row = view.find('[data-role="replay"]');
    await row.find('input[name="grant"]').setValue('bundle:replay:operate');
    await row.find('form').trigger('submit');
    await row.find('[data-action="revoke"]').trigger('click');
    await row.find('[data-action="delete"]').trigger('click');
    const create = view.find('form[data-form="create"]');
    await create.find('input[name="name"]').setValue('camera');
    await create.trigger('submit');
    await flushPromises();
    expect(sent(calls)).toEqual([
      {
        method: 'POST',
        path: '/api/v1/roles/replay/grants',
        body: { permission: 'bundle:replay:operate' },
      },
      {
        method: 'DELETE',
        path: '/api/v1/roles/replay/grants/bundle%3Areplay%3Aview',
        body: undefined,
      },
      { method: 'DELETE', path: '/api/v1/roles/replay', body: undefined },
      { method: 'POST', path: '/api/v1/roles', body: { name: 'camera', grants: [] } },
    ]);
  });
});

describe('the tokens page', () => {
  async function show() {
    const calls = serve({
      'GET /api/v1/tokens': {
        tokens: [
          {
            id: 't1',
            name: 'OBS',
            grants: ['bundle:board:view'],
            expires: null,
            lastUsed: '2026-01-02T03:04:05.000Z',
            createdBy: 'u1',
          },
        ],
      },
      'POST /api/v1/tokens': { token: { id: 't2', name: 'Deck' }, secret: 'mcg_shown-once' },
      'DELETE /api/v1/tokens/t1': undefined,
    });
    const view = mount(TokensView);
    await flushPromises();
    return { view, calls };
  }

  it('lists tokens without any secret', async () => {
    const { view } = await show();
    const row = view.find('[data-token="t1"]');
    expect(row.text()).toContain('OBS');
    expect(row.text()).toContain('bundle:board:view');
    expect(view.text()).not.toContain('mcg_');
  });

  it('creates a token, shows its secret once, and revokes', async () => {
    const { view, calls } = await show();
    const form = view.find('form[data-form="create"]');
    await form.find('input[name="name"]').setValue('Deck');
    await form
      .find('textarea[name="grants"]')
      .setValue('bundle:board:view\n bundle:board:operate \n');
    await form.find('input[name="expires"]').setValue('2030-01-31');
    await form.trigger('submit');
    await flushPromises();
    expect(sent(calls)[0]).toEqual({
      method: 'POST',
      path: '/api/v1/tokens',
      body: {
        name: 'Deck',
        grants: ['bundle:board:view', 'bundle:board:operate'],
        expires: '2030-01-31T00:00:00.000Z',
      },
    });
    expect(view.find('[data-secret]').text()).toContain('mcg_shown-once');
    await view.find('[data-token="t1"] [data-action="revoke"]').trigger('click');
    await flushPromises();
    expect(sent(calls)[1]).toMatchObject({ method: 'DELETE', path: '/api/v1/tokens/t1' });
  });
});
