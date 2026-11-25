import { MoonCGError } from '@mooncg/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuth } from '../src/auth/auth.js';
import { memoryStorage, type Storage } from '../src/storage/replicant-store.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

const CHEAP = { N: 16, r: 1, p: 1 };
const PASSWORD = 'correct horse';

function setup(devMode = false) {
  const storage: Storage = memoryStorage();
  cleanup.push(() => storage.close());
  const clock = { now: 1_000_000 };
  const auth = createAuth({ store: storage.auth, now: () => clock.now, scrypt: CHEAP, devMode });
  return { auth, clock, store: storage.auth };
}

async function withAdmin(devMode = false) {
  const context = setup(devMode);
  const ada = await context.auth.createUser({ name: 'ada', password: PASSWORD, roles: ['admin'] });
  return { ...context, ada };
}

const code = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    return error instanceof MoonCGError ? error.code : `unexpected: ${String(error)}`;
  }
  return 'no error';
};

describe('signing in with an external account', () => {
  it('refuses an account nobody linked, and creates no user', async () => {
    const { auth } = await withAdmin();
    const result = auth.externalLogin('twitch', { subject: '42', name: 'ada' });
    expect(result).toEqual({ ok: false, reason: 'not_linked' });
    expect(auth.listUsers().map((user) => user.name)).toEqual(['ada']);
  });

  it('never finds a user by the name the provider tells', async () => {
    const { auth, ada } = await withAdmin();
    const result = auth.externalLogin('twitch', { subject: '42', name: 'ada' }, { signup: true });
    if (!result.ok) throw new Error(result.reason);
    // A new user beside the one of that name, and with nothing.
    expect(result.user.id).not.toBe(ada.id);
    expect(result.user.name).toBe('ada-2');
    expect(result.user.roles).toEqual([]);
    expect(result.created).toBe(true);
    expect(auth.identify({ session: result.session }).principal.id).toBe(`user:${result.user.id}`);
  });

  it('signs the same account in as the same user from then on', async () => {
    const { auth } = await withAdmin();
    const first = auth.externalLogin('twitch', { subject: '42', name: 'Zoë!' }, { signup: true });
    const again = auth.externalLogin('twitch', { subject: '42', name: 'renamed' });
    if (!first.ok || !again.ok) throw new Error('refused');
    expect(first.user.name).toBe('Zo');
    expect(again.user.id).toBe(first.user.id);
    expect(again.created).toBe(false);
    expect(auth.listUsers()).toHaveLength(2);
  });

  it('tells the accounts of two providers apart', async () => {
    const { auth } = await withAdmin();
    const twitch = auth.externalLogin('twitch', { subject: '42' }, { signup: true });
    const discord = auth.externalLogin('discord', { subject: '42' }, { signup: true });
    if (!twitch.ok || !discord.ok) throw new Error('refused');
    expect(twitch.user.id).not.toBe(discord.user.id);
    expect(twitch.user.name).toBe('twitch-user');
  });

  it('signs in a linked account as the user it is linked to, with a session like any other', async () => {
    const { auth, ada, clock } = await withAdmin();
    auth.linkIdentity(ada.id, 'twitch', '42');
    const result = auth.externalLogin('twitch', { subject: '42' });
    if (!result.ok) throw new Error(result.reason);
    expect(result.user.id).toBe(ada.id);
    expect(auth.identify({ session: result.session }).via).toBe('session');
    // The same rules end it: a new password ends every session of the user.
    await auth.setPassword(ada.id, 'another password');
    expect(auth.identify({ session: result.session }).principal.kind).toBe('anonymous');
    const later = auth.externalLogin('twitch', { subject: '42' });
    if (!later.ok) throw new Error(later.reason);
    clock.now += 31 * 24 * 60 * 60 * 1000;
    expect(auth.identify({ session: later.session }).principal.kind).toBe('anonymous');
  });

  it('refuses a disabled user, and ends nothing by trying', async () => {
    const { auth } = await withAdmin();
    const bob = await auth.createUser({ name: 'bob', password: PASSWORD });
    auth.linkIdentity(bob.id, 'twitch', '7');
    auth.updateUser(bob.id, { disabled: true });
    expect(auth.externalLogin('twitch', { subject: '7' }, { signup: true })).toEqual({
      ok: false,
      reason: 'disabled',
    });
  });

  it('is no way around the first-run setup: without a user nothing signs in or up', () => {
    const { auth } = setup();
    expect(auth.externalLogin('twitch', { subject: '42' }, { signup: true })).toEqual({
      ok: false,
      reason: 'setup',
    });
    expect(auth.listUsers()).toEqual([]);
    expect(auth.setupCode()).toBeDefined();
  });

  it('does not count the user of dev mode as a user either', () => {
    const { auth } = setup(true);
    auth.ensureDevUser();
    expect(auth.externalLogin('twitch', { subject: '42' }, { signup: true })).toEqual({
      ok: false,
      reason: 'setup',
    });
  });

  it('refuses a subject that is none', async () => {
    const { auth } = await withAdmin();
    for (const subject of ['', 'a\nb', 'x'.repeat(256)]) {
      expect(code(() => auth.externalLogin('twitch', { subject }, { signup: true }))).toBe(
        'bad_request',
      );
    }
    expect(code(() => auth.externalLogin('local', { subject: '1' }))).toBe('bad_request');
    expect(code(() => auth.externalLogin('Twitch', { subject: '1' }))).toBe('bad_request');
  });
});

