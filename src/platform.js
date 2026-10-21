/*
 * Which platform the renderer is running on, and what that platform can do.
 *
 * `window.electronAPI.platform` is set synchronously by electron/preload.js on
 * desktop and by mobile/web/electron-api-shim.js on Android ('android'), before
 * any of src/ is evaluated. In a plain browser (mock mode) there is no API.
 *
 * Desktop behaviour must not change: every flag is true unless IS_ANDROID.
 */
export const PLATFORM = (typeof window !== 'undefined' && window.electronAPI?.platform) || 'web';
export const IS_ANDROID = PLATFORM === 'android';
/* The web mirror (Termilab served by the PC to a browser, electron/web/):
   electron-stub.js sets __termilabWeb before preload runs. A mirror of a PC
   window: its tabs come from the PC (mirror:state), its terminals join the
   PC's sessions, and every change is an order to the PC (mirror:command). */
export const IS_WEB = typeof window !== 'undefined' && window.__termilabWeb === true
  && typeof window.electronAPI?.mirror?.state === 'function';

/* Android v1 leaves these out (docs/android-plan.md). The shim does not even
   expose their namespaces, so an ungated entry point would throw. */
export const FEATURES = {
  windowControls: !IS_ANDROID && !IS_WEB,   // the activity / the browser owns the window
  portForwarding: !IS_ANDROID && !IS_WEB,   // the web omits portForward/sftp
  sftp: !IS_ANDROID && !IS_WEB,
  localTerminal: !IS_ANDROID,       // no pty on Android
  /* Kept local sessions (local keeper): Linux desktop only */
  localKeeper: !IS_WEB && PLATFORM === 'linux' && typeof window !== 'undefined' && typeof window.electronAPI?.localShell?.keeperList === 'function',
  splitPanes: !IS_ANDROID,
  knownHostsFileImport: !IS_ANDROID, // reads ~/.ssh/known_hosts
  keyFileImport: !IS_ANDROID,       // needs a native file dialog
  /* Several windows, tabs moving between them: only a main process that has
     the window:move-* channels (the shim omits `window` entirely) */
  multiWindow: !IS_ANDROID && !IS_WEB && typeof window !== 'undefined' && typeof window.electronAPI?.window?.moveBegin === 'function',
};

/* What the sync and unlock copy calls the machine it runs on. Desktop keeps
   "computer" word for word; a phone is a "device". */
export const MACHINE = IS_ANDROID ? 'device' : 'computer';
export const MACHINES = IS_ANDROID ? 'devices' : 'computers';
export const MACHINE_TITLE = IS_ANDROID ? 'Device' : 'Computer';
