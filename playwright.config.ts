import { defineConfig } from '@playwright/test';

// The smoke test starts its own server from the built packages on a free port with a
// temporary data directory. Run it with `pnpm test:e2e`, which builds first.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: 'list',
  use: { headless: true },
});
