import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  plugins: [react(), tailwindcss()],
  build: { outDir: new URL('../dist/web', import.meta.url).pathname, emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 900 },
  // In dev, proxy the API to a running `dashboard` (DASHBOARD_URL=http://127.0.0.1:PORT).
  server: { proxy: { '/api': process.env.DASHBOARD_URL ?? 'http://127.0.0.1:4317' } },
});
