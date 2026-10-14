/*
 * Prompt composer: a multi-line box docked at the bottom of a terminal pane,
 * for writing a long message to Claude Code (or any program) with a real text
 * editor (mouse caret, selection, undo, IME) instead of the program's own
 * line editor.
 *
 * Ctrl+Enter (or Send) hands the whole text to the terminal as ONE paste
 * (term.paste → bracketed paste when the program asked for it, so an agent
 * receives a single block), then Enter if "Send Enter" is on. The paste is
 * done by the owner (TerminalView), which keeps it out of broadcast.
 *
 * Esc closes and keeps the draft. Ctrl+Shift+E hands the keyboard back to the
 * terminal (the terminal's Ctrl+Shift+E brings it here again). Drafts live
 * per tab in memory and per sessionKey in localStorage, so a restored tab
 * finds its draft again.
 *
 * Images pasted or dropped here are attached (saved/uploaded by
 * imageAttach.js) and their path goes into THIS text at the caret, not into
 * the terminal.
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { normalizePaste } from './clipboardPaste';
import { isFilesDrag } from './imageAttach';
import { useBackHandler } from '../../hooks/useBackHandler';
import './Composer.css';

const DRAFT_PREFIX = 'termilab.composer.draft.';
const SIZE_KEY = 'termilab.composer.size';
const ENTER_KEY = 'termilab.composer.sendEnter';
const MAX_STORED = 200 * 1024;
const DEFAULT_FRACTION = 0.3;
const MIN_PX = 76;

/* Per tab, this window's memory: survives closing and reopening the box */
const drafts = new Map();

const lsGet = (k) => { try { return window.localStorage.getItem(k); } catch (_) { return null; } };
const lsSet = (k, v) => {
  try {
    if (v === null || v === '') window.localStorage.removeItem(k);
    else window.localStorage.setItem(k, v);
  } catch (_) { /* storage full or blocked: memory still has it */ }
};

export function loadDraft(tabId, sessionKey) {
  if (drafts.has(tabId)) return drafts.get(tabId);
  return (sessionKey && lsGet(DRAFT_PREFIX + sessionKey)) || '';
}

function saveDraft(tabId, sessionKey, text) {
  if (text) drafts.set(tabId, text); else drafts.delete(tabId);
  if (sessionKey) lsSet(DRAFT_PREFIX + sessionKey, text && text.length <= MAX_STORED ? text : null);
}

/** Text as it goes to the terminal: CRLF → LF, no paste markers, no trailing newlines */
export function composedText(text) {
  return normalizePaste(text).replace(/\n+$/, '');
}

const readFraction = () => {
  const v = parseFloat(lsGet(SIZE_KEY));
  return v > 0.05 && v < 0.95 ? v : null;
};

