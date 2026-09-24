import React, { useCallback, useRef, useState } from 'react';
import { EXTRA_KEYS, tapModifier, afterUse } from './keys';
import { PasteIcon, ArrowLeftIcon } from '../../Icons/icons';

/* The arrow glyphs (← →) are tiny in most mono fonts: draw them */
const ARROW_TURN = { left: 0, up: 90, right: 180, down: 270 };

/*
 * Sticky Ctrl/Alt shared by the row and the soft keyboard. The ref is what the
 * terminal's input path reads synchronously; the state only repaints buttons.
 */
export function useStickyModifiers() {
  const ref = useRef({ ctrl: 'off', alt: 'off', tapAt: { ctrl: 0, alt: 0 } });
  const [, repaint] = useState(0);

  const tap = useCallback((name) => {
    const now = Date.now();
    const m = ref.current;
    m[name] = tapModifier(m[name], m.tapAt[name], now);
    m.tapAt[name] = now;
    repaint(n => n + 1);
  }, []);

  /* What is armed right now, without spending it. */
  const peek = useCallback(() => ({ ctrl: ref.current.ctrl !== 'off', alt: ref.current.alt !== 'off' }), []);

  /* A key used the modifiers: spend the one-shot ones. */
  const spend = useCallback(() => {
    const m = ref.current;
    const next = { ctrl: afterUse(m.ctrl), alt: afterUse(m.alt) };
    if (next.ctrl !== m.ctrl || next.alt !== m.alt) {
      m.ctrl = next.ctrl;
      m.alt = next.alt;
      repaint(n => n + 1);
    }
  }, []);

  return { state: ref.current, tap, peek, spend };
}

/* Taps must not take the focus away from xterm's textarea, or the soft
   keyboard closes on every key. preventDefault on mousedown keeps it; the
   action runs on click, so a horizontal scroll of the row presses nothing. */
const keepFocus = (e) => e.preventDefault();

export default function ExtraKeys({ modifiers, onKey, onPaste }) {
  const { state } = modifiers;
  return (
    <div className="m-extra-keys" role="toolbar" aria-label="Extra keys">
      <div className="m-extra-keys-scroll">
        {EXTRA_KEYS.map(k => {
          const mod = k.modifier ? state[k.id] : null;
          return (
            <button
              key={k.id}
              type="button"
              tabIndex={-1}
              className={`m-key${k.id in ARROW_TURN ? ' m-key-icon' : ''}${mod && mod !== 'off' ? ' m-key-armed' : ''}${mod === 'locked' ? ' m-key-locked' : ''}`}
              aria-label={k.aria || k.label}
              aria-pressed={k.modifier ? mod !== 'off' : undefined}
              onMouseDown={keepFocus}
              onClick={() => (k.modifier ? modifiers.tap(k.id) : onKey(k.id))}
            >
              {k.id in ARROW_TURN
                ? <ArrowLeftIcon style={{ transform: `rotate(${ARROW_TURN[k.id]}deg)` }} />
                : k.label}
            </button>
          );
        })}
        <button
          type="button"
          tabIndex={-1}
          className="m-key m-key-icon"
          aria-label="Paste"
          onMouseDown={keepFocus}
          onClick={onPaste}
        >
          <PasteIcon />
        </button>
      </div>
    </div>
  );
}
