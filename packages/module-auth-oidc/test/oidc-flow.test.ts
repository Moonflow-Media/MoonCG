import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cookiePair, type HttpAnswer, PASSWORD } from '../../server/test/auth-helpers.js';
import { type ModuleServer, startModuleServer } from '../../server/test/module-helpers.js';
import { temporaryBundles } from '../../server/test/temp-bundles.js';
import { type Account, type MockIdp, startMockIdp } from './mock-idp.js';

/**
 * The module as the server ships it, signing in against an identity provider that runs here
 * for the test: every request between the two is a real one, and every ID token is signed.
 */

const moduleDir = fileURLToPath(new URL('..', import.meta.url));
const temporary = temporaryBundles();
let idp: MockIdp;
let server: ModuleServer | undefined;

beforeEach(async () => {
  idp = await startMockIdp();
});
afterEach(async () => {
  await server?.server.close();
  server = undefined;
  await idp.close();
  await temporary.cleanup();
});

type OidcConfig = Record<string, unknown>;

/** Starts MoonCG with the module enabled and its generic provider pointed at the mock. */
async function start(oidc: OidcConfig = {}, config: object = {}): Promise<ModuleServer> {
  const dataDir = await temporary.create({
    'config/modules/auth-oidc.json': {
      oidc: {
        enabled: true,
        name: 'Mock',
        issuer: idp.issuer,
        clientId: idp.clientId,
        clientSecret: idp.clientSecret,
        ...oidc,
      },
    },
  });
  server = await startModuleServer(
    temporary,
    {},
    ['auth-oidc'],
    { dataDir, ...config },
    // The sources, not the build: tests need none.
    { builtinModules: [{ dir: moduleDir, load: () => import('../src/index.js') }] },
  );
  return server;
}

const cookieOf = (answer: HttpAnswer, name: string) => {
  const found = answer.setCookies.find((cookie) => cookie.startsWith(`${name}=`));
  return found === undefined ? undefined : cookiePair(found);
};

interface Flow {
  readonly location: URL;
  readonly state: string;
  readonly cookie: string | undefined;
}

/** The first half: MoonCG sends the browser to the provider. */
async function begin(mooncg: ModuleServer, query = ''): Promise<Flow> {
  const answer = await mooncg.http('GET', `/auth/oidc/start${query}`);
  expect(answer.status).toBe(302);
  const location = new URL(answer.headers.get('location') as string);
  return {
    location,
    state: location.searchParams.get('state') as string,
    cookie: cookieOf(answer, 'mooncg_oauth'),
  };
}

/** The second half: the browser comes back with the code the provider gave it. */
const comeBack = (mooncg: ModuleServer, flow: Pick<Flow, 'state' | 'cookie'>, code: string) =>
  mooncg.http(
    'GET',
    `/auth/oidc/callback?state=${encodeURIComponent(flow.state)}&code=${encodeURIComponent(code)}`,
    { cookie: flow.cookie },
  );

/** A whole sign-in as `account`. */
async function signIn(mooncg: ModuleServer, account: Account, query = ''): Promise<HttpAnswer> {
  const flow = await begin(mooncg, query);
  return comeBack(mooncg, flow, idp.approve(flow.location, account));
}

/** Where a sign-in that was refused ended: the reason in the address of the login page. */
const refusal = (answer: HttpAnswer) => {
  expect(answer.status).toBe(302);
  const location = new URL(answer.headers.get('location') as string, 'http://x');
  expect(location.pathname).toBe('/login');
  expect(answer.setCookies.some((cookie) => cookie.startsWith('mooncg_session='))).toBe(false);
  return location.searchParams.get('error');
};

const ADA: Account = { sub: 'idp-user-1', preferred_username: 'ada.lovelace' };

async function linked(mooncg: ModuleServer, account = ADA, user = 'ada') {
  const found = mooncg.auth.findUser(user);
  mooncg.auth.linkIdentity(found?.id as string, 'oidc', account.sub);
}

