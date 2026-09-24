/*
 * Android renderer entry. Installs window.electronAPI (the bridge shim) BEFORE
 * src/ is evaluated: several modules read electronAPI at import time
 * (src/platform.js, Titlebar's platform check), and static imports would be
 * hoisted above the assignment. Hence the dynamic import of src/main.jsx.
 */
import { NodeJS } from 'capacitor-nodejs';
import { createElectronAPI, capacitorTransport } from './electron-api-shim';
import './mobile.css';

window.electronAPI = createElectronAPI(capacitorTransport(NodeJS), {
  // Phase 3 swaps this for a Custom Tab (sync login).
  onOpenUrl: (url) => window.open(url, '_blank'),
  onFatal: (err) => console.error('[termilab]', err.message),
});

import('../../src/main.jsx');
