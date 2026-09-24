/*
 * Clipboard for the terminal on Android. The WebView's async clipboard API
 * needs a user gesture (the paste/copy buttons are one); when it refuses, the
 * native plugin does it (TermilabNative.readClipboard / writeClipboard).
 */
const native = () => (typeof window !== 'undefined' ? window.__termilabNative : null);

export async function readClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (typeof text === 'string') return text;
  } catch { /* not allowed here: try native */ }
  try {
    const r = await native()?.readClipboard();
    return (r && typeof r.text === 'string') ? r.text : '';
  } catch { return ''; }
}

export async function writeClipboard(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* try native */ }
  try {
    await native()?.writeClipboard({ text });
    return true;
  } catch { return false; }
}
