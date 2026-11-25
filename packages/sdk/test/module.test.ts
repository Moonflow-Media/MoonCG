import { describe, expect, it } from 'vitest';
import {
  type AuthProvider,
  defineModule,
  type ModuleContext,
  type ModulePage,
  type ModuleRegistrySource,
  type ModuleRoute,
} from '../src/module/index.js';

/** A context that records what a module registers: what the server tracks in its place. */
function recordingContext(config: ModuleContext['config'] = {}) {
  const providers: AuthProvider[] = [];
  const routes: ModuleRoute[] = [];
  const permissions: string[] = [];
  const disposers: (() => void | Promise<void>)[] = [];
  const sources: ModuleRegistrySource[] = [];
  const pages: ModulePage[] = [];
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
    registry: { registerSource: (source) => void sources.push(source) },
    dashboard: { registerPage: (page) => void pages.push(page) },
    onDispose: (dispose) => void disposers.push(dispose),
  };
  return { context, providers, routes, permissions, disposers, sources, pages };
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
      ctx.registry.registerSource({ id: 'studio', load: async () => ({ index: 1, entries: [] }) });
      ctx.dashboard.registerPage({ id: 'hello', title: 'Hello', path: '/hello', permission });
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
    expect(recorded.sources.map((source) => source.id)).toEqual(['studio']);
    expect(recorded.pages).toEqual([
      { id: 'hello', title: 'Hello', path: '/hello', permission: 'system:module.example.use' },
    ]);
  });
});
