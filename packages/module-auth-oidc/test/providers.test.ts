import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { providerUrl, requestJson } from '../src/http.js';
import { createOAuth2Provider } from '../src/oauth2.js';
import { createOidcProvider } from '../src/oidc.js';
import { discord, ICON, twitch } from '../src/presets.js';
import { type Account, type MockIdp, startMockIdp } from './mock-idp.js';

let idp: MockIdp;
beforeEach(async () => {
  idp = await startMockIdp();
});
afterEach(() => idp.close());

const REDIRECT = 'http://127.0.0.1:9090/auth/x/callback';
const VERIFIER = 'v'.repeat(43);
const request = {
  state: 's'.repeat(43),
  nonce: 'n'.repeat(43),
  codeChallenge: createHash('sha256').update(VERIFIER).digest('base64url'),
  redirectUri: REDIRECT,
};
const back = (code: string) => ({
  query: { code },
  redirectUri: REDIRECT,
  nonce: request.nonce,
  codeVerifier: VERIFIER,
});

describe('the addresses of a provider', () => {
  it('are https, or plain http to this machine', () => {
    expect(providerUrl('https://id.example/oauth2', 'It').href).toBe('https://id.example/oauth2');
    expect(providerUrl('http://127.0.0.1:8080/x', 'It').port).toBe('8080');
    expect(providerUrl('http://localhost/x', 'It').hostname).toBe('localhost');
    expect(providerUrl('http://[::1]:1/x', 'It').hostname).toBe('[::1]');
  });

  it('are nothing else', () => {
    for (const address of [
      'http://id.example',
      'http://127.0.0.1.evil.example',
      'http://localhost.evil.example',
      'ftp://id.example',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'id.example',
      '',
      undefined,
      5,
      'https://user:secret@id.example',
    ]) {
      expect(() => providerUrl(address, 'The issuer'), String(address)).toThrow(/The issuer/);
    }
  });

  it('do not show a password in the complaint about it', () => {
    expect(() => providerUrl('http://user:hunter2@id.example', 'It')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('hunter2') }),
    );
  });
});

describe('the answer of a provider', () => {
  const CHUNK = 64 * 1024;
  /** An answer of `total` bytes without a stated length, and what was read of it. */
  const endless = (total: number) => {
    const read = { bytes: 0, cancelled: false };
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (read.bytes >= total) return controller.close();
        read.bytes += CHUNK;
        controller.enqueue(new Uint8Array(CHUNK).fill(0x20));
      },
      cancel() {
        read.cancelled = true;
      },
    });
    return { read, send: (async () => new Response(body, { status: 200 })) as typeof fetch };
  };
  const ask = (send: typeof fetch) =>
    requestJson(send, new URL('https://id.example/x'), { method: 'GET' }, 'The provider');

  it('is read up to 1 MiB and no further, however much is sent', async () => {
    const { read, send } = endless(64 * 1024 * 1024);
    await expect(ask(send)).rejects.toThrow(/too much/);
    // It stopped reading where the limit was passed, and told the other end so.
    expect(read.bytes).toBeLessThanOrEqual(1024 * 1024 + 4 * CHUNK);
    expect(read.cancelled).toBe(true);
  });

  it('is refused by its stated length before any of it is read', async () => {
    const send = (async () =>
      new Response('{}', {
        headers: { 'content-length': String(2 * 1024 * 1024) },
      })) as typeof fetch;
    await expect(ask(send)).rejects.toThrow(/too much/);
  });

  it('is taken whole when it is small, in however many pieces', async () => {
    // "Zo" and an e with a diaeresis, whose two bytes arrive apart.
    const bytes = new TextEncoder().encode(
      JSON.stringify({ name: `Zo${String.fromCodePoint(0xeb)}` }),
    );
    const cut = bytes.indexOf(0xc3) + 1;
    const parts = [bytes.slice(0, 3), bytes.slice(3, cut), bytes.slice(cut)];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const part = parts.shift();
        if (part) controller.enqueue(part);
        else controller.close();
      },
    });
    const send = (async () => new Response(body, { status: 201 })) as typeof fetch;
    const answer = await ask(send);
    expect(answer.status).toBe(201);
    expect((answer.json as { name: string }).name).toHaveLength(3);
    expect((answer.json as { name: string }).name.codePointAt(2)).toBe(0xeb);
    const empty = (async () => new Response(null, { status: 204 })) as typeof fetch;
    expect(await ask(empty)).toEqual({ status: 204, json: undefined });
  });
});

