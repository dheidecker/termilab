/*
 * Renderer build for Android (Capacitor). Same src/ as desktop, no Electron
 * plugins. Entry: mobile/web/index.html -> entry.jsx, which installs the
 * window.electronAPI shim before loading src/main.jsx.
 *
 *   npm run mobile:web      -> dist-mobile/  (Capacitor's webDir)
 *
 * It empties dist-mobile/, so the Node bundle (npm run mobile:node, into
 * dist-mobile/nodejs/) must be built after it. `npm run android:sync` does both.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  root: path.resolve(__dirname, 'mobile/web'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist-mobile'),
    emptyOutDir: true,
    // Android System WebView is evergreen; Capacitor 8 needs Chrome 108+ anyway.
    target: 'chrome108',
  },
});
