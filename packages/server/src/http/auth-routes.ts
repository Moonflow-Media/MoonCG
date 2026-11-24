import { isPlainObject, MoonCGError, TOKENS_MANAGE, USERS_MANAGE } from '@mooncg/core';
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  HTTPMethods,
  RouteHandlerMethod,
} from 'fastify';
import { SESSION_MAX_MS, ThrottledError } from '../auth/auth.js';
import type { TokenRecord } from '../storage/auth-store.js';
import type { HttpContext } from './app.js';
import { credentialsOf, SESSION_COOKIE, sessionCookie, TOKEN_COOKIE } from './identity.js';

/**
 * The largest body a route for accounts reads, 16 KiB. Everything these routes take is a few
 * short strings; a larger body is refused with 413 before any of it is looked at.
 */
export const AUTH_BODY_LIMIT = 16 * 1024;

/** The JSON object a request carries. Anything else is a `bad_request`. */
function jsonBody(request: FastifyRequest): Record<string, unknown> {
  const type = request.headers['content-type']?.toLowerCase() ?? '';
  if (!type.startsWith('application/json')) {
    throw new MoonCGError('bad_request', 'Expected a JSON body (Content-Type: application/json)');
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.isBuffer(request.body) ? request.body.toString('utf8') : '');
  } catch {
    throw new MoonCGError('bad_request', 'The request body is not valid JSON');
  }
  if (!isPlainObject(body)) throw new MoonCGError('bad_request', 'Expected a JSON object');
  return body;
}

function text(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string') {
    throw new MoonCGError('bad_request', `"${field}" must be a string`);
  }
  return value;
}

function textList(body: Record<string, unknown>, field: string): string[] | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new MoonCGError('bad_request', `"${field}" must be a list of strings`);
  }
  return value;
}

function flag(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  if (value !== undefined && typeof value !== 'boolean') {
    throw new MoonCGError('bad_request', `"${field}" must be true or false`);
  }
  return value;
}

const iso = (time: number | null) => (time === null ? null : new Date(time).toISOString());

/** A token as the API shows it. Its secret is not among what the server has. */
const describeToken = (token: TokenRecord) => ({
  id: token.id,
  name: token.name,
  grants: token.grants,
  expires: iso(token.expires),
  lastUsed: iso(token.lastUsed),
  createdBy: token.createdBy,
  createdAt: iso(token.createdAt),
});

/**
 * The routes for signing in, first-time setup, and managing users, roles and tokens. Every
 * handler that changes something has already passed the origin and forgery checks.
 */