describe('the Twitch preset', () => {
  it('is OpenID Connect with the endpoints Twitch documents', () => {
    const settings = twitch({ clientId: 'id', clientSecret: 'secret' });
    expect(settings).toMatchObject({
      id: 'twitch',
      name: 'Twitch',
      issuer: 'https://id.twitch.tv/oauth2',
      scopes: ['openid'],
      clientAuth: 'post',
      // A name is in the ID token only when it is asked for.
      claims: { id_token: { preferred_username: null } },
    });
    // No e-mail address is asked for: nothing would be done with it.
    expect(JSON.stringify(settings)).not.toContain('email');
  });

  it('works against a provider that behaves as Twitch does', async () => {
    // Twitch takes the secret in the form and sends `scope` as a list.
    idp.tweaks.authMethods = ['client_secret_post'];
    idp.tweaks.scopeList = true;
    const provider = createOidcProvider({
      ...twitch({ clientId: idp.clientId, clientSecret: idp.clientSecret }),
      issuer: idp.issuer,
    });
    const url = new URL(await provider.authorize(request));
    expect(url.searchParams.get('scope')).toBe('openid');
    expect(JSON.parse(url.searchParams.get('claims') as string)).toEqual({
      id_token: { preferred_username: null },
    });
    const account: Account = { sub: '141981764', preferred_username: 'twitchdev' };
    expect(await provider.callback(back(idp.approve(url, account)))).toEqual({
      subject: '141981764',
      name: 'twitchdev',
      // Who vouches for the account: the issuer whose keys signed the token.
      realm: idp.issuer,
    });
    expect(idp.tokenRequests[0]?.via).toBe('post');
  });
});

describe('a provider that cannot be reached', () => {
  it('is not asked again for a few seconds, and then is', async () => {
    const clock = { now: 1_000_000 };
    let asked = 0;
    let down = true;
    const provider = createOidcProvider(
      { id: 'oidc', name: 'Mock', issuer: idp.issuer, clientId: idp.clientId },
      {
        now: () => clock.now,
        fetch: (input, init) => {
          asked++;
          return down ? Promise.reject(new Error('connect ECONNREFUSED')) : fetch(input, init);
        },
      },
    );
    await expect(provider.authorize(request)).rejects.toThrow(/could not be reached/);
    await expect(provider.authorize(request)).rejects.toThrow(/could not be reached/);
    expect(asked).toBe(1);
    down = false;
    clock.now += 6000;
    expect(await provider.authorize(request)).toContain(`${idp.issuer}/authorize`);
    expect(asked).toBe(2);
  });
});