/* Image files among clipboard / drop items */
const imageFiles = (list) => [...(list || [])].filter(f => f && /^image\//.test(f.type || ''));

/**
 * Props:
 *   tab           the pane's tab (id, sessionKey)
 *   color         the pane's colour (accent), or null for the app accent
 *   focusSignal   a number; each change focuses the textarea
 *   onSend(text, enter) → boolean   paste into the terminal (true = sent)
 *   onAttach(items, { paste, onStatus })  attach images (null = unsupported)
 *   onClose()     Esc / ×: close, the draft stays
 *   onFocusTerminal()   Ctrl+Shift+E: keyboard back to the terminal
 *   mobile        Android: no shortcuts hint, back button closes
 */
export default function Composer({ tab, color, focusSignal, onSend, onAttach, onClose, onFocusTerminal, mobile = false }) {
  const sessionKey = tab.sessionKey || tab.id;
  const [text, setText] = useState(() => loadDraft(tab.id, sessionKey));
  const [sendEnter, setSendEnter] = useState(() => lsGet(ENTER_KEY) !== 'false');
  const [fraction, setFraction] = useState(readFraction);   // null = auto-grow
  const [status, setStatus] = useState(null);
  const [dropOver, setDropOver] = useState(false);
  const taRef = useRef(null);
  const panelRef = useRef(null);
  const statusTimer = useRef(null);

  useEffect(() => { saveDraft(tab.id, sessionKey, text); }, [text, tab.id, sessionKey]);
  useEffect(() => () => clearTimeout(statusTimer.current), []);

  /* Focus on open and on every Ctrl+Shift+E from the terminal */
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.focus({ preventScroll: true });
  }, [focusSignal]);

  /* Auto-grow: the textarea follows its content up to ~30% of the pane;
     a size dragged with the handle is fixed instead (double-click: auto) */
  const fit = useCallback(() => {
    const ta = taRef.current;
    const panel = panelRef.current;
    if (!ta || !panel) return;
    const paneH = panel.parentElement ? panel.parentElement.clientHeight : 0;
    const chrome = panel.offsetHeight - ta.offsetHeight;
    if (fraction) {
      ta.style.height = `${Math.max(MIN_PX, Math.round(paneH * fraction) - chrome)}px`;
      return;
    }
    const max = Math.max(MIN_PX, Math.round(paneH * DEFAULT_FRACTION) - chrome);
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(max, Math.max(MIN_PX, ta.scrollHeight + 2))}px`;
  }, [fraction]);
  useLayoutEffect(() => { fit(); }, [text, fit]);
  useEffect(() => {
    const parent = panelRef.current && panelRef.current.parentElement;
    if (!parent || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => fit());
    ro.observe(parent);
    return () => ro.disconnect();
  }, [fit]);

  /* Drag the top edge to resize; the size is shared by every composer */
  const startResize = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const panel = panelRef.current;
    const parent = panel && panel.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const bottom = panel.getBoundingClientRect().bottom;
    let last = fraction;
    const move = (ev) => {
      const h = bottom - ev.clientY;
      last = Math.min(0.85, Math.max(MIN_PX / rect.height, h / rect.height));
      setFraction(last);
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('composer-resizing');
      if (last) lsSet(SIZE_KEY, String(last));
    };
    document.body.classList.add('composer-resizing');
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };
  const autoSize = () => { setFraction(null); lsSet(SIZE_KEY, null); };

  const showStatus = (st) => {
    clearTimeout(statusTimer.current);
    setStatus(st);
    if (st && st.kind === 'error') statusTimer.current = setTimeout(() => setStatus(null), 6000);
  };

  /* Insert at the caret through the editing pipeline, so Ctrl+Z undoes it */
  const insertAtCaret = (str, at) => {
    const ta = taRef.current;
    if (!ta) return;
    ta.focus({ preventScroll: true });
    if (at) ta.setSelectionRange(at.start, at.end);
    const before = ta.value.slice(0, ta.selectionStart);
    const lead = before && !/\s$/.test(before) ? ' ' : '';
    let done = false;
    try { done = document.execCommand('insertText', false, lead + str); } catch (_) { done = false; }
    if (!done) {
      ta.setRangeText(lead + str, ta.selectionStart, ta.selectionEnd, 'end');
      setText(ta.value);
    }
  };

  const attach = (files) => {
    if (!onAttach || !files.length) return;
    const ta = taRef.current;
    const at = ta ? { start: ta.selectionStart, end: ta.selectionEnd } : null;
    onAttach(files, { onStatus: showStatus, paste: (paths) => insertAtCaret(paths, at) });
  };

  const send = () => {
    const out = composedText(text);
    if (!out) return;
    if (onSend(out, sendEnter) === false) return;
    setText('');
    saveDraft(tab.id, sessionKey, '');
    onClose('sent');
  };

  const onKeyDown = (e) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      send();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose('esc');
      return;
    }
    if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'KeyE') {
      e.preventDefault();
      e.stopPropagation();
      onFocusTerminal();
      return;
    }
    /* The pane's Ctrl+Shift+F (search) is for the terminal, not this box */
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyF') e.stopPropagation();
  };

  const onPaste = (e) => {
    const cd = e.clipboardData;
    if (!cd || !onAttach) return;
    /* Text wins, as in the terminal */
    if (cd.types && [...cd.types].includes('text/plain') && cd.getData('text/plain')) return;
    const files = imageFiles(cd.files && cd.files.length ? cd.files : [...(cd.items || [])].filter(i => i.kind === 'file').map(i => i.getAsFile()));
    if (!files.length) return;
    e.preventDefault();
    attach(files);
  };

  /* Files dropped here are for this box, not for the terminal around it */
  const dropProps = onAttach ? {
    onDragEnter: (e) => { if (isFilesDrag(e)) { e.preventDefault(); e.stopPropagation(); setDropOver(true); } },
    onDragOver: (e) => {
      if (!isFilesDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      if (!dropOver) setDropOver(true);
    },
    onDragLeave: (e) => {
      if (e.currentTarget.contains(e.relatedTarget)) return;
      e.stopPropagation();
      setDropOver(false);
    },
    onDrop: (e) => {
      if (!isFilesDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setDropOver(false);
      const all = [...(e.dataTransfer.files || [])];
      attach(all);
    },
  } : {};

  useBackHandler(mobile, () => { onClose('back'); return true; });

  const toggleEnter = () => {
    setSendEnter((v) => { lsSet(ENTER_KEY, String(!v)); return !v; });
  };

  const empty = !composedText(text);
  return (
    <div
      ref={panelRef}
      className={`composer${dropOver ? ' drop-over' : ''}${mobile ? ' mobile' : ''}`}
      style={color ? { '--composer-accent': color } : undefined}
      role="region"
      aria-label="Compose message"
      {...dropProps}
    >
      {!mobile && (
        <div
          className="composer-resize"
          onMouseDown={startResize}
          onDoubleClick={autoSize}
          title="Drag to resize · double-click to fit the text"
          aria-hidden="true"
        />
      )}
      <textarea
        ref={taRef}
        className="composer-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        placeholder={mobile ? 'Write a message…' : 'Write a message… Ctrl+Enter sends it as one block'}
        spellCheck
        aria-label="Message"
      />
      <div className="composer-bar">
        <label className="composer-enter" title="Press Enter after the text (otherwise it is only typed)" onMouseDown={(e) => e.preventDefault()}>
          <input type="checkbox" checked={sendEnter} onChange={toggleEnter} />
          <span>Send Enter</span>
        </label>
        {status
          ? <span className={`composer-status${status.kind === 'error' ? ' error' : ''}`} role="status">{status.text}</span>
          : !mobile && <span className="composer-hint">Esc closes · Ctrl+Shift+E terminal</span>}
        <span className="composer-spacer" />
        <button type="button" className="composer-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => onClose('button')} title="Close (Esc); the draft is kept">
          Close
        </button>
        <button type="button" className="composer-btn primary" onMouseDown={(e) => e.preventDefault()} onClick={send} disabled={empty} title="Send (Ctrl+Enter)">
          Send
        </button>
      </div>
    </div>
  );
}

/** The pane toolbar's button: opens / closes this pane's composer */
export function ComposeButton({ open, onClick }) {
  return (
    <button
      type="button"
      className={`session-log-toggle composer-toggle${open ? ' open' : ''}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      title={open ? 'Close composer (Esc)' : 'Compose a message (Ctrl+Shift+E)'}
      aria-pressed={open}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" />
      </svg>
      <span>Compose</span>
    </button>
  );
}
