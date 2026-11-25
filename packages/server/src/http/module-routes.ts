import { createReadStream } from 'node:fs';
import { extname } from 'node:path';
import {
  BUNDLE_NAME_PATTERN,
  ERROR_CODES,
  type ErrorCode,
  HTTP_METHODS,
  type HttpMethod,
  isLoopbackAddress,
  isLoopbackAuthority,
  MODULES_MANAGE,
  MoonCGError,
  normalizeRoutePath,
  SETTINGS_MANAGE,
  USERS_MANAGE,
} from '@mooncg/core';
import type { ModuleResponse } from '@mooncg/sdk/module';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isExternalProviderId, SESSION_MAX_MS, ThrottledError } from '../auth/auth.js';
import { hashSecret, redactSecrets } from '../auth/secrets.js';
import type { BundleConfigs } from '../config/bundle-config.js';
import { errorMessage, type Logger, printable } from '../kernel/logger.js';
import { type ExternalLogins, FLOW_TTL_MS, safeReturnTo } from '../modules/external-login.js';
import type { ModuleManager } from '../modules/manager.js';
import type { SelfLinking } from '../modules/self-linking.js';
import type { HttpContext } from './app.js';
import { AUTH_BODY_LIMIT, jsonBody } from './auth-routes.js';
import { cookieName, SESSION_COOKIE, sessionCookie, TOKEN_PARAMETER } from './identity.js';
import {
  ASSET_CSP,
  CONNECTION_HEADERS,
  CREDENTIAL_HEADERS,
  canonicalFile,
  flatten,
} from './shared.js';

/**
 * The cookie that ties a started external sign-in to the browser that started it. It holds a
 * ticket, not the `state`: whoever sees the address the provider sends the browser back to
 * has seen the state and still cannot finish the sign-in elsewhere.
 */
export const OAUTH_COOKIE = 'mooncg_oauth';

/** What the routes for modules and external logins need of the server. */
export interface ModuleHttp {
  readonly modules: Pick<
    ModuleManager,
    | 'list'
    | 'get'
    | 'enable'
    | 'disable'
    | 'restart'
    | 'permissions'
    | 'match'
    | 'methods'
    | 'configurable'
    | 'pages'
  >;
  readonly externalLogins: ExternalLogins;
  /** The configuration of the modules. */
  readonly configs: Pick<BundleConfigs, 'describe' | 'write' | 'scrub'>;
  /** The origin the server is reached at, if it was configured. */
  readonly publicUrl?: string | undefined;
  readonly logger?: Logger | undefined;
  /** Whether users may link external accounts to themselves. Without it, they may not. */
  readonly selfLinking?: SelfLinking | undefined;
}

/**
 * How recent the session of a user without a password must be to link an account: the
 * fresh sign-in that stands in for the password others type.
 */
export const SELF_LINK_FRESH_MS = 5 * 60 * 1000;

const ICON_TYPES: Readonly<Record<string, string>> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/** The value of a cookie; `undefined` when it is missing or there twice. */
function cookieValue(header: string | undefined, name: string): string | undefined {
  const found: string[] = [];
  for (const part of header?.split(';') ?? []) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) found.push(part.slice(at + 1).trim());
  }
  return found.length === 1 ? found[0] : undefined;
}

/**
 * The typed error a handler of a module threw, if it threw one. A module with packages of its
 * own has its own copy of the SDK and so its own class `MoonCGError`: its errors are known by
 * their name and their code, not by the class.
 */
function typedError(error: unknown): MoonCGError | undefined {
  if (error instanceof MoonCGError) return error;
  const { name, code, message } = (error ?? {}) as Record<string, unknown>;
  const known = (ERROR_CODES as readonly unknown[]).includes(code);
  return name === 'MoonCGError' && known && typeof message === 'string'
    ? new MoonCGError(code as ErrorCode, message)
    : undefined;
}

