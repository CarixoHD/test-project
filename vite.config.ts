import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The SPA lives in src/web and builds to dist/web, which the server serves in production.
// Dev-server host, port and the /api proxy are set by scripts/dev.mjs.
export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
});
