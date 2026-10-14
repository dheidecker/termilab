/*
 * Clipboard for the terminal on Android. The WebView's async clipboard API
 * needs a user gesture (the paste/copy buttons are one); when it refuses, the
 * native plugin does it (TermilabNative.readClipboard / writeClipboard).
 */
const native = () => (typeof window !== 'undefined' ? window.__termilabNative : null);

export async function readClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    /* An empty answer is not proof the clipboard is empty (a WebView without
       focus/permission may answer ''): ask the native side too */
    if (typeof text === 'string' && text) return text;
  } catch { /* not allowed here: try native */ }
  const n = native();
  if (!n) return '';
  try {
    const r = await n.readClipboard();
    return (r && typeof r.text === 'string') ? r.text : '';
  } catch { return ''; }
}

export async function writeClipboard(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* try native */ }
  /* No plugin (a plain browser): say it failed instead of claiming success */
  const n = native();
  if (!n) return false;
  try {
    await n.writeClipboard({ text });
    return true;
  } catch { return false; }
}
