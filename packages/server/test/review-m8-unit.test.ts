import type { AuthProvider } from '@mooncg/sdk/module';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuth, SIGNUP_LIMIT, ThrottledError } from '../src/auth/auth.js';
import { printable } from '../src/kernel/logger.js';
import {
  ExternalLogins,
  MAX_PENDING_PER_ADDRESS,
  MAX_UNLINKED_PER_ADDRESS,
  START_LIMIT,
} from '../src/modules/external-login.js';
import { ProviderRegistry } from '../src/modules/providers.js';
import { publicUrlWarning } from '../src/server.js';
import { sqlAuthStore } from '../src/storage/auth-store.js';
import { migrate, openSqliteDb } from '../src/storage/db.js';
import { MIGRATIONS, memoryStorage } from '../src/storage/replicant-store.js';
import { memoryLogger } from './helpers.js';

/** What the security review of milestone 8 found, as far as it shows without a server. */

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

const REDIRECT = 'http://127.0.0.1:9090/auth/fake/callback';
const CHEAP = { N: 16, r: 1, p: 1 };
/** Format characters, which draw nothing and can reorder what is drawn around them. */
const [RLO, ZWSP, LRI, BOM, BEL] = [0x202e, 0x200b, 0x2066, 0xfeff, 0x07].map((code) =>
  String.fromCodePoint(code),
) as [string, string, string, string, string];

async function setup(
  provider: Partial<AuthProvider> = {},
  signupLimit?: { max: number; windowMs: number },
) {
  const storage = memoryStorage();
  cleanup.push(() => storage.close());
  const clock = { now: 1_000_000 };
  const auth = createAuth({
    store: storage.auth,
    now: () => clock.now,
    scrypt: CHEAP,
    ...(signupLimit === undefined ? {} : { signupLimit }),
  });
  const ada = await auth.createUser({ name: 'ada', password: 'correct horse', roles: ['admin'] });
  auth.linkIdentity(ada.id, 'fake', 'sub-1');
  const providers = new ProviderRegistry();
  const asked = { authorize: 0 };
  providers.add('test', '/modules/test', {
    id: 'fake',
    name: 'Fake',
    authorize: ({ state }) => {
      asked.authorize++;
      return `https://idp.example/?state=${state}`;
    },
    // The code is `<subject>`, `<subject>|<name>` or `<subject>|<name>|<realm>`.
    callback: ({ query }) => {
      const [subject = '', name, realm] = (query.code ?? '').split('|');
      return { subject, name: name || undefined, realm: realm || undefined };
    },
    ...provider,
  });
  const { logger, lines } = memoryLogger();
  const logins = new ExternalLogins({ auth, providers, logger, now: () => clock.now });
  const begin = async (address = '10.0.0.1') => {
    const { url, ticket } = await logins.begin('fake', {
      redirectUri: REDIRECT,
      returnTo: '/',
      address,
    });
    return { ticket, state: new URL(url).searchParams.get('state') as string };
  };
  const finish = (flow: { ticket: string; state: string }, code: string, address = '10.0.0.1') =>
    logins.complete('fake', { ticket: flow.ticket, query: { state: flow.state, code }, address });
  /** A whole sign-in as the account `code` stands for. */
  const signIn = async (code: string, address = '10.0.0.1') =>
    finish(await begin(address), code, address);
  return { auth, ada, clock, logins, providers, begin, finish, signIn, lines, asked };
}

