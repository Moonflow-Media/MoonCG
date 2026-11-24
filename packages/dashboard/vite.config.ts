import { defineConfig } from 'vite';

// The server serves `dist/index.html` for every dashboard route and the built files below
// `/ui/`. Scripts and styles are files of their own, never inline, so the page works under
// the server's Content-Security-Policy as it is.
export default defineConfig({
  base: '/',
  build: {
    outDir: 'dist',
    assetsDir: 'ui',
    emptyOutDir: true,
    // Small files stay files: a `data:` URL would need the policy loosened.
    assetsInlineLimit: 0,
  },
  define: {
    __VUE_OPTIONS_API__: 'true',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
  },
});
