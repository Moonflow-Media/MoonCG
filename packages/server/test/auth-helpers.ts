import {
  type ClientMessage,
  decodeServerMessage,
  encodeMessage,
  PROTOCOL_VERSION,
  type ServerMessage,
} from '@mooncg/core';
import { WebSocket } from 'ws';
import { InlineHost } from '../src/extension-host/inline-host.js';
import type { ServerConfig } from '../src/kernel/config.js';
import { type RunningServer, type ServerOptions, startServer } from '../src/server.js';
import { memoryStorage } from '../src/storage/replicant-store.js';
import { fixture, memoryLogger, testConfig } from './helpers.js';
import { manifest, type temporaryBundles } from './temp-bundles.js';

/** Password hashing as cheap as scrypt allows: the tests check the logic, not the cost. */
export const CHEAP = { N: 16, r: 1, p: 1 };
export const PASSWORD = 'correct horse';
/** Every wait for the network in these tests is bounded by this. */
export const WAIT_MS = 5000;

const EXTENSION = `export default async function start(ctx) {
  const score = ctx.replicant('score');
  await ctx.http.get('/public', async (request) => ({
    body: {
      headers: Object.keys(request.headers).sort(),
      query: request.query,
      sender: request.sender,
      operate: await ctx.permissions.check(request.sender, 'operate'),
    },
  }));
  await ctx.http.post(
    '/score',
    async () => {
      await score.update((draft) => {
        draft.home++;
      });
      return { body: score.value };
    },
    { permission: 'operate' },
  );
  await ctx.handle('whoami', async (_data, { sender }) => ({
    sender,
    operate: await ctx.permissions.check(sender, 'operate'),
  }));
}`;

/** A bundle with two permissions and one of everything, and a bundle nobody was granted. */
export const authBundles = () => ({
  'board/mooncg.json': manifest('board', {
    title: 'Board',
    extension: 'extension/index.js',
    capabilities: ['http.routes'],
    permissions: { view: 'See the board', operate: 'Change the board' },
    defaultRoles: { operator: ['view', 'operate'], viewer: ['view'], graphics: ['view'] },
    panels: [
      { id: 'control', title: 'Control', file: 'dashboard/control.html', requires: 'operate' },
    ],
    graphics: [
      { id: 'overlay', file: 'graphics/overlay.html', width: 1920, height: 1080, requires: 'view' },
    ],
    replicants: {
      score: { default: { home: 0 }, read: 'view', write: 'operate' },
      notes: { default: '' },
    },
    messages: { reset: { send: 'operate', listen: 'view' }, whoami: {} },
  }),
  'board/extension/index.js': EXTENSION,
  'board/dashboard/control.html': 'board control',
  'board/graphics/overlay.html': 'board overlay',
  'board/graphics/style.css': 'body {}',
  'secret/mooncg.json': manifest('secret', {
    permissions: { view: 'See the secret' },
    graphics: [{ id: 'g', file: 'graphics/g.html', width: 1, height: 1, requires: 'view' }],
    replicants: { data: { default: 1, read: 'view' } },
  }),
  'secret/graphics/g.html': 'secret graphic',
});

export interface HttpAnswer {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  /** The parsed body, or `undefined` if it is not JSON. */
  // biome-ignore lint/suspicious/noExplicitAny: tests read answers of many shapes without narrowing
  readonly json: any;
  /** The `Set-Cookie` headers, each as it was sent. */
  readonly setCookies: string[];
}

export interface RequestOptions {
  readonly cookie?: string | undefined;
  readonly bearer?: string | undefined;
  /** Sent as the JSON body. */
  readonly json?: unknown;
  readonly body?: string;
  readonly headers?: Record<string, string>;
}

export type TestSocket = Awaited<ReturnType<AuthServer['socket']>>;
export type AuthServer = Awaited<ReturnType<typeof startAuthServer>>;

/** The `name=value` part of a `Set-Cookie` header, as a browser would send it back. */
export const cookiePair = (setCookie: string) => setCookie.split(';')[0] as string;