describe('starting sign-ins from one address', () => {
  it('keeps at most ten per address, and pushes out only its own', async () => {
    const { logins, begin, finish } = await setup();
    const victim = await begin('10.0.0.1');
    const flood = [];
    for (let n = 0; n < 25; n++) flood.push(await begin('10.0.0.2'));
    expect(MAX_PENDING_PER_ADDRESS).toBe(10);
    expect(logins.stats().pending).toBe(11);
    // What the other address started is still there.
    expect((await finish(victim, 'sub-1', '10.0.0.1')).ok).toBe(true);
    // Of the flood, the latest ten are, and the ones before are gone.
    const first = flood[0] as (typeof flood)[number];
    const last = flood.at(-1) as (typeof flood)[number];
    expect(await finish(first, 'sub-1', '10.0.0.2')).toEqual({ ok: false, reason: 'state' });
    expect((await finish(last, 'sub-1', '10.0.0.2')).ok).toBe(true);
  });

  it('limits how often one address starts a sign-in, before the provider is asked', async () => {
    const { begin, clock, asked } = await setup();
    for (let n = 0; n < START_LIMIT.max; n++) await begin('10.0.0.2');
    const refused = await begin('10.0.0.2').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ThrottledError);
    expect((refused as ThrottledError).retryAfterSeconds).toBeGreaterThan(0);
    expect((refused as ThrottledError).retryAfterSeconds).toBeLessThanOrEqual(
      START_LIMIT.windowMs / 1000,
    );
    expect(asked.authorize).toBe(START_LIMIT.max);
    // Another address is not held back by it, and the first is let in again later.
    await begin('10.0.0.3');
    clock.now += START_LIMIT.windowMs + 1;
    await begin('10.0.0.2');
  });

  it('at the global limit takes from the address that holds the most, not from whoever is oldest', async () => {
    const { logins, begin, finish } = await setup();
    // The oldest entry of all belongs to someone with a single sign-in under way.
    const victim = await begin('10.9.9.9');
    const heavy: { ticket: string; state: string }[] = [];
    for (let address = 0; address < 99; address++) {
      for (let n = 0; n < 10; n++) {
        const flow = await begin(`10.1.0.${address}`);
        if (address === 0 && n === 0) heavy.push(flow);
      }
    }
    for (let n = 0; n < 9; n++) await begin(`10.2.0.${n}`);
    expect(logins.stats().pending).toBe(1000);
    // Someone new comes: the limit holds, and it is a heavy holder that makes room.
    const newcomer = await begin('10.3.0.1');
    expect(logins.stats().pending).toBe(1000);
    expect(
      await finish(heavy[0] as { ticket: string; state: string }, 'sub-1', '10.1.0.0'),
    ).toEqual({ ok: false, reason: 'state' });
    expect((await finish(victim, 'sub-1', '10.9.9.9')).ok).toBe(true);
    expect((await finish(newcomer, 'sub-1', '10.3.0.1')).ok).toBe(true);
  });
});

describe('the throttle of returns', () => {
  it('forgives an address only for a sign-in that opened a session', async () => {
    const { signIn } = await setup();
    const outcomes: string[] = [];
    for (let n = 0; n < 22; n++) {
      const answer = await signIn('stranger', '10.0.0.7');
      outcomes.push(answer.ok ? 'ok' : answer.reason);
    }
    expect(outcomes[0]).toBe('not_linked');
    expect(outcomes.at(-1)).toBe('throttled');
  });

  it('still does not count sign-ins that worked', async () => {
    const { signIn } = await setup();
    for (let n = 0; n < 25; n++)
      expect((await signIn('sub-1', '10.0.0.8')).ok, String(n)).toBe(true);
  });
});

describe('the log', () => {
  it('names who signed in with which account, from where', async () => {
    const { signIn, lines } = await setup();
    await signIn('sub-1', '10.0.0.5');
    const line = lines.find((entry) => entry.includes('signed in'));
    expect(line).toMatch(/^INFO /);
    expect(line).toContain('"ada"');
    expect(line).toContain('"fake"');
    expect(line).toContain('"sub-1"');
    expect(line).toContain('10.0.0.5');
  });

  it('prints what a stranger chose without characters that redraw a line', () => {
    expect(printable(`a${RLO}b${ZWSP}c${BEL}d${LRI}e${BOM}`, 20)).toBe('abc de');
    expect(printable('x'.repeat(50), 10)).toBe('x'.repeat(10));
  });
});

describe('the list of refused accounts', () => {
  it('shows a name without format characters, cut short', async () => {
    const { signIn, logins } = await setup();
    await signIn(`stranger|ad${RLO}a${ZWSP}${LRI}${'x'.repeat(200)}`);
    const [attempt] = logins.unlinked();
    expect(attempt?.subject).toBe('stranger');
    expect(attempt?.name).toMatch(/^adax+$/);
    expect(attempt?.name?.length).toBeLessThanOrEqual(64);
    expect(/\p{Cf}/u.test(attempt?.name ?? '')).toBe(false);
  });

  it('keeps what others tried when one address floods it', async () => {
    const { signIn, logins } = await setup();
    for (let n = 0; n < 3; n++) await signIn(`honest-${n}`, `10.0.5.${n}`);
    for (let n = 0; n < 18; n++) await signIn(`flood-${n}`, '10.0.6.6');
    const subjects = logins.unlinked().map((attempt) => attempt.subject);
    expect(subjects).toEqual(expect.arrayContaining(['honest-0', 'honest-1', 'honest-2']));
    const flood = subjects.filter((subject) => subject.startsWith('flood-'));
    expect(flood).toHaveLength(MAX_UNLINKED_PER_ADDRESS);
    // Of the flood, the latest stay.
    expect(flood[0]).toBe('flood-17');
  });

  it('holds twenty at most, taking from whoever filled most of it', async () => {
    const { signIn, logins } = await setup();
    await signIn('single', '10.0.7.1');
    for (let address = 0; address < 5; address++) {
      for (let n = 0; n < 5; n++) await signIn(`many-${address}-${n}`, `10.0.8.${address}`);
    }
    const subjects = logins.unlinked().map((attempt) => attempt.subject);
    expect(subjects).toHaveLength(20);
    expect(subjects).toContain('single');
  });

  it('says for which realm an account tried', async () => {
    const { signIn, logins } = await setup();
    await signIn('stranger|Zed|https://id.example');
    expect(logins.unlinked()[0]).toMatchObject({
      provider: 'fake',
      subject: 'stranger',
      realm: 'https://id.example',
    });
    expect(logins.unlinkedRealm('fake', 'stranger')).toBe('https://id.example');
    expect(logins.unlinkedRealm('fake', 'nobody')).toBeUndefined();
  });
});

