import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // Apache serves this directory as DocumentRoot.
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    // Development only. In production Apache does this proxying instead,
    // so the client always talks to a same-origin /api and never needs to
    // know where the Node process actually is.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: false,
      },
    },
  },
});