export function registerAuthRoutes(app: FastifyInstance, context: HttpContext): void {
  const { auth, identityOf, can, deny, fail, failWith, secure } = context;

  /** Wraps a handler so that a typed error becomes its HTTP answer. */
  const handle =
    <Request extends FastifyRequest>(
      permission: string | undefined,
      work: (request: Request, reply: FastifyReply) => unknown,
    ) =>
    async (request: Request, reply: FastifyReply) => {
      if (permission !== undefined && !can(request, permission)) {
        return deny(request, reply, permission);
      }
      try {
        return await work(request, reply);
      } catch (error) {
        if (error instanceof ThrottledError) {
          reply.header('retry-after', String(error.retryAfterSeconds));
          return fail(reply, 429, error.code, error.message);
        }
        return failWith(reply, error);
      }
    };
  /** Registers a route that reads no more than a small body. */
  const route = <Request extends FastifyRequest>(
    method: HTTPMethods,
    url: string,
    handler: (request: Request, reply: FastifyReply) => unknown,
  ) =>
    app.route({ method, url, bodyLimit: AUTH_BODY_LIMIT, handler: handler as RouteHandlerMethod });
  const actor = (request: FastifyRequest) => identityOf(request).principal;
  const who = (request: FastifyRequest) => {
    const { id, kind, name, roles, permissions } = auth.describe(identityOf(request));
    return { user: { id, kind, name }, roles, permissions };
  };
  const setSession = (request: FastifyRequest, reply: FastifyReply, session: string) =>
    reply.header(
      'set-cookie',
      sessionCookie(SESSION_COOKIE, session, {
        secure: secure(request),
        maxAge: Math.floor(SESSION_MAX_MS / 1000),
      }),
    );
  type WithId = FastifyRequest<{ Params: { id: string } }>;
  type WithRole = FastifyRequest<{ Params: { id: string; role: string } }>;
  type WithName = FastifyRequest<{ Params: { name: string } }>;
  type WithGrant = FastifyRequest<{ Params: { name: string; permission: string } }>;

  route('GET', '/login', (_request, reply) => context.sendPage(reply, 'login.html'));
  route('GET', '/auth.js', (_request, reply) => context.sendPage(reply, 'auth.js'));
  route('GET', '/setup', (_request, reply) => {
    // Once a user exists, nothing tells that there ever was a setup.
    if (auth.setupCode() === undefined) return fail(reply, 404, 'not_found', 'Not found');
    return context.sendPage(reply, 'setup.html');
  });

  route(
    'POST',
    '/api/v1/setup',
    handle(undefined, async (request, reply) => {
      if (auth.setupCode() === undefined) return fail(reply, 404, 'not_found', 'Not found');
      const body = jsonBody(request);
      const user = await auth.setup(
        text(body, 'code'),
        text(body, 'username'),
        text(body, 'password'),
      );
      return reply.code(201).send({ user });
    }),
  );

  route(
    'POST',
    '/api/v1/auth/login',
    handle(undefined, async (request, reply) => {
      const body = jsonBody(request);
      const result = await auth.login(
        text(body, 'username'),
        text(body, 'password'),
        context.remoteAddress(request),
      );
      if (!result.ok) {
        if (result.reason === 'throttled') throw new ThrottledError(result.retryAfterSeconds);
        // The same answer whatever was wrong, so it does not tell which names exist.
        return fail(reply, 401, 'forbidden', 'Wrong user name or password');
      }
      setSession(request, reply, result.session);
      const signedIn = auth.describe(auth.identify({ session: result.session }));
      const { id, kind, name, roles, permissions } = signedIn;
      return { user: { id, kind, name }, roles, permissions };
    }),
  );

  route(
    'POST',
    '/api/v1/auth/logout',
    handle(undefined, (request, reply) => {
      const { session, tokenSession } = credentialsOf(request.headers, secure(request));
      for (const secret of [session, tokenSession]) {
        if (secret !== undefined) auth.logout(secret);
      }
      const gone = { secure: secure(request), maxAge: 0 };
      return reply
        .header('set-cookie', [
          sessionCookie(SESSION_COOKIE, '', gone),
          sessionCookie(TOKEN_COOKIE, '', gone),
        ])
        .code(204)
        .send();
    }),
  );

  route('GET', '/api/v1/me', (request: FastifyRequest, reply) => {
    if (actor(request).kind === 'anonymous') {
      return fail(reply, 401, 'forbidden', 'Authentication required');
    }
    return who(request);
  });

  route(
    'POST',
    '/api/v1/me/password',
    handle(undefined, async (request, reply) => {
      const { principal, via } = identityOf(request);
      // Only someone signed in with a password has one to change; a token does not.
      if (via !== 'session') {
        return principal.kind === 'anonymous'
          ? fail(reply, 401, 'forbidden', 'Authentication required')
          : fail(reply, 403, 'forbidden', 'Only a signed-in user can change the own password');
      }
      const body = jsonBody(request);
      // A routine change keeps the user's tokens, or every graphic in OBS would stop. Whoever
      // changes the password because it leaked asks for them to go.
      const revokeTokens = flag(body, 'revokeTokens') ?? false;
      const session = await auth.changeOwnPassword(
        principal.id.slice('user:'.length),
        text(body, 'current'),
        text(body, 'password'),
        { revokeTokens },
      );
      return setSession(request, reply, session).code(204).send();
    }),
  );

  // --- Users. Nobody manages a user who holds more than they do, or hands out a role they
  // do not fully hold themselves.
  route(
    'GET',
    '/api/v1/users',
    handle(USERS_MANAGE, () => ({ users: auth.listUsers() })),
  );
  route(
    'POST',
    '/api/v1/users',
    handle(USERS_MANAGE, async (request, reply) => {
      const body = jsonBody(request);
      const roles = textList(body, 'roles') ?? [];
      auth.authorizeChange(actor(request), { roles });
      const user = await auth.createUser({
        name: text(body, 'name'),
        password: text(body, 'password'),
        roles,
      });
      return reply.code(201).send({ user });
    }),
  );
  route(
    'PATCH',
    '/api/v1/users/:id',
    handle(USERS_MANAGE, (request: WithId) => {
      const body = jsonBody(request);
      const { name } = body;
      if (name !== undefined && typeof name !== 'string') {
        throw new MoonCGError('bad_request', '"name" must be a string');
      }
      const disabled = flag(body, 'disabled');
      auth.authorizeChange(actor(request), { users: [request.params.id] });
      const user = auth.updateUser(request.params.id, {
        ...(name === undefined ? {} : { name }),
        ...(disabled === undefined ? {} : { disabled }),
      });
      return { user };
    }),
  );
  route(
    'DELETE',
    '/api/v1/users/:id',
    handle(USERS_MANAGE, (request: WithId, reply) => {
      auth.authorizeChange(actor(request), { users: [request.params.id] });
      auth.deleteUser(request.params.id);
      return reply.code(204).send();
    }),
  );
  route(
    'PUT',
    '/api/v1/users/:id/password',
    handle(USERS_MANAGE, async (request: WithId, reply) => {
      const body = jsonBody(request);
      // A password is reset because someone else may know it, and may have made tokens.
      const revokeTokens = flag(body, 'revokeTokens') ?? true;
      auth.authorizeChange(actor(request), { users: [request.params.id] });
      await auth.setPassword(request.params.id, text(body, 'password'), { revokeTokens });
      return reply.code(204).send();
    }),
  );
  route(
    'PUT',
    '/api/v1/users/:id/roles/:role',
    handle(USERS_MANAGE, (request: WithRole, reply) => {
      auth.authorizeChange(actor(request), { roles: [request.params.role] });
      auth.assignRole(request.params.id, request.params.role);
      return reply.code(204).send();
    }),
  );
  route(
    'DELETE',
    '/api/v1/users/:id/roles/:role',
    handle(USERS_MANAGE, (request: WithRole, reply) => {
      auth.authorizeChange(actor(request), { roles: [request.params.role] });
      auth.unassignRole(request.params.id, request.params.role);
      return reply.code(204).send();
    }),
  );

  // --- Roles and their grants, under the same rule.
  const role = (name: string) => ({ role: auth.listRoles().find((entry) => entry.name === name) });
  route(
    'GET',
    '/api/v1/roles',
    handle(USERS_MANAGE, () => ({ roles: auth.listRoles() })),
  );
  route(
    'POST',
    '/api/v1/roles',
    handle(USERS_MANAGE, (request, reply) => {
      const body = jsonBody(request);
      const grants = textList(body, 'grants') ?? [];
      auth.authorizeChange(actor(request), { grants });
      return reply.code(201).send({ role: auth.createRole(text(body, 'name'), grants) });
    }),
  );
  route(
    'DELETE',
    '/api/v1/roles/:name',
    handle(USERS_MANAGE, (request: WithName, reply) => {
      auth.authorizeChange(actor(request), { roles: [request.params.name] });
      auth.deleteRole(request.params.name);
      return reply.code(204).send();
    }),
  );
  route(
    'POST',
    '/api/v1/roles/:name/grants',
    handle(USERS_MANAGE, (request: WithName) => {
      const permission = text(jsonBody(request), 'permission');
      auth.authorizeChange(actor(request), { grants: [permission] });
      auth.grant(request.params.name, permission);
      return role(request.params.name);
    }),
  );
  route(
    'DELETE',
    '/api/v1/roles/:name/grants/:permission',
    handle(USERS_MANAGE, (request: WithGrant) => {
      auth.authorizeChange(actor(request), { grants: [request.params.permission] });
      auth.revoke(request.params.name, request.params.permission);
      return role(request.params.name);
    }),
  );

  // --- API tokens.
  route(
    'GET',
    '/api/v1/tokens',
    handle(TOKENS_MANAGE, () => ({ tokens: auth.listTokens().map(describeToken) })),
  );
  route(
    'POST',
    '/api/v1/tokens',
    handle(TOKENS_MANAGE, (request, reply) => {
      const body = jsonBody(request);
      const grants = textList(body, 'grants');
      if (grants === undefined) throw new MoonCGError('bad_request', '"grants" is required');
      let expires: number | undefined;
      if (body.expires !== undefined && body.expires !== null) {
        expires = Date.parse(text(body, 'expires'));
        if (Number.isNaN(expires)) {
          throw new MoonCGError(
            'bad_request',
            '"expires" must be a date such as 2030-01-31T00:00:00Z',
          );
        }
      }
      const { token, secret } = auth.createToken(actor(request), {
        name: text(body, 'name'),
        grants,
        ...(expires === undefined ? {} : { expires }),
      });
      // The only time the secret is ever shown.
      return reply.code(201).send({ token: describeToken(token), secret });
    }),
  );
  route(
    'DELETE',
    '/api/v1/tokens/:id',
    handle(TOKENS_MANAGE, (request: WithId, reply) => {
      auth.revokeToken(request.params.id);
      return reply.code(204).send();
    }),
  );
}
