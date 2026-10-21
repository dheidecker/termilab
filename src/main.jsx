import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { installFileDropGuard } from './utils/fileDropGuard';

installFileDropGuard();

/* The terminal font is bundled; load it before the first xterm measures
   its cell, so no terminal starts on fallback metrics (TerminalView also
   re-measures when fonts arrive later). Never waits more than 1 s. */
const fontsReady = document.fonts && document.fonts.load
  ? Promise.race([
    Promise.all(['400 14px "JetBrains Mono"', '700 14px "JetBrains Mono"'].map(f => document.fonts.load(f))).catch(() => {}),
    new Promise(r => setTimeout(r, 1000)),
  ])
  : Promise.resolve();

fontsReady.then(() => ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
));
