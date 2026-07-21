// Browser dev server for the renderer (fast HMR loop, no Electron, WSL-friendly).
//
// Usage (two terminals):
//   1) CLAUDE_ROOT=~/.claude PORT=3456 pnpm standalone   # API + SSE on :3456
//   2) pnpm web                                          # renderer HMR on :5174
// Then open:  http://localhost:5174/?port=3456
//
// The `?port=3456` tells the renderer's API client (src/renderer/api/index.ts
// getHttpBaseUrl) to hit http://127.0.0.1:3456 directly; the standalone server
// sends permissive CORS, so no proxy is required.
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main'),
    },
  },
  server: {
    port: 5174,
    strictPort: true,
  },
});
