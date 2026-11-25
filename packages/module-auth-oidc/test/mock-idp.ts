import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, exportSPKI, generateKeyPair, type JWK, SignJWT, UnsecuredJWT } from 'jose';

/** How the next ID tokens differ from what they should be. Each test sets what it tests. */
export interface Tweaks {
  /** The `aud` of the token in place of the client id. */
  aud?: string | string[];
  azp?: string;
  /** The `iss` of the token in place of the issuer. */
  iss?: string;
  /** Seconds from now until the token expires; negative for one that has. */
  expiresIn?: number;
  /** Leaves `exp` out. */
  noExpiry?: boolean;
  /** `null` leaves the nonce out; a text puts that one in place of the right one. */
  nonce?: string | null;
  /** Signs with a key the provider does not publish, under the id of the one it does. */
  forgedSignature?: boolean;
  /**
   * `none`: no signature at all. `HS256`: an HMAC with the client secret as its key.
   * `HS256-public-key`: an HMAC with the published public key as its key, which a verifier
   * accepts that takes the algorithm from the token and hands it the key it has.
   */
  alg?: 'none' | 'HS256' | 'HS256-public-key';
  /** The token endpoint refuses every code. */
  refuse?: boolean;
  /** Leaves the ID token out of the answer. */
  noIdToken?: boolean;
  /** `scope` of the answer as a list, the way Twitch sends it. */
  scopeList?: boolean;
  /** What the discovery document says the issuer is. */
  discoveryIssuer?: string;
  /** The client authentication the discovery document says it supports. */
  authMethods?: string[];
  /** What `/users/@me` answers, or the status it refuses with. */
  user?: Record<string, unknown> | number;
}

export interface Account {
  sub: string;
  preferred_username?: string;
  email?: string;
}

export interface MockIdp {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly tweaks: Tweaks;
  /** What arrived at the token endpoint, and how the client proved who it is. */
  readonly tokenRequests: { form: Record<string, string>; via: 'basic' | 'post' | 'none' }[];
  /** Every ID token and access token that was handed out. */
  readonly issued: string[];
  /** How often the discovery document was fetched. */
  discoveries: number;
  /**
   * Who a browser that opens the authorization endpoint is signed in as: it is sent straight
   * back with a code for that account. Without it the endpoint answers 404.
   */
  browserAccount: Account | undefined;
  /**
   * Stands in for the person at the provider: takes the address the browser was sent to,
   * checks it as a provider would, signs in as `account` and returns the code that the
   * provider would send the browser back with.
   */
  approve(authorization: URL, account: Account): string;
  close(): Promise<void>;
}

interface Grant {
  readonly account: Account;
  readonly challenge: string;
  readonly nonce: string | null;
  readonly redirectUri: string;
}

const readBody = (request: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => resolve(body));
  });

/**
 * A small identity provider on this machine: discovery, keys, a token endpoint that checks
 * the client, the code, the redirect address and the PKCE verifier, and a user endpoint for
 * providers without an ID token. It signs ID tokens with a key it generated.
 */
