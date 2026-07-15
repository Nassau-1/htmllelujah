import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import electron from 'vite-plugin-electron/simple';

const projectDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: projectDirectory,
  plugins: [
    react(),
    electron({
      main: {
        entry: {
          main: 'src/main/main.ts',
          'mcp-cli': 'src/main/mcp-cli.ts',
        },
        vite: {
          resolve: {
            // @peculiar's ESM build imports tslib through a CommonJS-shaped package entry.
            // Pinning its native ESM helper prevents default-export interop drift in Rolldown.
            alias: {
              tslib: path.join(projectDirectory, 'node_modules', 'tslib', 'tslib.es6.js'),
            },
          },
        },
      },
      preload: {
        input: 'src/preload/preload.ts',
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.join(projectDirectory, 'src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
});