describe('signing in with OpenID Connect', () => {
  it('signs a linked user in', async () => {
    const mooncg = await start();
    await linked(mooncg);
    const answer = await signIn(mooncg, ADA);
    expect(answer.status).toBe(302);
    expect(answer.headers.get('location')).toBe('/');
    const me = await mooncg.http('GET', '/api/v1/me', {
      cookie: cookieOf(answer, 'mooncg_session'),
    });
    expect(me.json.user.name).toBe('ada');
    expect(me.json.roles).toEqual(['admin']);
  });

  it('asks the provider as the specification has it', async () => {
    const mooncg = await start();
    await linked(mooncg);
    const flow = await begin(mooncg);
    const asked = Object.fromEntries(flow.location.searchParams);
    expect(`${flow.location.origin}${flow.location.pathname}`).toBe(`${idp.issuer}/authorize`);
    expect(asked).toMatchObject({
      response_type: 'code',
      client_id: idp.clientId,
      redirect_uri: `http://127.0.0.1:${mooncg.server.port}/auth/oidc/callback`,
      scope: 'openid profile',
      code_challenge_method: 'S256',
    });
    expect(asked.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(asked.nonce).not.toBe(asked.state);
    // The secret never travels through the browser.
    expect(flow.location.href).not.toContain(idp.clientSecret);

    await comeBack(mooncg, flow, idp.approve(flow.location, ADA));
    const [redeemed] = idp.tokenRequests;
    // The mock accepted the code, so the PKCE verifier matched the challenge.
    expect(redeemed?.via).toBe('basic');
    expect(redeemed?.form).toMatchObject({
      grant_type: 'authorization_code',
      redirect_uri: asked.redirect_uri,
    });
    expect(redeemed?.form.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(redeemed?.form.client_secret).toBeUndefined();
  });

  it('sends the secret in the form when that is all the provider takes', async () => {
    idp.tweaks.authMethods = ['client_secret_post'];
    const mooncg = await start();
    await linked(mooncg);
    expect((await signIn(mooncg, ADA)).headers.get('location')).toBe('/');
    expect(idp.tokenRequests[0]?.via).toBe('post');
  });

  it('asks the provider about itself once, not at every sign-in', async () => {
    const mooncg = await start();
    await linked(mooncg);
    await signIn(mooncg, ADA);
    await signIn(mooncg, ADA);
    expect(idp.discoveries).toBe(1);
  });

  it('keeps nothing the provider sent, and tells nobody', async () => {
    const mooncg = await start();
    await linked(mooncg);
    const answer = await signIn(mooncg, ADA);
    expect(idp.issued).toHaveLength(2);
    const told = [answer.text, JSON.stringify([...answer.headers]), mooncg.lines.join('\n')].join();
    for (const secret of [...idp.issued, idp.clientSecret]) expect(told).not.toContain(secret);
    // The link is a provider, a subject and the issuer that vouched for it, and nothing else.
    expect(mooncg.server.storage.auth.identities.get('oidc', ADA.sub)).toEqual({
      provider: 'oidc',
      subject: ADA.sub,
      userId: mooncg.auth.findUser('ada')?.id,
      secret: null,
      realm: idp.issuer,
    });
    const settings = await mooncg.http('GET', '/api/v1/modules/auth-oidc/config', {
      cookie: mooncg.admin,
    });
    expect(settings.text).not.toContain(idp.clientSecret);
    expect(settings.json.secrets).toEqual(['/oidc/clientSecret']);
  });
});

describe('what the state protects', () => {
  it('refuses a wrong state', async () => {
    const mooncg = await start();
    await linked(mooncg);
    const flow = await begin(mooncg);
    const code = idp.approve(flow.location, ADA);
    expect(refusal(await comeBack(mooncg, { ...flow, state: 'not-the-state' }, code))).toBe(
      'state',
    );
    // The code was never redeemed.
    expect(idp.tokenRequests).toEqual([]);
  });

  it('refuses a state that was used', async () => {
    const mooncg = await start();
    await linked(mooncg);
    const flow = await begin(mooncg);
    expect(
      (await comeBack(mooncg, flow, idp.approve(flow.location, ADA))).headers.get('location'),
    ).toBe('/');
    expect(refusal(await comeBack(mooncg, flow, idp.approve(flow.location, ADA)))).toBe('state');
    expect(idp.tokenRequests).toHaveLength(1);
  });

  it('refuses the state of one browser in another', async () => {
    const mooncg = await start();
    await linked(mooncg);
    const victim = await begin(mooncg);
    const attacker = await begin(mooncg);
    // The attacker signed in at the provider and hands the victim's browser their own code
    // and state: the victim's cookie belongs to another sign-in.
    const code = idp.approve(attacker.location, { sub: 'attacker' });
    expect(
      refusal(await comeBack(mooncg, { state: attacker.state, cookie: victim.cookie }, code)),
    ).toBe('state');
  });
});

describe('what the ID token must be', () => {
  const cases: [string, () => void, RegExp][] = [
    [
      'without a nonce',
      () => {
        idp.tweaks.nonce = null;
      },
      /nonce/,
    ],
    [
      'with the nonce of another sign-in',
      () => {
        idp.tweaks.nonce = 'another-nonce';
      },
      /nonce/,
    ],
    [
      'for another audience',
      () => {
        idp.tweaks.aud = 'another-client';
      },
      /"aud"/,
    ],
    [
      'for several audiences and issued to another',
      () => {
        idp.tweaks.aud = ['mooncg-client', 'another-client'];
        idp.tweaks.azp = 'another-client';
      },
      /another client/,
    ],
    [
      'from another issuer',
      () => {
        idp.tweaks.iss = 'https://evil.example';
      },
      /"iss"/,
    ],
    [
      'expired',
      () => {
        idp.tweaks.expiresIn = -3600;
      },
      /"exp"/,
    ],
    [
      'without an expiry',
      () => {
        idp.tweaks.noExpiry = true;
      },
      /"exp"/,
    ],
    [
      'signed by someone else',
      () => {
        idp.tweaks.forgedSignature = true;
      },
      /signature/,
    ],
    [
      'not signed at all',
      () => {
        idp.tweaks.alg = 'none';
      },
      /not valid/,
    ],
    [
      'signed with the client secret',
      () => {
        idp.tweaks.alg = 'HS256';
      },
      /not valid/,
    ],
    [
      'signed with the public key of the provider as an HMAC secret',
      () => {
        idp.tweaks.alg = 'HS256-public-key';
      },
      /not valid/,
    ],
    [
      'missing',
      () => {
        idp.tweaks.noIdToken = true;
      },
      /no ID token/,
    ],
  ];

  for (const [what, tweak, logged] of cases) {
    it(`refuses an ID token ${what}`, async () => {
      const mooncg = await start();
      await linked(mooncg);
      tweak();
      expect(refusal(await signIn(mooncg, ADA))).toBe('provider');
      // The reason is in the log for whoever runs the installation.
      const reasons = mooncg.lines.filter((line) => line.includes('was refused'));
      expect(reasons.join('\n')).toMatch(logged);
      // And with the tweak gone the same account signs in: it was the token, nothing else.
      for (const key of Object.keys(idp.tweaks)) delete idp.tweaks[key as keyof typeof idp.tweaks];
      expect((await signIn(mooncg, ADA)).headers.get('location')).toBe('/');
    });
  }

  it('takes a token whose clock is a few seconds off, and no more', async () => {
    const mooncg = await start();
    await linked(mooncg);
    idp.tweaks.expiresIn = -10;
    expect((await signIn(mooncg, ADA)).headers.get('location')).toBe('/');
    idp.tweaks.expiresIn = -120;
    expect(refusal(await signIn(mooncg, ADA))).toBe('provider');
  });
});

describe('the issuer an account belongs to', () => {
  it('binds a link to the issuer at the first sign-in', async () => {
    const mooncg = await start();
    await linked(mooncg);
    expect(mooncg.auth.listIdentities()[0]?.realm).toBeUndefined();
    expect((await signIn(mooncg, ADA)).headers.get('location')).toBe('/');
    expect(mooncg.auth.listIdentities()).toMatchObject([
      { provider: 'oidc', subject: ADA.sub, realm: idp.issuer },
    ]);
  });

  it('refuses the same subject when the link was made for another issuer', async () => {
    const mooncg = await start();
    const ada = mooncg.auth.findUser('ada');
    // As after the settings were pointed from one provider to another: the link says "the
    // account idp-user-1 of oidc", and was made while "oidc" was the old issuer.
    mooncg.auth.linkIdentity(ada?.id as string, 'oidc', ADA.sub, 'https://old-issuer.example');
    expect(refusal(await signIn(mooncg, ADA))).toBe('realm');
    const reasons = mooncg.lines.filter((line) => line.includes('was refused')).join(' ');
    expect(reasons).toContain('https://old-issuer.example');
    expect(reasons).toContain(idp.issuer);
    // An administrator who means it links the account again, for the issuer it has now.
    const relinked = await mooncg.http('PUT', `/api/v1/users/${ada?.id}/identities/oidc`, {
      cookie: mooncg.admin,
      json: { subject: ADA.sub },
    });
    expect(relinked.status).toBe(204);
    expect(mooncg.auth.listIdentities()[0]?.realm).toBe(idp.issuer);
    expect((await signIn(mooncg, ADA)).headers.get('location')).toBe('/');
  });

  it('stores the issuer with the user that signing up creates', async () => {
    const mooncg = await start({ allowSignup: true });
    await signIn(mooncg, { sub: 'newcomer', preferred_username: 'zed' });
    expect(mooncg.auth.listIdentities()).toMatchObject([
      { subject: 'newcomer', realm: idp.issuer },
    ]);
  });
});

describe('who an account is', () => {
  it('refuses an account nobody linked, whatever it is called', async () => {
    const mooncg = await start();
    // The provider calls the account like the administrator, and says it has her address.
    const answer = await signIn(mooncg, {
      sub: 'stranger',
      preferred_username: 'ada',
      email: 'ada@example.org',
    });
    expect(refusal(answer)).toBe('not_linked');
    expect(mooncg.auth.listUsers().map((user) => user.name)).toEqual(['ada']);
  });

  it('creates a user without any role when signing up is allowed', async () => {
    const mooncg = await start({ allowSignup: true });
    const answer = await signIn(mooncg, { sub: 'newcomer', preferred_username: 'ada' });
    expect(answer.headers.get('location')).toBe('/');
    const me = await mooncg.http('GET', '/api/v1/me', {
      cookie: cookieOf(answer, 'mooncg_session'),
    });
    expect(me.json.user.name).toBe('ada-2');
    expect(me.json.roles).toEqual([]);
    expect(me.json.permissions).toEqual([]);
    // The same account is the same user the next time.
    await signIn(mooncg, { sub: 'newcomer', preferred_username: 'renamed' });
    expect(mooncg.auth.listUsers().map((user) => user.name)).toEqual(['ada', 'ada-2']);
  });

  it('refuses a disabled user', async () => {
    const mooncg = await start();
    const bob = await mooncg.auth.createUser({ name: 'bob', password: PASSWORD });
    mooncg.auth.linkIdentity(bob.id, 'oidc', 'idp-bob');
    mooncg.auth.updateUser(bob.id, { disabled: true });
    expect(refusal(await signIn(mooncg, { sub: 'idp-bob' }))).toBe('disabled');
  });

  it('follows the links an administrator makes and takes away', async () => {
    const mooncg = await start();
    const bob = await mooncg.auth.createUser({
      name: 'bob',
      password: PASSWORD,
      roles: ['viewer'],
    });
    const account = { sub: 'idp-bob', preferred_username: 'someone-else' };
    expect(refusal(await signIn(mooncg, account))).toBe('not_linked');
    // The attempt shows up for the administrator, who links it.
    const listed = await mooncg.http('GET', '/api/v1/identities', { cookie: mooncg.admin });
    expect(listed.json.unlinked).toMatchObject([
      { provider: 'oidc', subject: 'idp-bob', name: 'someone-else' },
    ]);
    const link = await mooncg.http('PUT', `/api/v1/users/${bob.id}/identities/oidc`, {
      cookie: mooncg.admin,
      json: { subject: 'idp-bob' },
    });
    expect(link.status).toBe(204);
    const signedIn = await signIn(mooncg, account);
    const session = cookieOf(signedIn, 'mooncg_session');
    expect((await mooncg.http('GET', '/api/v1/me', { cookie: session })).json.user.name).toBe(
      'bob',
    );

    const unlink = await mooncg.http('DELETE', `/api/v1/users/${bob.id}/identities/oidc/idp-bob`, {
      cookie: mooncg.admin,
      json: {},
    });
    expect(unlink.status).toBe(204);
    expect((await mooncg.http('GET', '/api/v1/me', { cookie: session })).status).toBe(401);
    expect(refusal(await signIn(mooncg, account))).toBe('not_linked');
  });

  it('goes back only to a path of this server', async () => {
    const mooncg = await start();
    await linked(mooncg);
    const landing = async (returnTo: string) =>
      (await signIn(mooncg, ADA, `?returnTo=${encodeURIComponent(returnTo)}`)).headers.get(
        'location',
      );
    expect(await landing('/admin/users')).toBe('/admin/users');
    expect(await landing('https://evil.example/')).toBe('/');
    expect(await landing('//evil.example/')).toBe('/');
    expect(await landing('/\\evil.example')).toBe('/');
  });
});

describe('when the provider does not play along', () => {
  it('refuses when the person said no at the provider', async () => {
    const mooncg = await start();
    const flow = await begin(mooncg);
    const answer = await mooncg.http(
      'GET',
      `/auth/oidc/callback?state=${flow.state}&error=access_denied&error_description=${encodeURIComponent('<script>alert(1)</script>')}`,
      { cookie: flow.cookie },
    );
    expect(refusal(answer)).toBe('provider');
    expect(answer.headers.get('location')).toBe('/login?error=provider');
    expect(idp.tokenRequests).toEqual([]);
  });

  it('refuses when the token endpoint does, as with a wrong client secret', async () => {
    const mooncg = await start({ clientSecret: 'not-the-secret-123' });
    await linked(mooncg);
    expect(refusal(await signIn(mooncg, ADA))).toBe('provider');
    expect(mooncg.lines.join('\n')).toMatch(
      /token endpoint refused the code \(401\): invalid_client/,
    );
    expect(mooncg.lines.join('\n')).not.toContain('not-the-secret-123');
  });

  it('refuses a code the provider does not know', async () => {
    const mooncg = await start();
    await linked(mooncg);
    const flow = await begin(mooncg);
    expect(refusal(await comeBack(mooncg, flow, 'made-up-code'))).toBe('provider');
  });

  it('does not take another issuer for the configured one', async () => {
    idp.tweaks.discoveryIssuer = 'https://evil.example';
    const mooncg = await start();
    const answer = await mooncg.http('GET', '/auth/oidc/start');
    expect(refusal(answer)).toBe('provider');
    expect(mooncg.lines.join('\n')).toMatch(/says its issuer is "https:\/\/evil.example"/);
  });

  it('stays up when the provider is down, and works again when it is back', async () => {
    const mooncg = await start({ issuer: 'http://127.0.0.1:9' });
    expect(refusal(await mooncg.http('GET', '/auth/oidc/start'))).toBe('provider');
    expect((await mooncg.http('GET', '/login')).status).toBe(200);
    expect(await mooncg.login('ada')).toContain('mooncg_session=');
  });
});

describe('the configuration of the module', () => {
  const stateOf = async (mooncg: ModuleServer) => {
    const listed = await mooncg.http('GET', '/api/v1/modules', { cookie: mooncg.admin });
    return (
      listed.json.modules as { name: string; state: string; error?: string; providers: string[] }[]
    ).find((module) => module.name === 'auth-oidc');
  };

  it('is shipped with the server and registers a provider per enabled section', async () => {
    const mooncg = await start();
    expect(await stateOf(mooncg)).toMatchObject({
      state: 'running',
      builtin: true,
      providers: ['oidc'],
      title: 'External logins (OpenID Connect, Twitch, Discord)',
    });
    expect((await mooncg.http('GET', '/login')).text).toContain('Sign in with Mock');
  });

  it('runs without a provider until one is enabled', async () => {
    const mooncg = await start({ enabled: false });
    expect(await stateOf(mooncg)).toMatchObject({ state: 'running', providers: [] });
    expect((await mooncg.http('GET', '/login')).text).not.toContain('class="providers"');
  });

  it('fails, with the reason, for an issuer that is not https', async () => {
    const mooncg = await start({ issuer: 'http://idp.example' });
    const module = await stateOf(mooncg);
    expect(module?.state).toBe('failed');
    expect(module?.error).toMatch(/must be an https:\/\/ address/);
    expect((await mooncg.http('GET', '/auth/oidc/start')).status).toBe(404);
  });

  it('fails for an enabled section without a client ID', async () => {
    const mooncg = await start({ clientId: '' });
    expect((await stateOf(mooncg))?.error).toMatch(/no client ID/);
  });

  it('takes new settings from the settings API and starts again with them', async () => {
    const mooncg = await start({ enabled: false });
    const saved = await mooncg.http('PUT', '/api/v1/modules/auth-oidc/config', {
      cookie: mooncg.admin,
      json: {
        values: {
          oidc: { enabled: true, name: 'Company', issuer: idp.issuer, clientId: idp.clientId },
          twitch: {
            enabled: true,
            clientId: 'twitch-client-id',
            clientSecret: 'twitch-secret-123',
          },
          discord: { enabled: true, clientId: 'discord-client-id' },
        },
      },
    });
    expect(saved.status).toBe(200);
    expect(saved.json.restarted).toBe(true);
    expect(saved.text).not.toContain('twitch-secret-123');
    // The secret of the section that was not sent again is kept.
    expect(saved.json.secrets).toEqual(['/oidc/clientSecret', '/twitch/clientSecret']);
    expect((await stateOf(mooncg))?.providers).toEqual(['oidc', 'twitch', 'discord']);
    const page = (await mooncg.http('GET', '/login')).text;
    for (const name of ['Company', 'Twitch', 'Discord']) {
      expect(page).toContain(`Sign in with ${name}`);
    }
    await linked(mooncg);
    expect((await signIn(mooncg, ADA)).headers.get('location')).toBe('/');
  });

  it('says so when saved settings cannot work', async () => {
    const mooncg = await start();
    const saved = await mooncg.http('PUT', '/api/v1/modules/auth-oidc/config', {
      cookie: mooncg.admin,
      json: { values: { oidc: { enabled: true, issuer: 'ftp://idp.example', clientId: 'x' } } },
    });
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({ restarted: false, module: { state: 'failed' } });
    expect(saved.json.restartNote).toMatch(/https/);
    expect((await mooncg.http('GET', '/login')).text).not.toContain('class="providers"');
  });
});