export async function startMockIdp(): Promise<MockIdp> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const stranger = await generateKeyPair('RS256');
  const kid = 'mock-key-1';
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  const clientId = 'mooncg-client';
  const clientSecret = 'idp-client-secret-42';
  const grants = new Map<string, Grant>();
  const accessTokens = new Map<string, Account>();
  const idp: Omit<MockIdp, 'issuer' | 'close' | 'approve'> = {
    clientId,
    clientSecret,
    tweaks: {},
    tokenRequests: [],
    issued: [],
    discoveries: 0,
    browserAccount: undefined,
  };
  let approve: MockIdp['approve'] = () => {
    throw new Error('The mock provider has not started');
  };
  let issuer = '';

  const json = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };

  const idToken = async ({ account, nonce }: Grant): Promise<string> => {
    const { tweaks } = idp;
    const claims: Record<string, unknown> = { ...account };
    if (tweaks.nonce !== null) claims.nonce = tweaks.nonce ?? nonce ?? undefined;
    if (tweaks.azp !== undefined) claims.azp = tweaks.azp;
    const now = Math.floor(Date.now() / 1000);
    const build = <T extends SignJWT | UnsecuredJWT>(token: T): T => {
      token
        .setIssuer(tweaks.iss ?? issuer)
        .setAudience(tweaks.aud ?? clientId)
        .setIssuedAt(now);
      if (!tweaks.noExpiry) token.setExpirationTime(now + (tweaks.expiresIn ?? 300));
      return token;
    };
    if (tweaks.alg === 'none') return build(new UnsecuredJWT(claims)).encode();
    if (tweaks.alg === 'HS256' || tweaks.alg === 'HS256-public-key') {
      const key = tweaks.alg === 'HS256' ? clientSecret : await exportSPKI(publicKey);
      return build(new SignJWT(claims))
        .setProtectedHeader({ alg: 'HS256', kid })
        .sign(new TextEncoder().encode(key));
    }
    return build(new SignJWT(claims))
      .setProtectedHeader({ alg: 'RS256', kid })
      .sign(tweaks.forgedSignature ? stranger.privateKey : privateKey);
  };

  const token = async (request: IncomingMessage, response: ServerResponse) => {
    const form = Object.fromEntries(new URLSearchParams(await readBody(request)));
    const basic = /^Basic (.+)$/.exec(request.headers.authorization ?? '')?.[1];
    const [user, password] =
      basic === undefined
        ? [form.client_id, form.client_secret]
        : Buffer.from(basic, 'base64').toString().split(':').map(decodeURIComponent);
    const via = basic !== undefined ? 'basic' : form.client_secret !== undefined ? 'post' : 'none';
    idp.tokenRequests.push({ form, via });
    if (user !== clientId || password !== clientSecret) {
      return json(response, 401, { error: 'invalid_client' });
    }
    const grant = grants.get(form.code ?? '');
    // A code works once, like a real one.
    grants.delete(form.code ?? '');
    const verified =
      grant !== undefined &&
      createHash('sha256')
        .update(form.code_verifier ?? '')
        .digest('base64url') === grant.challenge;
    if (
      idp.tweaks.refuse ||
      !grant ||
      !verified ||
      form.grant_type !== 'authorization_code' ||
      form.redirect_uri !== grant.redirectUri
    ) {
      return json(response, 400, { error: 'invalid_grant', error_description: 'No such code' });
    }
    const accessToken = `at-${randomBytes(12).toString('hex')}`;
    accessTokens.set(accessToken, grant.account);
    const signed = await idToken(grant);
    idp.issued.push(signed, accessToken);
    return json(response, 200, {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: 300,
      scope: idp.tweaks.scopeList ? ['openid'] : 'openid',
      ...(idp.tweaks.noIdToken ? {} : { id_token: signed }),
    });
  };

  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url ?? '/', issuer);
    if (pathname === '/.well-known/openid-configuration') {
      idp.discoveries++;
      return json(response, 200, {
        issuer: idp.tweaks.discoveryIssuer ?? issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/keys`,
        token_endpoint_auth_methods_supported: idp.tweaks.authMethods ?? ['client_secret_basic'],
      });
    }
    if (pathname === '/keys') return json(response, 200, { keys: [jwk] });
    if (pathname === '/authorize' && idp.browserAccount) {
      // A real provider would ask the person to sign in and to agree. This one has decided.
      const asked = new URL(request.url ?? '/', issuer);
      const back = new URL(asked.searchParams.get('redirect_uri') ?? issuer);
      back.searchParams.set('code', approve(asked, idp.browserAccount));
      back.searchParams.set('state', asked.searchParams.get('state') ?? '');
      response.writeHead(302, { location: back.href });
      return response.end();
    }
    if (pathname === '/token' && request.method === 'POST') return void token(request, response);
    if (pathname === '/users/@me') {
      const { user } = idp.tweaks;
      const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];
      const account = accessTokens.get(bearer ?? '');
      if (typeof user === 'number') return json(response, user, { message: 'No' });
      if (!account) return json(response, 401, { message: '401: Unauthorized' });
      return json(response, 200, user ?? { id: account.sub, username: account.preferred_username });
    }
    return json(response, 404, { error: 'not_found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  approve = (authorization: URL, account: Account) => {
    const asked = authorization.searchParams;
    const wrong = (what: string) => new Error(`The mock provider refuses: ${what}`);
    if (`${authorization.origin}${authorization.pathname}` !== `${issuer}/authorize`) {
      throw wrong(`this is not its authorization endpoint: ${authorization.href}`);
    }
    if (asked.get('client_id') !== clientId) throw wrong('client_id');
    if (asked.get('response_type') !== 'code') throw wrong('response_type');
    if (asked.get('code_challenge_method') !== 'S256') throw wrong('code_challenge_method');
    if (!/^[A-Za-z0-9_-]{43}$/.test(asked.get('code_challenge') ?? '')) {
      throw wrong('code_challenge');
    }
    if (!asked.get('state')) throw wrong('state');
    if (!asked.get('redirect_uri')) throw wrong('redirect_uri');
    const code = `code-${randomBytes(12).toString('hex')}`;
    grants.set(code, {
      account,
      challenge: asked.get('code_challenge') as string,
      nonce: asked.get('nonce'),
      redirectUri: asked.get('redirect_uri') as string,
    });
    return code;
  };
  return Object.assign(idp, {
    issuer,
    approve,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
}
