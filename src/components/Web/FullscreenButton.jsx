import React, { useEffect, useState } from 'react';
import { canFullscreen, keyboardLockSupported, toggleFullscreen, webShortcuts } from './webKeys';
import './PcSwitcher.css';

/*
 * Web mirror only: full screen for the browser tab. Entering it also locks
 * the keyboard where the browser can (Chromium: navigator.keyboard.lock), so
 * Ctrl+T / Ctrl+Tab are the app's again and Ctrl+W reaches the shell. The
 * tooltip lists the Alt+Shift keys that work without it.
 */
export default function FullscreenButton() {
  const [full, setFull] = useState(() => typeof document !== 'undefined' && !!document.fullscreenElement);
  useEffect(() => {
    const on = () => setFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  if (!canFullscreen()) return null;
  const keys = webShortcuts().map(([k, what]) => `${k}: ${what}`).join('\n');
  const title = full
    ? `Exit full screen${keyboardLockSupported() ? ' (or hold Esc)' : ''}`
    : `Full screen${keyboardLockSupported() ? ': Ctrl+T, Ctrl+W and Ctrl+Tab go to Termilab' : ''}\n\n${keys}`;
  return (
    <button
      type="button"
      className="web-fullscreen-btn"
      onClick={() => { toggleFullscreen().then(setFull).catch(() => {}); }}
      aria-label={full ? 'Exit full screen' : 'Full screen'}
      aria-pressed={full}
      title={title}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {full ? (
          <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
        ) : (
          <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
        )}
      </svg>
    </button>
  );
}
