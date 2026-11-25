import { describe, expect, it } from 'vitest';
import {
  type AuthProvider,
  defineModule,
  type ModuleContext,
  type ModuleRoute,
} from '../src/module/index.js';

/** A context that records what a module registers: what the server tracks in its place. */
function recordingContext(config: ModuleContext['config'] = {}) {
  const providers: AuthProvider[] = [];
  const routes: ModuleRoute[] = [];
  const permissions: string[] = [];
  const disposers: (() => void | Promise<void>)[] = [];
  const context: ModuleContext = {
    name: 'example',
    dir: '/modules/example',
    config,
    logger: { info() {}, warn() {}, error() {} },
    auth: { registerProvider: (provider) => void providers.push(provider) },
    http: { register: (route) => void routes.push(route) },
    permissions: {
      define(name) {
        permissions.push(name);
        return `system:module.example.${name}`;
      },
    },
    onDispose: (dispose) => void disposers.push(dispose),
  };
  return { context, providers, routes, permissions, disposers };
}

describe('defineModule', () => {
  it('hands back the setup it was given, typed', async () => {
    const setup = defineModule((ctx) => {
      const permission = ctx.permissions.define('use', 'Use the example');
      ctx.http.register({ method: 'GET', path: '/hello', permission, handler: () => ({}) });
      ctx.http.register({
        method: 'GET',
        path: '/health',
        public: true,
        handler: () => ({ body: { ok: true } }),
      });
      ctx.auth.registerProvider({
        id: 'example',
        name: 'Example',
        authorize: ({ state }) => `https://id.example/authorize?state=${state}`,
        callback: () => ({ subject: '42' }),
      });
      ctx.onDispose(() => {});
      return () => {};
    });
    const recorded = recordingContext();
    const dispose = await setup(recorded.context);
    expect(typeof dispose).toBe('function');
    expect(recorded.providers.map((provider) => provider.id)).toEqual(['example']);
    expect(recorded.routes.map((route) => route.path)).toEqual(['/hello', '/health']);
    expect(recorded.permissions).toEqual(['use']);
    expect(recorded.disposers).toHaveLength(1);
  });
});
