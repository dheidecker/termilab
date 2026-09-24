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

/* Android v1 leaves these out (docs/android-plan.md). The shim does not even
   expose their namespaces, so an ungated entry point would throw. */
export const FEATURES = {
  windowControls: !IS_ANDROID,      // the activity owns the window
  portForwarding: !IS_ANDROID,
  sftp: !IS_ANDROID,
  localTerminal: !IS_ANDROID,       // no pty on Android
  splitPanes: !IS_ANDROID,
  knownHostsFileImport: !IS_ANDROID, // reads ~/.ssh/known_hosts
  keyFileImport: !IS_ANDROID,       // needs a native file dialog
};
