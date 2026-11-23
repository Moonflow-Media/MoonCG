// The worker entry the tests use. The built server starts `dist/extension-host/worker-main.js`;
// tests have no build, so this file teaches the worker thread to load the TypeScript sources:
// an import of "./x.js" finds "./x.ts", and the workspace packages resolve to their sources.
//
// Like Node's own resolution of the built packages, the workspace packages are only found
// from inside the workspace. An extension somewhere else gets them through the hook that
// `worker-main.ts` registers, which is what the tests of such extensions exercise.
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const workspace = new URL('../../', import.meta.url).href;
const sources = {
  '@mooncg/core': new URL('../../core/src/index.ts', import.meta.url).href,
  '@mooncg/sdk/extension': new URL('../../sdk/src/extension/index.ts', import.meta.url).href,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (Object.hasOwn(sources, specifier) && context.parentURL?.startsWith(workspace)) {
      return nextResolve(sources[specifier], context);
    }
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
      const source = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
      if (existsSync(fileURLToPath(source))) return nextResolve(source.href, context);
    }
    return nextResolve(specifier, context);
  },
});

await import('../src/extension-host/worker-main.ts');