/**
 * The routes of modules (`/m/<module>/…`), of external logins (`/auth/<provider>/…`) and
 * the API for managing modules and the links of users to external accounts. Every handler
 * that changes something has already passed the origin and forgery checks.
 */
export function registerModuleRoutes(
  app: FastifyInstance,
  context: HttpContext,
  http: ModuleHttp,
): void {
  const { auth, identityOf, can, deny, fail, failWith, secure, providers } = context;
  const { modules, externalLogins, configs } = http;
  const notFound = (reply: FastifyReply) => fail(reply, 404, 'not_found', 'Not found');
  const anonymous = (request: FastifyRequest) => identityOf(request).principal.kind === 'anonymous';
  const unauthenticated = (reply: FastifyReply) =>
    fail(reply, 401, 'forbidden', 'Authentication required');
  const small = { bodyLimit: AUTH_BODY_LIMIT };

  // --- Signing in with an external account.

  /**
   * The origin the provider sends the browser back to. It is the configured public address,
   * or, without one, this machine by a loopback name and the port the server listens on. It
   * is never taken from what a request merely says: whoever could choose it could have the
   * code of a sign-in delivered to a site of their own. `undefined` when the request did not
   * come to that origin; its cookie would then be set for another name and never come back.
   */
  const ownOrigin = (request: FastifyRequest): string | undefined => {
    const host = request.headers.host?.toLowerCase();
    if (http.publicUrl !== undefined) {
      return host === new URL(http.publicUrl).host ? http.publicUrl : undefined;
    }
    const { socket } = request.raw;
    if (!isLoopbackAuthority(host) || !isLoopbackAddress(socket.remoteAddress)) return undefined;
    const port = /:(\d+)$/.exec(host ?? '')?.[1] ?? '80';
    return Number(port) === socket.localPort ? `http://${host}` : undefined;
  };
  const oauthCookie = (request: FastifyRequest, value: string, maxAge: number) =>
    sessionCookie(OAUTH_COOKIE, value, { secure: secure(request), maxAge });
  const toLogin = (reply: FastifyReply, error: string) =>
    reply.header('cache-control', 'no-store').redirect(`/login?error=${error}`, 302);
  type WithProvider = FastifyRequest<{
    Params: { provider: string };
    Querystring: Record<string, unknown>;
  }>;

  app.get('/api/v1/auth/providers', async () => ({ providers: providers.describe() }));

  app.get('/auth/:provider/start', async (request: WithProvider, reply) => {
    const { provider } = request.params;
    if (!providers.get(provider)) return notFound(reply);
    const origin = ownOrigin(request);
    if (origin === undefined) return toLogin(reply, 'address');
    try {
      const { url, ticket } = await externalLogins.begin(provider, {
        redirectUri: `${origin}/auth/${provider}/callback`,
        returnTo: safeReturnTo(request.query.returnTo),
        address: context.remoteAddress(request),
      });
      return reply
        .header('cache-control', 'no-store')
        .header('set-cookie', oauthCookie(request, ticket, Math.floor(FLOW_TTL_MS / 1000)))
        .redirect(url, 302);
    } catch (error) {
      if (error instanceof ThrottledError) {
        reply
          .header('cache-control', 'no-store')
          .header('retry-after', String(error.retryAfterSeconds));
        return fail(reply, 429, 'unavailable', 'Too many sign-ins were started. Try again later.');
      }
      if (error instanceof MoonCGError && error.code === 'not_found') return notFound(reply);
      return toLogin(reply, 'provider');
    }
  });

  // The one request that changes something without the proof every other one needs: it
  // opens a session, and it is a GET without a JSON body or the forgery header, because it is
  // the provider that sends the browser here. What stands in for that proof is `state`: it
  // must be the one this server handed out, to this browser, which shows that by the ticket
  // in its cookie. The cookie is `SameSite=Lax` and not `Strict` for this request: it is a
  // navigation that another site started, and the browser must still send it. A page of
  // another site can send a browser here, but it knows no state that fits the ticket of that
  // browser, and one it started itself fits only its own.
  app.get('/auth/:provider/callback', async (request: WithProvider, reply) => {
    const { provider } = request.params;
    if (!providers.get(provider)) return notFound(reply);
    const name = cookieName(OAUTH_COOKIE, secure(request));
    const result = await externalLogins.complete(provider, {
      ticket: cookieValue(request.headers.cookie, name),
      query: flatten(request.query),
      address: context.remoteAddress(request),
      // For a link: only the session that started it may finish it.
      session: cookieValue(request.headers.cookie, cookieName(SESSION_COOKIE, secure(request))),
    });
    // The address of this request carried a code. Nobody is told where the browser was.
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
    if (!result.ok && result.reason === 'throttled') {
      reply.header('retry-after', String(result.retryAfterSeconds));
      return fail(reply, 429, 'unavailable', 'Too many failed attempts. Try again later.');
    }
    const used = oauthCookie(request, '', 0);
    if (!result.ok) {
      const page = 'link' in result ? '/account' : '/login';
      return reply.header('set-cookie', used).redirect(`${page}?error=${result.reason}`, 302);
    }
    // A link was made: the browser goes back to where it was, signed in as before.
    if ('linked' in result) return reply.header('set-cookie', used).redirect(result.returnTo, 302);
    // The same cookie, with the same flags and the same lifetime, as a password gets.
    const session = sessionCookie(SESSION_COOKIE, result.session, {
      secure: secure(request),
      maxAge: Math.floor(SESSION_MAX_MS / 1000),
    });
    return reply.header('set-cookie', [session, used]).redirect(result.returnTo, 302);
  });

  app.get('/auth/:provider/icon', async (request: WithProvider, reply) => {
    const registered = providers.get(request.params.provider);
    const icon = registered?.provider.icon;
    const type = icon === undefined ? undefined : ICON_TYPES[extname(icon).toLowerCase()];
    const path =
      registered === undefined || icon === undefined || type === undefined
        ? undefined
        : await canonicalFile(registered.dir, icon);
    if (path === undefined || type === undefined) return notFound(reply);
    // An image for a page, and nothing a browser would run when it is opened by itself.
    return reply
      .type(type)
      .header('cache-control', 'no-cache')
      .header('content-security-policy', ASSET_CSP)
      .send(createReadStream(path));
  });

  // --- Links of users to external accounts. Linking an account to a user lets whoever has
  // that account act as the user, so it falls under the rule for everything about users:
  // nobody does it to a user who holds more than they do.
  type WithIdentity = FastifyRequest<{
    Params: { id: string; provider: string; subject?: string };
  }>;
  const manageUsers = (request: FastifyRequest, reply: FastifyReply) =>
    can(request, USERS_MANAGE) ? undefined : deny(request, reply, USERS_MANAGE);
  /** An account and a user as a log line names them. */
  const account = (provider: string, subject: string) =>
    `of "${provider}" (subject ${JSON.stringify(printable(subject))})`;
  const userName = (id: string) => {
    const user = auth.listUsers().find((candidate) => candidate.id === id);
    return user ? `the user "${user.name}"` : `the user ${JSON.stringify(printable(id, 64))}`;
  };

  app.get('/api/v1/identities', async (request, reply) => {
    const denied = manageUsers(request, reply);
    if (denied) return denied;
    return {
      identities: auth.listIdentities(),
      providers: providers.external().map(({ provider: { id, name } }) => ({ id, name })),
      unlinked: externalLogins.unlinked(),
    };
  });

  app.put('/api/v1/users/:id/identities/:provider', small, async (request: WithIdentity, reply) => {
    const denied = manageUsers(request, reply);
    if (denied) return denied;
    const { id, provider } = request.params;
    try {
      const { subject, realm: given } = jsonBody(request);
      if (!isExternalProviderId(provider)) {
        throw new MoonCGError('bad_request', `"${provider}" is no external provider`);
      }
      // A link to a provider nobody registered could never be used: most likely a slip.
      if (!providers.get(provider)) {
        throw new MoonCGError('not_found', `There is no provider "${provider}"`);
      }
      if (typeof subject !== 'string') {
        throw new MoonCGError('bad_request', '"subject" must be a string');
      }
      if (given !== undefined && typeof given !== 'string') {
        throw new MoonCGError('bad_request', '"realm" must be a string');
      }
      auth.authorizeChange(identityOf(request).principal, { users: [id] });
      // The link is made for the realm the request names, or else for the one the account
      // reported when it was refused: that attempt is what the administrator is looking at.
      // Without either it is bound by the first sign-in.
      const realm = given ?? externalLogins.unlinkedRealm(provider, subject);
      auth.linkIdentity(id, provider, subject, realm);
      externalLogins.forgetUnlinked(provider, subject);
      http.logger?.info(
        `${actor(request)} linked the account ${account(provider, subject)} to ${userName(id)}` +
          (realm === undefined
            ? ', bound to no realm yet'
            : `, for the realm ${JSON.stringify(printable(realm))}`),
      );
      return reply.code(204).send();
    } catch (error) {
      return failWith(reply, error);
    }
  });

  app.delete(
    '/api/v1/users/:id/identities/:provider/:subject',
    small,
    async (request: WithIdentity, reply) => {
      const denied = manageUsers(request, reply);
      if (denied) return denied;
      const { id, provider, subject = '' } = request.params;
      try {
        auth.authorizeChange(identityOf(request).principal, { users: [id] });
        // Also for a provider that is gone: its links must not outlive it for good.
        auth.unlinkIdentity(id, provider, subject);
        http.logger?.info(
          `${actor(request)} unlinked the account ${account(provider, subject)} from ${userName(id)}`,
        );
        return reply.code(204).send();
      } catch (error) {
        return failWith(reply, error);
      }
    },
  );

  // --- A user's own links to external accounts. Linking lets whoever has the account act as
  // the user, so it takes what signing in takes: the password, or for a user without one a
  // sign-in of the last few minutes. It is started by a POST, which passed the forgery
  // checks, and finished at the callback by the session that started it and no other.
  type WithOwnIdentity = FastifyRequest<{ Params: { provider: string; subject?: string } }>;
  /** The signed-in user a request is from, or why it is refused. */
  const ownUser = (request: FastifyRequest, reply: FastifyReply) => {
    const { principal, via } = identityOf(request);
    if (principal.kind === 'anonymous') return { denied: unauthenticated(reply) };
    if (via === 'dev') {
      return {
        denied: fail(reply, 403, 'forbidden', 'The user of dev mode has no accounts of its own'),
      };
    }
    if (via !== 'session' || !principal.id.startsWith('user:')) {
      return {
        denied: fail(reply, 403, 'forbidden', 'Only a signed-in user links accounts to themselves'),
      };
    }
    return { userId: principal.id.slice('user:'.length) };
  };
  /**
   * Linking and unlinking take the user's current password, or for a user without one a
   * sign-in of the last five minutes, and the session cookie of the user. Throws what
   * `confirmOwnPassword` throws.
   */
  const reauthenticate = async (
    request: FastifyRequest,
    reply: FastifyReply,
    userId: string,
    action: 'link' | 'unlink',
  ): Promise<{ readonly session: string } | { readonly denied: FastifyReply }> => {
    const session = cookieValue(
      request.headers.cookie,
      cookieName(SESSION_COOKIE, secure(request)),
    );
    const current = session === undefined ? undefined : auth.sessionOf(session);
    if (session === undefined || current?.userId !== userId) {
      return { denied: unauthenticated(reply) };
    }
    if (auth.hasPassword(userId)) {
      await auth.confirmOwnPassword(userId, jsonBody(request).password);
    } else if (Date.now() - current.createdAt > SELF_LINK_FRESH_MS) {
      return {
        denied: fail(
          reply,
          403,
          'forbidden',
          `Sign out and sign in again, then ${action} the account within five minutes`,
        ),
      };
    }
    return { session };
  };
  const failConfirming = (reply: FastifyReply, error: unknown) => {
    if (error instanceof ThrottledError) {
      reply.header('retry-after', String(error.retryAfterSeconds));
      return fail(reply, 429, 'unavailable', 'Too many attempts. Try again later.');
    }
    return failWith(reply, error);
  };
  const selfLinkable = (provider: string) =>
    isExternalProviderId(provider) &&
    providers.get(provider) !== undefined &&
    http.selfLinking?.allows(provider) === true;

  app.get('/api/v1/me/identities', async (request, reply) => {
    const own = ownUser(request, reply);
    if (own.denied) return own.denied;
    const { userId } = own;
    return {
      identities: auth
        .listIdentities()
        .filter((link) => link.userId === userId)
        .map(({ userId: _user, ...link }) => link),
      providers: providers.external().map(({ provider: { id, name } }) => ({
        id,
        name,
        selfLink: selfLinkable(id),
      })),
      password: auth.hasPassword(userId),
    };
  });

  app.post(
    '/api/v1/me/identities/:provider/link',
    small,
    async (request: WithOwnIdentity, reply) => {
      const own = ownUser(request, reply);
      if (own.denied) return own.denied;
      const { userId } = own;
      const { provider } = request.params;
      if (!selfLinkable(provider)) {
        return fail(reply, 403, 'forbidden', 'Linking an account of this provider is switched off');
      }
      const origin = ownOrigin(request);
      if (origin === undefined) {
        return fail(
          reply,
          400,
          'bad_request',
          'Open MoonCG at its own address to link an account: the provider sends the browser back there',
        );
      }
      try {
        const confirmed = await reauthenticate(request, reply, userId, 'link');
        if ('denied' in confirmed) return confirmed.denied;
        const { session } = confirmed;
        const { url, ticket } = await externalLogins.begin(provider, {
          redirectUri: `${origin}/auth/${provider}/callback`,
          returnTo: `/account?linked=${encodeURIComponent(provider)}`,
          address: context.remoteAddress(request),
          link: { userId, session: hashSecret(session) },
        });
        http.logger?.info(`A user started linking an account of "${provider}" to themselves`);
        return reply
          .header('cache-control', 'no-store')
          .header('set-cookie', oauthCookie(request, ticket, Math.floor(FLOW_TTL_MS / 1000)))
          .send({ url });
      } catch (error) {
        return failConfirming(reply, error);
      }
    },
  );

  app.delete(
    '/api/v1/me/identities/:provider/:subject',
    small,
    async (request: WithOwnIdentity, reply) => {
      const own = ownUser(request, reply);
      if (own.denied) return own.denied;
      const { provider, subject = '' } = request.params;
      try {
        const confirmed = await reauthenticate(request, reply, own.userId, 'unlink');
        if ('denied' in confirmed) return confirmed.denied;
        auth.unlinkOwnIdentity(own.userId, provider, subject);
        http.logger?.info(
          `A user unlinked the account ${account(provider, subject)} from themselves`,
        );
        return reply.code(204).send();
      } catch (error) {
        return failConfirming(reply, error);
      }
    },
  );

  // The switch for self-linking, for whoever manages users.
  app.get('/api/v1/self-linking', async (request, reply) => {
    const denied = manageUsers(request, reply);
    if (denied) return denied;
    return http.selfLinking?.state ?? { enabled: false, disabledProviders: [] };
  });

  app.put('/api/v1/self-linking', small, async (request, reply) => {
    const denied = manageUsers(request, reply);
    if (denied) return denied;
    if (!http.selfLinking) return notFound(reply);
    try {
      const state = await http.selfLinking.set(jsonBody(request));
      http.logger?.info(
        `${actor(request)} switched self-linking ${state.enabled ? 'on' : 'off'}` +
          (state.disabledProviders.length === 0
            ? ''
            : `, off for ${state.disabledProviders.join(', ')}`),
      );
      return state;
    } catch (error) {
      return failWith(reply, error);
    }
  });

  // --- Managing modules. A module is code that runs inside the server, so all of it is for
  // whoever may manage modules, and that is asked first: without the permission nothing is
  // told, not even whether a module exists.
  type WithModule = FastifyRequest<{ Params: { name: string; action?: string } }>;
  const manageModules = (request: FastifyRequest, reply: FastifyReply) =>
    can(request, MODULES_MANAGE) ? undefined : deny(request, reply, MODULES_MANAGE);

  app.get('/api/v1/modules', async (request, reply) => {
    const denied = manageModules(request, reply);
    if (denied) return denied;
    return { modules: modules.list() };
  });

  app.post('/api/v1/modules/:name/:action', small, async (request: WithModule, reply) => {
    const denied = manageModules(request, reply);
    if (denied) return denied;
    const { name, action } = request.params;
    if (action !== 'enable' && action !== 'disable') return notFound(reply);
    try {
      const module = await modules[action](name);
      http.logger?.info(`Module "${name}" was ${action}d by ${actor(request)}`);
      return { module };
    } catch (error) {
      return failWith(reply, error);
    }
  });

  // The pages modules added to the dashboard, for its navigation: each only for whoever holds
  // its permission. Anybody signed in may ask; nobody learns of a page they cannot open.
  app.get('/api/v1/module-pages', async (request, reply) => {
    if (anonymous(request)) return unauthenticated(reply);
    return {
      pages: modules
        .pages()
        .filter((page) => can(request, page.permission))
        .map(({ module, id, title, url }) => ({ module, id, title, url })),
    };
  });

  // The permissions there are to grant, for the Roles page: the built-in ones and what
  // running modules defined.
  app.get('/api/v1/permissions', async (request, reply) => {
    const denied = manageUsers(request, reply);
    if (denied) return denied;
    return { permissions: modules.permissions() };
  });

  // The configuration of a module holds secrets, like that of a bundle, and it decides what
  // trusted code does: for a login provider, whom it believes. So it takes both what the
  // settings take and what managing modules takes.
  const configurable = (request: WithModule, reply: FastifyReply) => {
    for (const permission of [MODULES_MANAGE, SETTINGS_MANAGE]) {
      if (!can(request, permission)) return void deny(request, reply, permission);
    }
    const { name } = request.params;
    const module = BUNDLE_NAME_PATTERN.test(name) ? modules.configurable(name) : undefined;
    if (!module) return void notFound(reply);
    return module;
  };

  app.get('/api/v1/modules/:name/config', async (request: WithModule, reply) => {
    const module = configurable(request, reply);
    if (!module) return reply;
    try {
      return { ...(await configs.describe(module)), module: modules.get(module.name) };
    } catch (error) {
      return failWith(reply, error);
    }
  });

  app.put('/api/v1/modules/:name/config', async (request: WithModule, reply) => {
    const module = configurable(request, reply);
    if (!module) return reply;
    try {
      const { values } = jsonBody(request);
      if (values === undefined) {
        throw new MoonCGError('bad_request', '"values" must be the configuration');
      }
      const described = await configs.write(module, values);
      // A module reads its configuration when it starts, so it is started again.
      const now = await modules.restart(module.name);
      http.logger?.info(
        `The settings of module "${module.name}" were changed by ${actor(request)}`,
      );
      const restartNote =
        now.state === 'running'
          ? undefined
          : now.state === 'disabled'
            ? 'The module is disabled. The settings apply when it is enabled.'
            : (now.error ?? 'The module failed.');
      return {
        ...described,
        restarted: restartNote === undefined,
        ...(restartNote === undefined
          ? {}
          : { restartNote: redactSecrets(configs.scrub(restartNote)) }),
        module: now,
      };
    } catch (error) {
      return failWith(reply, error);
    }
  });

  /** Who a change is logged as: the name of the user or token, or else the principal. */
  const actor = (request: FastifyRequest) => {
    const identity = identityOf(request);
    const described = auth.describe(identity);
    if (described.name == null) return identity.principal.id;
    return described.kind === 'token' ? `${described.name} (token)` : described.name;
  };

  // --- The routes modules registered. They come and go at run time, so one fixed route
  // dispatches to them. Each said what it takes when it was registered: a permission, which
  // is checked here before the handler runs, or that anybody may call it.
  const dispatch = async (
    request: FastifyRequest<{ Params: { module: string } }>,
    reply: FastifyReply,
  ) => {
    const { module } = request.params;
    // The path below `/m/<module>`, still percent-encoded: the first three parts of the raw
    // path are '', 'm' and the module.
    const rawPath = request.raw.url?.split('?')[0] ?? '';
    const path = normalizeRoutePath(`/${rawPath.split('/').slice(3).join('/')}`);
    // HEAD is answered like GET; the body is left out when the answer is sent.
    const method = request.method === 'HEAD' ? 'GET' : request.method;
    const match = modules.match(module, method, path);
    if (!match) {
      // Whether a module or a route exists is told only to someone who is signed in.
      if (anonymous(request)) return unauthenticated(reply);
      const others = modules
        .methods(module, path)
        .filter((other) => other.public === true || can(request, other.permission ?? ''));
      if (others.length === 0) return notFound(reply);
      const allow = others.flatMap((other) =>
        other.method === 'GET' ? ['GET', 'HEAD'] : [other.method],
      );
      reply.header('allow', allow.join(', '));
      return fail(reply, 405, 'bad_request', `${request.method} is not allowed for this path`);
    }
    const { route, params } = match;
    if (route.public !== true) {
      const permission = route.permission ?? '';
      if (!can(request, permission)) return deny(request, reply, permission);
    }
    const { principal } = identityOf(request);
    let response: ModuleResponse;
    try {
      response =
        (await route.handler({
          method: method as HttpMethod,
          path,
          params,
          query: flatten(request.query as Record<string, unknown>, new Set([TOKEN_PARAMETER])),
          headers: flatten(request.headers, CREDENTIAL_HEADERS),
          body: Buffer.isBuffer(request.body) ? request.body : null,
          principal: { id: principal.id, kind: principal.kind ?? 'user' },
        })) ?? {};
    } catch (error) {
      const typed = typedError(error);
      if (!typed) {
        http.logger?.error(
          `A route of module "${module}" failed (${method} ${path}): ${errorMessage(error)}`,
        );
      }
      return failWith(reply, typed ?? error);
    }
    const status = Number.isInteger(response.status) ? (response.status as number) : 200;
    reply.code(status >= 100 && status <= 599 ? status : 500);
    for (const [name, value] of Object.entries(response.headers ?? {})) {
      // How the answer travels is the business of the server, not of the handler.
      if (!CONNECTION_HEADERS.has(name.toLowerCase())) reply.header(name, String(value));
    }
    // A module answers from the origin of the dashboard. Unless its handler says what a page
    // of its own may do, a browser that opens the answer as a document runs nothing of it and
    // gives it no origin: text a handler put into a page by mistake cannot act as this
    // server towards whoever looks at it. An answer that is data is not touched by this.
    if (!reply.hasHeader('content-security-policy')) {
      reply.header('content-security-policy', ASSET_CSP);
    }
    const { body } = response;
    if (body === undefined) return reply.send();
    if (typeof body === 'string') {
      if (!reply.hasHeader('content-type')) reply.type('text/plain; charset=utf-8');
      return reply.send(body);
    }
    if (body instanceof Uint8Array) {
      if (!reply.hasHeader('content-type')) reply.type('application/octet-stream');
      return reply.send(Buffer.from(body));
    }
    return reply.type('application/json; charset=utf-8').send(JSON.stringify(body));
  };
  const methods = [...HTTP_METHODS, 'OPTIONS' as const];
  app.route({ method: methods, url: '/m/:module', handler: dispatch });
  app.route({ method: methods, url: '/m/:module/*', handler: dispatch });
}
