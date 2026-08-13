import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Keep in sync with the tsconfig "paths" mapping so both the type
      // checker and the bundler resolve the shared contracts package.
      '@devops-observatory/shared-types': fileURLToPath(
        new URL('./packages/shared-types/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