describe('the realm of a link', () => {
  it('binds a link without a realm at the first sign-in, and holds it to that from then on', async () => {
    const { auth, ada, signIn, logins, lines } = await setup();
    expect(auth.listIdentities()).toEqual([{ userId: ada.id, provider: 'fake', subject: 'sub-1' }]);
    expect((await signIn('sub-1||https://old.example')).ok).toBe(true);
    expect(auth.listIdentities()).toEqual([
      { userId: ada.id, provider: 'fake', subject: 'sub-1', realm: 'https://old.example' },
    ]);
    expect((await signIn('sub-1||https://old.example')).ok).toBe(true);

    // The provider id now stands for another issuer: the same subject there is someone else.
    expect(await signIn('sub-1|ada|https://new.example')).toEqual({ ok: false, reason: 'realm' });
    // And a provider that suddenly names no realm is not believed either.
    expect(await signIn('sub-1')).toEqual({ ok: false, reason: 'realm' });
    const line = lines.find((entry) => entry.includes('https://new.example'));
    expect(line).toMatch(/^WARN /);
    expect(line).toContain('https://old.example');
    expect(line).toContain('"sub-1"');
    // It waits in the list, with the realm it came from, for an administrator to decide.
    expect(logins.unlinked()[0]).toMatchObject({ subject: 'sub-1' });
    expect(
      logins.unlinked().find((attempt) => attempt.realm === 'https://new.example'),
    ).toBeUndefined();
    await signIn('sub-1|ada|https://new.example');
    expect(logins.unlinked()[0]).toMatchObject({ subject: 'sub-1', realm: 'https://new.example' });
  });

  it('opens no session and counts against the address when the realm is wrong', async () => {
    const { auth, ada, signIn } = await setup();
    auth.linkIdentity(ada.id, 'fake', 'sub-2', 'https://old.example');
    const outcomes: string[] = [];
    for (let n = 0; n < 22; n++) {
      const answer = await signIn('sub-2||https://new.example', '10.0.0.9');
      outcomes.push(answer.ok ? 'ok' : answer.reason);
    }
    expect(outcomes[0]).toBe('realm');
    expect(outcomes.at(-1)).toBe('throttled');
  });

  it('takes the realm an administrator links with, and replaces it when linked again', async () => {
    const { auth, ada } = await setup();
    auth.linkIdentity(ada.id, 'fake', 'sub-3', 'https://old.example');
    const realmOf = () =>
      auth.listIdentities().find((identity) => identity.subject === 'sub-3')?.realm;
    expect(realmOf()).toBe('https://old.example');
    expect(auth.externalLogin('fake', { subject: 'sub-3', realm: 'https://new.example' })).toEqual({
      ok: false,
      reason: 'realm',
      linkedRealm: 'https://old.example',
    });
    auth.linkIdentity(ada.id, 'fake', 'sub-3', 'https://new.example');
    expect(realmOf()).toBe('https://new.example');
    expect(auth.externalLogin('fake', { subject: 'sub-3', realm: 'https://new.example' }).ok).toBe(
      true,
    );
    // Linked again without one: bound by the next sign-in.
    auth.linkIdentity(ada.id, 'fake', 'sub-3');
    expect(realmOf()).toBeUndefined();
  });

  it('stores the realm with the user that signing up creates', async () => {
    const { auth } = await setup();
    const created = auth.externalLogin(
      'fake',
      { subject: 'new-1', name: 'zed', realm: 'https://id.example' },
      { signup: true },
    );
    expect(created.ok).toBe(true);
    expect(auth.listIdentities().find((identity) => identity.subject === 'new-1')?.realm).toBe(
      'https://id.example',
    );
    expect(
      auth.externalLogin(
        'fake',
        { subject: 'new-1', realm: 'https://other.example' },
        { signup: true },
      ).ok,
    ).toBe(false);
  });

  it('refuses a realm that cannot be one', async () => {
    const { auth, ada } = await setup();
    for (const realm of ['', 'a\u0000b', 'x'.repeat(256)]) {
      expect(() => auth.linkIdentity(ada.id, 'fake', 'sub-4', realm), realm).toThrow(/realm/i);
      expect(() => auth.externalLogin('fake', { subject: 'sub-4', realm }), realm).toThrow(
        /realm/i,
      );
    }
  });

  it('leaves the password of a user alone', async () => {
    const { auth, ada } = await setup();
    auth.linkIdentity(ada.id, 'fake', 'sub-5', 'https://id.example');
    expect((await auth.login('ada', 'correct horse', '10.0.0.1')).ok).toBe(true);
  });
});

