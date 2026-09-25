import React, { useEffect, useRef, useState } from 'react';
import { MAX_ALIAS } from './layoutTree';
import './InlineRename.css';

/*
 * In-place editor for a terminal's session alias (pane header, tab, Android
 * session header). Focused and selected on mount. Enter or blur saves, Esc
 * cancels; an empty value saves as "no alias" (back to the host label).
 *
 * `onDone(text | null, how)`: text is null when cancelled; `how` is 'key' for
 * Enter/Esc (the caller may hand the keyboard back to the terminal) and
 * 'blur' when the user went elsewhere (leave the focus where it went).
 *
 * The window losing focus (another app, DevTools) blurs the input too; that
 * is not "done", so it keeps editing. Mouse and key events stop here: the
 * input lives inside draggable, clickable tabs and pane headers.
 */
export default function InlineRename({ value, placeholder, className, ariaLabel, onDone }) {
  const [text, setText] = useState(value || '');
  const ref = useRef(null);
  const finished = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.select();
  }, []);

  const finish = (result, how) => {
    if (finished.current) return;
    finished.current = true;
    onDone(result, how);
  };

  const stop = (e) => e.stopPropagation();

  return (
    <input
      ref={ref}
      className={`inline-rename${className ? ` ${className}` : ''}`}
      value={text}
      maxLength={MAX_ALIAS}
      placeholder={placeholder}
      aria-label={ariaLabel || 'Session name'}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); finish(text, 'key'); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(null, 'key'); }
      }}
      onBlur={() => {
        if (typeof document !== 'undefined' && !document.hasFocus()) return;
        finish(text, 'blur');
      }}
      onMouseDown={stop}
      onClick={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
      onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
    />
  );
}