describe('the Discord preset', () => {
  it('is OAuth 2.0 with the endpoints Discord documents, and asks for the identity only', () => {
    expect(discord({ clientId: 'id', clientSecret: 'secret' })).toMatchObject({
      id: 'discord',
      name: 'Discord',
      authorizationEndpoint: 'https://discord.com/oauth2/authorize',
      tokenEndpoint: 'https://discord.com/api/oauth2/token',
      userEndpoint: 'https://discord.com/api/users/@me',
      scopes: ['identify'],
      subjectField: 'id',
      nameField: 'username',
    });
  });

  const like = (extra: object = {}) =>
    createOAuth2Provider({
      ...discord({ clientId: idp.clientId, clientSecret: idp.clientSecret }),
      authorizationEndpoint: `${idp.issuer}/authorize`,
      tokenEndpoint: `${idp.issuer}/token`,
      userEndpoint: `${idp.issuer}/users/@me`,
      ...extra,
    });

  it('asks the provider who signed in, with the token the code was redeemed for', async () => {
    const provider = like();
    const url = new URL(await provider.authorize(request));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: idp.clientId,
      redirect_uri: REDIRECT,
      scope: 'identify',
      state: request.state,
      code_challenge: request.codeChallenge,
      code_challenge_method: 'S256',
    });
    const account = { sub: '80351110224678912', preferred_username: 'nelly' };
    expect(await provider.callback(back(idp.approve(url, account)))).toEqual({
      subject: '80351110224678912',
      name: 'nelly',
      // Discord is one service: its accounts are Discord's, wherever the preset is pointed.
      realm: 'https://discord.com',
    });
    expect(idp.tokenRequests[0]).toMatchObject({
      via: 'post',
      form: { code_verifier: VERIFIER, redirect_uri: REDIRECT },
    });
  });

  it('takes the id for the subject, never the name', async () => {
    const provider = like();
    const url = new URL(await provider.authorize(request));
    idp.tweaks.user = { id: 42, username: 'nelly', email: 'nelly@example.org' };
    expect(await provider.callback(back(idp.approve(url, { sub: 'x' })))).toEqual({
      subject: '42',
      name: 'nelly',
      realm: 'https://discord.com',
    });
  });

  it('names the origin of the user endpoint as the realm of a provider that sets none', async () => {
    const provider = like({ realm: undefined });
    const url = new URL(await provider.authorize(request));
    const account = await provider.callback(back(idp.approve(url, { sub: 'x' })));
    expect(account.realm).toBe(idp.issuer);
  });

  it('refuses an answer without a usable id', async () => {
    const provider = like();
    for (const user of [{ username: 'nelly' }, { id: '' }, { id: null }, { id: { a: 1 } }, 401]) {
      idp.tweaks.user = user as Record<string, unknown> | number;
      const url = new URL(await provider.authorize(request));
      await expect(provider.callback(back(idp.approve(url, { sub: 'x' })))).rejects.toThrow(
        /user endpoint/,
      );
    }
  });

  it('refuses a code the provider does not know, and an error in place of one', async () => {
    const provider = like();
    await expect(provider.callback(back('made-up'))).rejects.toThrow(/token endpoint refused/);
    await expect(
      provider.callback({ ...back(''), query: { error: 'access_denied\u001b[2J' } }),
    ).rejects.toThrow(/the error "access_denied \[2J"/);
    await expect(provider.callback({ ...back(''), query: {} })).rejects.toThrow(/no code/);
  });

  it('refuses a wrong verifier, which the provider checks', async () => {
    const provider = like();
    const url = new URL(await provider.authorize(request));
    const code = idp.approve(url, { sub: 'x' });
    await expect(
      provider.callback({ ...back(code), codeVerifier: 'w'.repeat(43) }),
    ).rejects.toThrow(/token endpoint refused/);
  });

  it('is not created with an endpoint that is not https', () => {
    expect(() => like({ tokenEndpoint: 'http://discord.example/token' })).toThrow(/https/);
    expect(() => like({ clientId: '' })).toThrow(/client ID/);
  });
});

describe('what the module ships', () => {
  const file = (name: string) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

  it('has a manifest of a module that names its configuration', async () => {
    const { parseManifest } = await import('@mooncg/core');
    const parsed = parseManifest(JSON.parse(await file('mooncg.json')));
    expect(parsed.ok && parsed.manifest).toMatchObject({
      kind: 'module',
      name: 'auth-oidc',
      main: 'dist/index.js',
      config: { schema: 'config.schema.json' },
    });
  });

  it('keeps every client secret out of what is shown, and signing up off', async () => {
    const schema = JSON.parse(await file('config.schema.json'));
    for (const section of ['oidc', 'twitch', 'discord']) {
      const { properties } = schema.properties[section];
      expect(properties.clientSecret['x-secret'], section).toBe(true);
      expect(properties.allowSignup.default, section).toBe(false);
      expect(properties.enabled.default, section).toBe(false);
    }
  });

  it('ships the icon its providers name, and no logo of a provider', async () => {
    expect(await file(ICON)).toContain('<svg');
  });
});
