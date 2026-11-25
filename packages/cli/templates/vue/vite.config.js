import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';
import { localOnly } from './local-only.js';

/** Where MoonCG runs. The development server hands everything of MoonCG's on to it. */
const mooncg = process.env.MOONCG_URL ?? 'http://localhost:9090';
const here = (path) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig(({ command }) => ({
  root: 'src',
  // The pages are served below the same path by MoonCG and by the development server, so a
  // page learns its bundle (and a graphic which graphic it is) from its own address.
  base: '/b/{{name}}/',
  plugins: [vue()],
  // One copy of Vue, also for @mooncg/sdk/vue, which is linked from elsewhere.
  resolve: { dedupe: ['vue'] },
  server: {
    // The port of "dev.url" in mooncg.json. Change both for a second bundle.
    port: 5173,
    strictPort: true,
    // Keep it on this machine while MoonCG runs in dev mode, which signs in every request
    // from here: no `--host`. `localOnly` refuses what another computer asks for anyway.
    proxy: {
      '/ws': { target: mooncg, ws: true, bypass: localOnly },
      '/sdk': { target: mooncg, changeOrigin: true, bypass: localOnly },
      '/api': { target: mooncg, changeOrigin: true, bypass: localOnly },
      // The HTTP routes and uploaded assets of this bundle.
      '^/b/{{name}}/(api|assets)(/|$)': { target: mooncg, changeOrigin: true, bypass: localOnly },
    },
  },
  // MoonCG serves the bundle's dashboard/ and graphics/ folders: the built pages go there,
  // and what they load goes to dashboard/assets/, which a graphic may load as well. That is
  // the folder above `src`, which Vite warns about; nothing but those two folders is written.
  build:
    command !== 'build'
      ? {}
      : {
          outDir: here('.'),
          emptyOutDir: false,
          rolldownOptions: {
            input: {
              control: here('src/dashboard/control.html'),
              overlay: here('src/graphics/overlay.html'),
            },
            output: {
              // Without a hash: each build replaces the files of the one before.
              entryFileNames: 'dashboard/assets/[name].js',
              chunkFileNames: 'dashboard/assets/[name].js',
              assetFileNames: 'dashboard/assets/[name][extname]',
            },
          },
        },
}));
