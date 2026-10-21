/*
 * Renderer build for the web mirror: the desktop app served by the desktop
 * app itself (electron/web/server.js) to the owner's browser on the tailnet.
 * Same src/, no Electron plugins. Entry: web/index.html -> entry.jsx;
 * window.electronAPI comes from /termilab-preload.js, which the server builds
 * at runtime from electron/preload.js (not part of this bundle).
 *
 *   npm run web:build      -> dist-web/  (shipped by electron-builder)
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  root: path.resolve(__dirname, 'web'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist-web'),
    emptyOutDir: true,
    // Nothing inline: the server's CSP is script-src 'self'.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
});