/** Starts a server with real accounts on a free port. Nothing is stored outside memory. */
export async function startAuthServer(
  temporary: ReturnType<typeof temporaryBundles>,
  config: Partial<ServerConfig> = {},
  options: Partial<ServerOptions> = {},
) {
  const { logger, lines } = memoryLogger();
  const server: RunningServer = await startServer(
    testConfig({ bundlesDir: await temporary.create(authBundles()), ...config }),
    {
      logger,
      sdkFile: fixture('sdk/mooncg.js'),
      dashboardDir: fixture('dashboard'),
      storage: memoryStorage(),
      createHost: (services) => new InlineHost(services),
      passwordCost: CHEAP,
      ...options,
    },
  );
  await server.started;
  const base = `http://127.0.0.1:${server.port}`;

  const http = async (
    method: string,
    path: string,
    request: RequestOptions = {},
  ): Promise<HttpAnswer> => {
    const headers: Record<string, string> = { ...request.headers };
    if (request.cookie !== undefined) headers.cookie = request.cookie;
    if (request.bearer !== undefined) headers.authorization = `Bearer ${request.bearer}`;
    if (request.json !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(WAIT_MS),
      ...(request.json !== undefined
        ? { body: JSON.stringify(request.json) }
        : request.body !== undefined
          ? { body: request.body }
          : {}),
    });
    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return {
      status: response.status,
      headers: response.headers,
      text,
      json,
      setCookies: response.headers.getSetCookie(),
    };
  };

  /** Signs in over HTTP and returns the cookie to send back. */
  const login = async (username: string, password = PASSWORD): Promise<string> => {
    const answer = await http('POST', '/api/v1/auth/login', { json: { username, password } });
    if (answer.status !== 200) throw new Error(`Login as ${username} answered ${answer.status}`);
    return cookiePair(answer.setCookies[0] as string);
  };

  /** How an upgrade request ends: 101, or the status it was refused with. */
  const upgrade = (headers: Record<string, string> = {}): Promise<number> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers });
      const timer = setTimeout(() => reject(new Error('The upgrade was not answered')), WAIT_MS);
      const done = (status: number) => {
        clearTimeout(timer);
        ws.terminate();
        resolve(status);
      };
      ws.on('open', () => done(101));
      ws.on('unexpected-response', (_request, response) => done(response.statusCode ?? 0));
      ws.on('error', () => {});
    });

  /** Opens a socket, says hello for `bundle` and returns a way to ask and to watch it close. */
  const socket = async (headers: Record<string, string>, bundle = 'board', graphic?: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers });
    const waiting = new Map<number, (msg: ServerMessage) => void>();
    const pushed: ServerMessage[] = [];
    let welcome: (() => void) | undefined;
    let refuse: ((error: Error) => void) | undefined;
    let nextId = 1;
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    ws.on('message', (data) => {
      const decoded = decodeServerMessage(data.toString());
      if (!decoded.ok) return;
      const { msg } = decoded;
      if (msg.t === 'welcome') welcome?.();
      else if (msg.t === 'err' && msg.id === undefined) {
        refuse?.(new Error(`hello was refused: ${msg.code}`));
      } else if ('id' in msg && msg.id !== undefined) waiting.get(msg.id)?.(msg);
      else pushed.push(msg);
    });
    const bounded = <T>(work: Promise<T>, what: string): Promise<T> =>
      Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`${what} was not answered`)), WAIT_MS);
          void work.finally(() => clearTimeout(timer)).catch(() => {});
        }),
      ]);
    await bounded(
      new Promise<void>((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      }),
      'The upgrade',
    );
    const welcomed = new Promise<void>((resolve, reject) => {
      welcome = resolve;
      refuse = reject;
    });
    welcomed.catch(() => ws.terminate());
    ws.send(
      encodeMessage({
        t: 'hello',
        v: PROTOCOL_VERSION,
        bundle,
        ...(graphic === undefined ? {} : { graphic }),
      }),
    );
    await bounded(welcomed, 'hello');
    type Ask = ClientMessage extends infer M
      ? M extends { id: number }
        ? Omit<M, 'id'>
        : never
      : never;
    return {
      pushed,
      /** Sends a request and resolves with the server's answer to it. */
      ask(request: Ask): Promise<ServerMessage> {
        const id = nextId++;
        const answer = new Promise<ServerMessage>((resolve) => waiting.set(id, resolve));
        ws.send(encodeMessage({ ...request, id } as ClientMessage));
        return bounded(answer, request.t);
      },
      /** Resolves with the close code once the socket is closed, by either side. */
      closed: () => bounded(closed, 'The close'),
      close: () => ws.terminate(),
    };
  };

  return { server, base, lines, auth: server.auth, http, login, upgrade, socket };
}

/**
 * A server with one user per built-in role: ada (admin), olga (operator), vera (viewer) and
 * gina (graphics), each signed in.
 */
export async function startWithRoles(temporary: ReturnType<typeof temporaryBundles>) {
  const context = await startAuthServer(temporary);
  const users = { admin: 'ada', operator: 'olga', viewer: 'vera', graphics: 'gina' } as const;
  const cookies: Record<string, string> = {};
  for (const [role, name] of Object.entries(users)) {
    await context.auth.createUser({ name, password: PASSWORD, roles: [role] });
    cookies[role] = await context.login(name);
  }
  return { ...context, cookies: cookies as Record<keyof typeof users, string> };
}
