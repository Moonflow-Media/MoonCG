import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against sources, so no build is needed before `pnpm test`.
    alias: {
      '@mooncg/core': src('./packages/core/src/index.ts'),
      '@mooncg/sdk/client': src('./packages/sdk/src/client/index.ts'),
      '@mooncg/sdk/extension': src('./packages/sdk/src/extension/index.ts'),
      '@mooncg/server/accounts': src('./packages/server/src/accounts.ts'),
      '@mooncg/server': src('./packages/server/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
  },
});