describe('linking an external account', () => {
  it('lists what is linked, without the passwords', async () => {
    const { auth, ada } = await withAdmin();
    auth.linkIdentity(ada.id, 'twitch', '42');
    auth.linkIdentity(ada.id, 'discord', '99');
    expect(auth.listIdentities()).toEqual([
      { userId: ada.id, provider: 'discord', subject: '99' },
      { userId: ada.id, provider: 'twitch', subject: '42' },
    ]);
  });

  it('never moves an account from one user to another', async () => {
    const { auth, ada } = await withAdmin();
    const bob = await auth.createUser({ name: 'bob', password: PASSWORD });
    auth.linkIdentity(ada.id, 'twitch', '42');
    expect(code(() => auth.linkIdentity(bob.id, 'twitch', '42'))).toBe('conflict');
    // Linking it again to the user who has it changes nothing.
    auth.linkIdentity(ada.id, 'twitch', '42');
    expect(auth.listIdentities()).toHaveLength(1);
  });

  it('cannot link the user of dev mode, the provider "local" or a user who is not there', async () => {
    const { auth, ada } = await withAdmin(true);
    const dev = auth.ensureDevUser();
    expect(code(() => auth.linkIdentity(dev.id, 'twitch', '42'))).toBe('conflict');
    expect(code(() => auth.linkIdentity(ada.id, 'local', ada.id))).toBe('bad_request');
    expect(code(() => auth.linkIdentity('nobody', 'twitch', '42'))).toBe('not_found');
    expect(auth.listIdentities()).toEqual([]);
  });

  it('never signs in as the user of dev mode, whatever the store says', async () => {
    const { auth, store } = await withAdmin(true);
    const dev = auth.ensureDevUser();
    store.identities.put({ provider: 'twitch', subject: '42', userId: dev.id, secret: null });
    expect(auth.externalLogin('twitch', { subject: '42' })).toEqual({
      ok: false,
      reason: 'disabled',
    });
  });

  it('unlinks, which ends the sessions of the user and leaves the password alone', async () => {
    const { auth, ada } = await withAdmin();
    auth.linkIdentity(ada.id, 'twitch', '42');
    const signedIn = auth.externalLogin('twitch', { subject: '42' });
    if (!signedIn.ok) throw new Error(signedIn.reason);
    auth.unlinkIdentity(ada.id, 'twitch', '42');
    expect(auth.identify({ session: signedIn.session }).principal.kind).toBe('anonymous');
    expect(auth.externalLogin('twitch', { subject: '42' })).toEqual({
      ok: false,
      reason: 'not_linked',
    });
    expect((await auth.login('ada', PASSWORD, '10.0.0.1')).ok).toBe(true);
  });

  it('unlinks only what is linked to that user, and never the password', async () => {
    const { auth, ada } = await withAdmin();
    const bob = await auth.createUser({ name: 'bob', password: PASSWORD });
    auth.linkIdentity(ada.id, 'twitch', '42');
    expect(code(() => auth.unlinkIdentity(bob.id, 'twitch', '42'))).toBe('not_found');
    expect(code(() => auth.unlinkIdentity(ada.id, 'local', ada.id))).toBe('bad_request');
    expect((await auth.login('ada', PASSWORD, '10.0.0.1')).ok).toBe(true);
  });

  it('takes the links of a deleted user with it', async () => {
    const { auth } = await withAdmin();
    const bob = await auth.createUser({ name: 'bob', password: PASSWORD });
    auth.linkIdentity(bob.id, 'twitch', '7');
    auth.deleteUser(bob.id);
    expect(auth.listIdentities()).toEqual([]);
    expect(auth.externalLogin('twitch', { subject: '7' })).toEqual({
      ok: false,
      reason: 'not_linked',
    });
  });

  it('tells whoever listens that access changed', async () => {
    const { auth, ada } = await withAdmin();
    let changes = 0;
    auth.onChange(() => changes++);
    auth.linkIdentity(ada.id, 'twitch', '42');
    auth.unlinkIdentity(ada.id, 'twitch', '42');
    expect(changes).toBe(2);
  });
});
