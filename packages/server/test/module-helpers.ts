import { request } from 'node:http';
import type { ServerConfig } from '../src/kernel/config.js';
import type { ServerOptions } from '../src/server.js';
import { memoryStorage } from '../src/storage/replicant-store.js';
import { type AuthServer, PASSWORD, startAuthServer } from './auth-helpers.js';
import type { temporaryBundles } from './temp-bundles.js';

/** A minimal valid manifest for a module called `name`. */
export function moduleManifest(name: string, extra: object = {}): object {
  return { manifest: 1, kind: 'module', name, version: '1.0.0', main: 'index.js', ...extra };
}

/** What the fake provider was asked, for the tests to look at. */
export interface FakeIdpCalls {
  authorize: {
    state: string;
    nonce: string;
    codeChallenge: string;
    redirectUri: string;
  }[];
  callback: {
    query: Record<string, string>;
    redirectUri: string;
    nonce: string;
    codeVerifier: string;
  }[];
}

export const fakeIdpCalls = (): FakeIdpCalls => {
  const holder = globalThis as { __fakeIdp?: FakeIdpCalls };
  holder.__fakeIdp ??= { authorize: [], callback: [] };
  return holder.__fakeIdp;
};

/**
 * A module with two providers that stand in for an identity provider: `fake`, which only
 * signs in whoever is linked, and `open`, which signs up. The `code` that comes back is
 * `<subject>|<name>` or `<subject>|<name>|<realm>`, and `boom` makes the provider throw.
 */
export const FAKE_IDP = {
  'fake-idp/mooncg.json': moduleManifest('fake-idp', { title: 'Fake IdP' }),
  'fake-idp/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
  'fake-idp/index.js': `export default function setup(ctx) {
  const calls = (globalThis.__fakeIdp ??= { authorize: [], callback: [] });
  const provider = (id, name, allowSignup) => ({
    id,
    name,
    allowSignup,
    icon: 'icon.svg',
    authorize(request) {
      calls.authorize.push(request);
      const url = new URL('https://idp.example/authorize');
      url.searchParams.set('state', request.state);
      url.searchParams.set('redirect_uri', request.redirectUri);
      return url.href;
    },
    async callback(request) {
      calls.callback.push(request);
      if (request.query.code === 'boom') throw new Error('The provider said no: hunter2-secret');
      const [subject, name, realm] = (request.query.code ?? '').split('|');
      return { subject, name, realm: realm || undefined };
    },
  });
  ctx.auth.registerProvider(provider('fake', 'Fake <b>&"ID"', false));
  ctx.auth.registerProvider(provider('open', 'Open', true));
}
`,
};

export interface ModuleServer extends AuthServer {
  readonly admin: string;
  /** A GET with headers `fetch` will not send, such as another `Host`. */
  raw(
    path: string,
    headers?: Record<string, string>,
  ): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }>;
}

/** Starts a server with the given modules, some of them enabled, and the admin `ada`. */
export async function startModuleServer(
  temporary: ReturnType<typeof temporaryBundles>,
  modules: Readonly<Record<string, string | object>>,
  enabled: readonly string[] = [],
  config: Partial<ServerConfig> = {},
  options: Partial<ServerOptions> = {},
): Promise<ModuleServer> {
  const storage = options.storage ?? memoryStorage();
  for (const name of enabled) await storage.modules.setEnabled(name, true);
  const modulesDir = await temporary.create(modules);
  const context = await startAuthServer(
    temporary,
    { modulesDir, dataDir: await temporary.create({}), ...config },
    { ...options, storage },
  );
  await context.auth.createUser({ name: 'ada', password: PASSWORD, roles: ['admin'] });
  const admin = await context.login('ada');
  const raw: ModuleServer['raw'] = (path, headers = {}) =>
    new Promise((resolve, reject) => {
      const sent = request(
        { host: '127.0.0.1', port: context.server.port, path, method: 'GET', headers },
        (response) => {
          response.resume();
          response.on('end', () =>
            resolve({ status: response.statusCode ?? 0, headers: response.headers }),
          );
        },
      );
      sent.on('error', reject);
      sent.end();
    });
  return { ...context, admin, raw };
}