describe('a database from before realms were kept', () => {
  it('keeps its links, bound to no realm, when it is brought up to date', async () => {
    const db = await openSqliteDb(':memory:');
    cleanup.push(() => db.close());
    // Version 7: everything but the realm of an identity.
    expect(migrate(db, MIGRATIONS.slice(0, 7))).toBe(7);
    db.run("INSERT INTO users (id, name, created_at) VALUES ('u1', 'ada', 1)");
    db.run("INSERT INTO identities (provider, subject, user_id) VALUES ('oidc', 's1', 'u1')");
    expect(migrate(db, MIGRATIONS)).toBe(8);
    const store = sqlAuthStore(db);
    expect(store.identities.get('oidc', 's1')).toEqual({
      provider: 'oidc',
      subject: 's1',
      userId: 'u1',
      secret: null,
      realm: null,
    });
    // The next sign-in binds it.
    const auth = createAuth({ store, scrypt: CHEAP });
    expect(auth.externalLogin('oidc', { subject: 's1', realm: 'https://id.example' }).ok).toBe(
      true,
    );
    expect(store.identities.get('oidc', 's1')?.realm).toBe('https://id.example');
  });
});

describe('signing up', () => {
  it('creates a bounded number of users per hour, and refuses the rest like unlinked accounts', async () => {
    const { auth, clock, signIn, logins, lines } = await setup(
      { allowSignup: true },
      { max: 2, windowMs: 1000 },
    );
    expect((await signIn('new-1|one')).ok).toBe(true);
    expect((await signIn('new-2|two')).ok).toBe(true);
    expect(await signIn('new-3|three')).toEqual({ ok: false, reason: 'not_linked' });
    expect(auth.listUsers().map((user) => user.name)).toEqual(['ada', 'one', 'two']);
    expect(logins.unlinked()[0]).toMatchObject({ subject: 'new-3', name: 'three' });
    expect(lines.some((line) => /^WARN .*sign.*up.*paused/i.test(line))).toBe(true);
    // Whoever has a user already still signs in.
    expect((await signIn('new-1|one')).ok).toBe(true);
    clock.now += 1001;
    expect((await signIn('new-3|three')).ok).toBe(true);
  });

  it('allows twenty an hour unless told otherwise', async () => {
    const { auth } = await setup();
    expect(SIGNUP_LIMIT).toEqual({ max: 20, windowMs: 60 * 60 * 1000 });
    const signUp = (n: number) =>
      auth.externalLogin('fake', { subject: `s-${n}`, name: `user-${n}` }, { signup: true });
    for (let n = 0; n < 20; n++) expect(signUp(n).ok, String(n)).toBe(true);
    expect(signUp(20)).toEqual({ ok: false, reason: 'not_linked', signupLimited: true });
    expect(auth.listUsers()).toHaveLength(21);
  });
});

describe('the public address', () => {
  it('warns about plain HTTP beyond this machine, and about nothing else', () => {
    expect(publicUrlWarning({ publicUrl: undefined })).toBeUndefined();
    expect(publicUrlWarning({ publicUrl: 'https://show.example' })).toBeUndefined();
    expect(publicUrlWarning({ publicUrl: 'http://localhost:9090' })).toBeUndefined();
    expect(publicUrlWarning({ publicUrl: 'http://127.0.0.1:9090' })).toBeUndefined();
    const warning = publicUrlWarning({ publicUrl: 'http://192.168.1.20:9090' });
    expect(warning).toContain('http://192.168.1.20:9090');
    expect(warning).toMatch(/unencrypted/);
    expect(warning).toMatch(/redirect/);
  });
});
