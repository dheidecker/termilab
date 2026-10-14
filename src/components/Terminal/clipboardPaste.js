/*
 * The terminal's clipboard: every copy and every paste of a terminal goes
 * through here (keys, right-click, middle-click, copy-on-select, the Android
 * buttons). One path, so they cannot drift apart again.
 *
 * Desktop: Electron's `clipboard` in main over IPC (window.electronAPI.clipboard).
 *   navigator.clipboard rejects when the document is not focused (a
 *   right-click that is focusing the window, DevTools, another window) and
 *   the old code pasted nothing then, silently.
 * Android / plain browser: no electronAPI.clipboard (the shim omits it):
 *   navigator.clipboard with the native plugin as fallback (mobile/clipboard.js).
 *
 * THE SEAM (image attach builds on it):
 *   pasteInto(term, { onImage, confirm, source, paste })
 *     text on the clipboard  -> pasted as text (term.paste: bracketed paste,
 *                               newline -> CR), never the image;
 *     no text, but an image  -> onImage({ png: Uint8Array, mime }) if given,
 *                               otherwise nothing;
 *     resolves { kind: 'text' | 'image' | 'empty' | 'cancelled' }.
 */
import { readClipboard as mobileRead, writeClipboard as mobileWrite } from './mobile/clipboard';

const desktop = () => (typeof window !== 'undefined' && window.electronAPI && window.electronAPI.clipboard) || null;

/** which: 'clipboard' or 'selection' (Linux PRIMARY; '' where there is none) */
export async function readText(which = 'clipboard') {
  const c = desktop();
  if (c) {
    try {
      const t = await c.readText(which);
      return typeof t === 'string' ? t : '';
    } catch (_) { return ''; }
  }
  return which === 'selection' ? '' : mobileRead();
}

/**
 * Writes `text` to the clipboard (unless clipboard:false) and, on Linux, to
 * PRIMARY too when selection:true. Resolves true if the clipboard got it.
 */
export async function writeText(text, { clipboard = true, selection = false } = {}) {
  if (!text) return false;
  const c = desktop();
  if (c) {
    try {
      await c.writeText(text, { clipboard, selection });
      return true;
    } catch (_) { return false; }
  }
  if (!clipboard) return false;
  return mobileWrite(text);
}

/** { png: Uint8Array, mime } or null */
export async function readImage() {
  const c = desktop();
  if (c) {
    try {
      if (!(await c.hasImage())) return null;
      const img = await c.readImage();
      if (!img || !img.png) return null;
      return { png: img.png instanceof Uint8Array ? img.png : new Uint8Array(img.png), mime: img.mime || 'image/png' };
    } catch (_) { return null; }
  }
  try {
    if (typeof navigator === 'undefined' || !navigator.clipboard || !navigator.clipboard.read) return null;
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => /^image\//i.test(t));
      if (!type) continue;
      const blob = await item.getType(type);
      return { png: new Uint8Array(await blob.arrayBuffer()), mime: type };
    }
  } catch (_) { /* not allowed here */ }
  return null;
}

/**
 * What a paste sends, before xterm turns \n into CR and brackets it:
 *  - CRLF and lone CR become \n (a Windows text pasted \r\r: two Enters);
 *  - the bracketed-paste markers themselves are removed, so a copied text
 *    cannot close the bracket early and run the rest as typed commands.
 */
export function normalizePaste(text) {
  return String(text || '')
    .replace(/\x1b\[20[01]~/g, '')
    .replace(/\r\n?/g, '\n');
}

/** Lines a paste has (a trailing newline does not start another one) */
export function pasteLines(text) {
  const parts = String(text || '').split('\n');
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

/**
 * Pasting text with a newline into a program that did NOT ask for bracketed
 * paste runs each line as it arrives: that is what deserves a question.
 */
export function pasteNeedsConfirm(term, text) {
  const bracketed = !!(term && term.modes && term.modes.bracketedPasteMode);
  return !bracketed && String(text || '').includes('\n');
}

/**
 * Paste the clipboard (or Linux PRIMARY with source:'selection') into an
 * xterm. Options:
 *   onImage(img)  called with { png, mime } when there is no text but an image;
 *   confirm({ lines, chars, text }) -> Promise<boolean>, asked for a multi-line
 *                 paste into a program without bracketed paste;
 *   source        'clipboard' (default) or 'selection';
 *   paste(text)   how to hand the text to the terminal (default term.paste).
 */
export async function pasteInto(term, { onImage, confirm, source = 'clipboard', paste } = {}) {
  if (!term) return { kind: 'empty' };
  const raw = await readText(source);
  if (raw) {
    const text = normalizePaste(raw);
    if (!text) return { kind: 'empty' };
    if (typeof confirm === 'function' && pasteNeedsConfirm(term, text)) {
      const ok = await confirm({ lines: pasteLines(text), chars: text.length, text });
      if (!ok) return { kind: 'cancelled' };
    }
    try {
      (typeof paste === 'function' ? paste : (t) => term.paste(t))(text);
    } catch (_) { return { kind: 'empty' }; }   // the terminal went away meanwhile
    return { kind: 'text', chars: text.length };
  }
  if (source === 'clipboard' && typeof onImage === 'function') {
    const img = await readImage();
    if (img && img.png && img.png.length) {
      await onImage(img);
      return { kind: 'image' };
    }
  }
  return { kind: 'empty' };
}

/**
 * The selection as text to copy: xterm's own getSelection() (wrapped rows
 * joined into one line, empty cells trimmed), plus the trailing spaces many
 * programs paint to the end of a row (tmux, vim, htop) trimmed per line.
 */
export function selectionText(term) {
  if (!term || !term.hasSelection || !term.hasSelection()) return '';
  const raw = term.getSelection() || '';
  return raw.replace(/[  ]+(?=\r?\n|$)/g, '');
}

/**
 * Copies the terminal's selection. The text is taken NOW (synchronously), so
 * the caller may clear the selection right after calling this. Resolves with
 * { text, copied }: copied = the clipboard got it (false for PRIMARY only).
 */
export function copySelection(term, { clipboard = true, selection = true } = {}) {
  const text = selectionText(term);
  if (!text) return Promise.resolve({ text: '', copied: false });
  return writeText(text, { clipboard, selection })
    .then((ok) => ({ text, copied: !!ok && clipboard }));
}
