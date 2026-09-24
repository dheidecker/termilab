/*
 * Android renderer entry. Installs window.electronAPI (the bridge shim) BEFORE
 * src/ is evaluated: several modules read electronAPI at import time
 * (src/platform.js, Titlebar's platform check), and static imports would be
 * hoisted above the assignment. Hence the dynamic import of src/main.jsx.
 *
 * Also the page's half of the native glue (mobile/plugins/termilab-native):
 * sessions -> foreground service, back button, terminal-scoped keyboard,
 * focused form field kept above the keyboard.
 */
import { registerPlugin, SystemBars, SystemBarsStyle } from '@capacitor/core';
import { Browser } from '@capacitor/browser';
import { NodeJS } from 'capacitor-nodejs';
import { createElectronAPI, capacitorTransport } from './electron-api-shim';
import { handleBack } from '../../src/hooks/useBackHandler';
import './mobile.css';

const TermilabNative = registerPlugin('TermilabNative');
// src/ reaches the plugin only through this (clipboard fallback in
// src/components/Terminal/mobile/clipboard.js); it never imports Capacitor.
window.__termilabNative = TermilabNative;
// Android-only CSS in mobile.css hangs off this attribute.
document.documentElement.dataset.platform = 'android';
let wasSigningIn = false;

const nativeCall = (what, promise) => Promise.resolve(promise).catch(err => console.error(`[termilab] ${what}:`, err && err.message));

window.electronAPI = createElectronAPI(capacitorTransport(NodeJS), {
  // Sync login: a Custom Tab, not the WebView (Google refuses embedded
  // WebViews, and the page must not see the sign-in). Node keeps polling
  // /auth/poll on its own; nothing comes back through the tab.
  onOpenUrl: (url) => {
    if (!/^https:\/\//i.test(url)) { console.error('[termilab] refusing to open a non-https URL'); return; }
    nativeCall('Browser.open', Browser.open({ url }));
  },
  // Open SSH sessions (and a sync login in flight), from Node: either keeps
  // the foreground service up, so Android neither freezes the process nor
  // blocks its network in the background.
  onSessions: (count, signingIn) => {
    nativeCall('setSessionCount', TermilabNative.setSessionCount({ count, signingIn }));
    // The login finished (or failed): take the user out of the Custom Tab.
    if (wasSigningIn && !signingIn) nativeCall('Browser.close', Browser.close());
    wasSigningIn = signingIn;
  },
  onFatal: (err) => console.error('[termilab]', err.message),
});

// ─── Back button ─────────────────────────────────────────────
// Modals and menus first, then App's navigation (src/hooks/useBackHandler.js).
// When nothing takes it we are at Hosts home: to the background, never finish()
// (Node and the open sessions live in this process).
nativeCall('backButton listener', TermilabNative.addListener('backButton', () => {
  if (!handleBack()) nativeCall('exitApp', TermilabNative.exitApp());
}));

// ─── Keyboard: raw only inside the terminal ──────────────────
// TerminalInputWebView gives the IME a key-event connection (no predictive
// text, no composing) only while xterm's textarea has focus; forms keep
// accents, autocorrect and dictation. Decided after the focus has settled, so
// a focusout+focusin pair between two fields is one call, not two.
const isTerminal = el => !!(el && el.classList && el.classList.contains('xterm-helper-textarea'));
let terminalInput = false;
let focusTimer = null;
function syncInputMode() {
  focusTimer = null;
  const on = isTerminal(document.activeElement);
  if (on === terminalInput) return;
  terminalInput = on;
  nativeCall('setTerminalInput', TermilabNative.setTerminalInput({ on }));
}
const scheduleInputMode = () => { if (!focusTimer) focusTimer = setTimeout(syncInputMode, 0); };
document.addEventListener('focusin', scheduleInputMode, true);
document.addEventListener('focusout', scheduleInputMode, true);

// ─── Focused field above the keyboard ────────────────────────
// Capacitor pads the window by the IME height, so the WebView (and the
// visualViewport) shrink when the keyboard opens. The field that has focus
// may now be under it: scroll it back into view once the resize lands.
const isField = el => !!el && !isTerminal(el) && (
  el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

function revealFocused() {
  const el = document.activeElement;
  if (!isField(el)) return;
  const vv = window.visualViewport;
  const bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
  const r = el.getBoundingClientRect();
  if (r.top < 8 || r.bottom > bottom - 8) el.scrollIntoView({ block: 'center', inline: 'nearest' });
}

let revealTimer = null;
const scheduleReveal = (ms) => { clearTimeout(revealTimer); revealTimer = setTimeout(revealFocused, ms); };
document.addEventListener('focusin', (e) => { if (isField(e.target)) scheduleReveal(350); }, true);
if (window.visualViewport) window.visualViewport.addEventListener('resize', () => scheduleReveal(60));
window.addEventListener('resize', () => scheduleReveal(60));

// ─── Layout height follows the visual viewport ───────────────
// The soft keyboard shrinks it (Capacitor pads the window by the IME height);
// the terminal's ResizeObserver then refits and resizes the remote pty.
// Rotation lands here too.
function syncAppHeight() {
  const vv = window.visualViewport;
  const h = Math.round(vv ? vv.height : window.innerHeight);
  document.documentElement.style.setProperty('--app-height', `${h}px`);
  // A focused field can scroll the page itself; the app never scrolls as a whole.
  if (window.scrollY) window.scrollTo(0, 0);
}
syncAppHeight();
if (window.visualViewport) window.visualViewport.addEventListener('resize', syncAppHeight);
window.addEventListener('resize', syncAppHeight);
window.addEventListener('orientationchange', () => setTimeout(syncAppHeight, 250));

// ─── System bars follow the app theme ────────────────────────
// AppContext stamps data-theme on <html>. Icons light on dark and vice versa,
// and the window behind the bars (visible where Capacitor pads the WebView)
// takes the app background instead of the theme's white.
function syncSystemBars() {
  const light = document.documentElement.dataset.theme === 'light';
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim();
  nativeCall('SystemBars.setStyle', SystemBars.setStyle({ style: light ? SystemBarsStyle.Light : SystemBarsStyle.Dark }));
  if (/^#[0-9a-f]{6}$/i.test(bg)) nativeCall('setWindowBackground', TermilabNative.setWindowBackground({ color: bg }));
}
new MutationObserver(syncSystemBars).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
syncSystemBars();
// A rotation re-applies the window's theme (white behind the bars, dark icons):
// set both again once it settles.
let barsTimer = null;
window.addEventListener('orientationchange', () => { clearTimeout(barsTimer); barsTimer = setTimeout(syncSystemBars, 400); });
window.matchMedia('(orientation: landscape)').addEventListener('change', () => { clearTimeout(barsTimer); barsTimer = setTimeout(syncSystemBars, 400); });
// Any other configuration change that resizes the window (display size,
// split screen) does the same.
window.addEventListener('resize', () => { clearTimeout(barsTimer); barsTimer = setTimeout(syncSystemBars, 400); });

import('../../src/main.jsx');
