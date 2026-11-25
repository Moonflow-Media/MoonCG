// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api.js';
import { routes } from '../src/router.js';
import { useSession } from '../src/stores/session.js';
import { AccountView, accountNavigation } from '../src/views/Account.js';

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
const sent = (calls: Call[]) => calls.filter((call) => call.method !== 'GET');

const IDENTITIES = {
  identities: [{ provider: 'twitch', subject: '42' }],
  providers: [
    { id: 'twitch', name: 'Twitch', selfLink: true },
    { id: 'oidc', name: 'Company', selfLink: true },
    { id: 'discord', name: 'Discord', selfLink: false },
  ],
  password: true,
};

async function show(table: Record<string, unknown> = {}, search = '') {
  history.replaceState(null, '', `/account${search}`);
  const calls = serve({ 'GET /api/v1/me/identities': IDENTITIES, ...table });
  useSession().me = {
    user: { id: 'user:1', kind: 'user', name: 'ada' },
    roles: ['admin', 'operator'],
    permissions: [],
  };
  const view = mount(AccountView);
  await flushPromises();
  return { view, calls };
}
const buttonOf = (view: ReturnType<typeof mount>, label: string) =>
  view.findAll('button').find((candidate) => candidate.text() === label);

beforeEach(() => {
  setActivePinia(createPinia());
  vi.stubGlobal('confirm', () => true);
});

describe('the account page', () => {
  it('is a page of the dashboard', () => {
    expect(routes.some((route) => route.path === '/account')).toBe(true);
  });

  it('shows the name and the roles', async () => {
    const { view } = await show();
    expect(view.find('[data-account-name]').text()).toBe('ada');
    expect(view.find('[data-account-roles]').text()).toBe('admin, operator');
  });

  it('lists the linked accounts and offers the providers that allow linking', async () => {
    const { view } = await show();
    expect(view.findAll('[data-identity]').map((item) => item.find('span').text())).toEqual([
      'Twitch: 42',
    ]);
    expect(buttonOf(view, 'Link Company')).toBeDefined();
    expect(buttonOf(view, 'Link Twitch')).toBeDefined();
    expect(buttonOf(view, 'Link Discord')).toBeUndefined();
  });

  it('starts a link with the password and goes to the provider', async () => {
    const go = vi.fn();
    accountNavigation.go = go;
    const { view, calls } = await show({
      'POST /api/v1/me/identities/oidc/link': { url: 'https://idp.example/authorize?state=s' },
    });
    await view.find('input[name="link-password"]').setValue('correct horse');
    await buttonOf(view, 'Link Company')?.trigger('click');
    await flushPromises();
    expect(sent(calls)).toEqual([
      {
        method: 'POST',
        path: '/api/v1/me/identities/oidc/link',
        body: { password: 'correct horse' },
      },
    ]);
    expect(go).toHaveBeenCalledWith('https://idp.example/authorize?state=s');
  });

  it('says why a link was refused', async () => {
    const { view } = await show({
      'POST /api/v1/me/identities/oidc/link': new ApiError(
        403,
        'forbidden',
        'The current password is wrong',
      ),
    });
    await buttonOf(view, 'Link Company')?.trigger('click');
    await flushPromises();
    expect(view.find('.problem').text()).toContain('password is wrong');
  });

  it('says how a link that came back ended', async () => {
    const linked = await show({}, '?linked=twitch');
    expect(linked.view.find('.done').text()).toContain('Twitch');
    const refused = await show({}, '?error=elsewhere');
    expect(refused.view.find('.problem').text()).toContain('another user');
  });

  it('unlinks an account after asking, which signs out', async () => {
    const asked: string[] = [];
    vi.stubGlobal('confirm', (question: string) => {
      asked.push(question);
      return true;
    });
    const go = vi.fn();
    accountNavigation.go = go;
    const { view, calls } = await show({ 'DELETE /api/v1/me/identities/twitch/42': undefined });
    // Unlinking takes the password, as linking does.
    await view.find('input[name="link-password"]').setValue('correct horse');
    await buttonOf(view, 'Unlink')?.trigger('click');
    await flushPromises();
    expect(asked[0]).toMatch(/signed out/);
    expect(sent(calls)).toEqual([
      {
        method: 'DELETE',
        path: '/api/v1/me/identities/twitch/42',
        body: { password: 'correct horse' },
      },
    ]);
    expect(go).toHaveBeenCalledWith('/login');
  });

  it('asks for the password to unlink even where no provider allows linking', async () => {
    const { view } = await show({
      'GET /api/v1/me/identities': {
        ...IDENTITIES,
        providers: IDENTITIES.providers.map((provider) => ({ ...provider, selfLink: false })),
      },
    });
    expect(view.find('input[name="link-password"]').exists()).toBe(true);
  });

  it('unlinks without a password for a user who has none', async () => {
    const { view, calls } = await show({
      'GET /api/v1/me/identities': { ...IDENTITIES, password: false },
      'DELETE /api/v1/me/identities/twitch/42': undefined,
    });
    accountNavigation.go = vi.fn();
    await buttonOf(view, 'Unlink')?.trigger('click');
    await flushPromises();
    expect(sent(calls)).toEqual([
      { method: 'DELETE', path: '/api/v1/me/identities/twitch/42', body: {} },
    ]);
  });

  it('shows "linked" only for a provider it knows, so the address cannot put words on the page', async () => {
    const spoofed = await show({}, `?linked=${encodeURIComponent('Bank. Call 555-0100 now')}`);
    expect(spoofed.view.find('.done').exists()).toBe(false);
    expect(spoofed.view.text()).not.toContain('555-0100');
  });

  it('changes the password', async () => {
    const { view, calls } = await show({ 'POST /api/v1/me/password': undefined });
    const form = view.find('form[data-password]');
    await form.find('input[name="current"]').setValue('correct horse');
    await form.find('input[name="password"]').setValue('battery staple');
    await form.trigger('submit');
    await flushPromises();
    expect(sent(calls)).toEqual([
      {
        method: 'POST',
        path: '/api/v1/me/password',
        body: { current: 'correct horse', password: 'battery staple' },
      },
    ]);
    expect(view.find('form[data-password] .done').exists()).toBe(true);
  });

  it('has no password form for a user without a password', async () => {
    const { view } = await show({
      'GET /api/v1/me/identities': { ...IDENTITIES, password: false },
    });
    expect(view.find('form[data-password]').exists()).toBe(false);
    expect(view.find('input[name="link-password"]').exists()).toBe(false);
    expect(view.text()).toContain('within five minutes');
  });
});
