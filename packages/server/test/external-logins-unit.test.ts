import type { AuthProvider } from '@mooncg/sdk/module';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuth } from '../src/auth/auth.js';
import { ExternalLogins, FLOW_TTL_MS, safeReturnTo } from '../src/modules/external-login.js';
import { ProviderRegistry } from '../src/modules/providers.js';
import { memoryStorage } from '../src/storage/replicant-store.js';
import { memoryLogger } from './helpers.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

const REDIRECT = 'http://127.0.0.1:9090/auth/fake/callback';

async function setup(provider: Partial<AuthProvider> = {}, providerTimeoutMs?: number) {
  const storage = memoryStorage();
  cleanup.push(() => storage.close());
  const clock = { now: 1_000_000 };
  const auth = createAuth({
    store: storage.auth,
    now: () => clock.now,
    scrypt: { N: 16, r: 1, p: 1 },
  });
  const ada = await auth.createUser({ name: 'ada', password: 'correct horse', roles: ['admin'] });
  auth.linkIdentity(ada.id, 'fake', 'sub-1');
  const providers = new ProviderRegistry();
  providers.add('test', '/modules/test', {
    id: 'fake',
    name: 'Fake',
    authorize: ({ state }) => `https://idp.example/?state=${state}`,
    callback: ({ query }) => ({ subject: query.code ?? '' }),
    ...provider,
  });
  const { logger, lines } = memoryLogger();
  const logins = new ExternalLogins({
    auth,
    providers,
    logger,
    now: () => clock.now,
    ...(providerTimeoutMs === undefined ? {} : { providerTimeoutMs }),
  });
  const begin = async (address = '10.0.0.1') => {
    const { url, ticket } = await logins.begin('fake', {
      redirectUri: REDIRECT,
      returnTo: '/',
      address,
    });
    return { ticket, state: new URL(url).searchParams.get('state') as string };
  };
  return { auth, clock, logins, providers, begin, lines };
}

describe('a started sign-in', () => {
  it('lasts ten minutes and no longer', async () => {
    const { logins, begin, clock } = await setup();
    const fresh = await begin();
    clock.now += FLOW_TTL_MS - 1;
    const inTime = await logins.complete('fake', {
      ticket: fresh.ticket,
      query: { state: fresh.state, code: 'sub-1' },
      address: '10.0.0.1',
    });
    expect(inTime.ok).toBe(true);

    const stale = await begin();
    clock.now += FLOW_TTL_MS + 1;
    const late = await logins.complete('fake', {
      ticket: stale.ticket,
      query: { state: stale.state, code: 'sub-1' },
      address: '10.0.0.1',
    });
    expect(late).toEqual({ ok: false, reason: 'state' });
  });

  it('keeps a bounded number of started sign-ins, the latest ones', async () => {
    const { logins, begin } = await setup();
    const first = await begin();
    // Each from an address of its own: what one address may hold is another limit.
    for (let n = 0; n < 1000; n++) await begin(`10.1.${n >> 8}.${n & 255}`);
    expect(logins.stats().pending).toBe(1000);
    const answer = await logins.complete('fake', {
      ticket: first.ticket,
      query: { state: first.state, code: 'sub-1' },
      address: '10.0.0.1',
    });
    expect(answer).toEqual({ ok: false, reason: 'state' });
  });

  it('counts a failed return against the address, and a good one not at all', async () => {
    const { logins, begin } = await setup();
    for (let n = 0; n < 30; n++) {
      const flow = await begin();
      const answer = await logins.complete('fake', {
        ticket: flow.ticket,
        query: { state: flow.state, code: 'sub-1' },
        address: '10.0.0.1',
      });
      expect(answer.ok, String(n)).toBe(true);
    }
    const outcomes: string[] = [];
    for (let n = 0; n < 22; n++) {
      const flow = await begin('10.0.0.2');
      const answer = await logins.complete('fake', {
        ticket: flow.ticket,
        query: { state: 'wrong', code: 'sub-1' },
        address: '10.0.0.2',
      });
      outcomes.push(answer.ok ? 'ok' : answer.reason);
    }
    expect(outcomes.slice(0, 19).every((reason) => reason === 'state')).toBe(true);
    expect(outcomes.at(-1)).toBe('throttled');
    // Another address is not held back by it.
    const flow = await begin('10.0.0.3');
    const other = await logins.complete('fake', {
      ticket: flow.ticket,
      query: { state: flow.state, code: 'sub-1' },
      address: '10.0.0.3',
    });
    expect(other.ok).toBe(true);
  });

  it('gives up on a provider that never answers', async () => {
    const { logins, begin } = await setup({ callback: () => new Promise(() => {}) }, 20);
    const flow = await begin();
    const answer = await logins.complete('fake', {
      ticket: flow.ticket,
      query: { state: flow.state, code: 'sub-1' },
      address: '10.0.0.1',
    });
    expect(answer).toEqual({ ok: false, reason: 'provider' });
  });

  it('remembers the latest attempts of accounts nobody linked, each once, and not forever', async () => {
    const { logins, begin } = await setup({
      callback: ({ query }) => ({ subject: query.code ?? '', name: 'x\u0007y'.repeat(100) }),
    });
    for (let n = 0; n < 30; n++) {
      for (let twice = 0; twice < 2; twice++) {
        const flow = await begin(`10.0.1.${n}`);
        await logins.complete('fake', {
          ticket: flow.ticket,
          query: { state: flow.state, code: `stranger-${n}` },
          address: `10.0.1.${n}`,
        });
      }
    }
    const unlinked = logins.unlinked();
    expect(unlinked).toHaveLength(20);
    expect(unlinked[0]?.subject).toBe('stranger-29');
    // A name is what a stranger chose: shown without control characters and cut short.
    expect(unlinked[0]?.name).toMatch(/^[xy ]{1,64}$/);
  });
});

describe('safeReturnTo', () => {
  it('keeps a path of this server', () => {
    expect(safeReturnTo('/')).toBe('/');
    expect(safeReturnTo('/w/Show?a=1&b=2#c')).toBe('/w/Show?a=1&b=2#c');
    expect(safeReturnTo('/admin/users')).toBe('/admin/users');
  });

  it('answers "/" for everything else', () => {
    for (const value of [
      undefined,
      5,
      '',
      'w/Show',
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      '/..//evil.example',
      '/a/../..//evil.example',
      '/%2e%2e//evil.example',
      '/\t/evil.example',
      '/x\r\nSet-Cookie: a=b',
      `/${'a'.repeat(3000)}`,
    ]) {
      const safe = safeReturnTo(value);
      expect(safe.startsWith('//'), String(value)).toBe(false);
      expect(new URL(safe, 'http://mooncg.test').origin, String(value)).toBe('http://mooncg.test');
      expect(/[\r\n\\]/.test(safe), String(value)).toBe(false);
    }
    expect(safeReturnTo('https://evil.example')).toBe('/');
    expect(safeReturnTo('/..//evil.example')).toBe('/');
  });
});
