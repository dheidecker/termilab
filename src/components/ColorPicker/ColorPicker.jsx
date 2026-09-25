import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { HOST_COLORS, validColor } from '../HostList/hostColor';
import { CheckIcon } from '../Icons/icons';
import { useBackHandler } from '../../hooks/useBackHandler';
import './ColorPicker.css';

/*
  The one colour picker of the app: round swatches, no names to type or read
  (the name is only the tooltip / screen-reader label). "None" is the first
  swatch, drawn as an empty circle with a slash. Used inline in HostForm and,
  wrapped in ColorPopover, from the pane header, the active tab and the host
  card's context menu.
*/
export function ColorSwatches({ value, onPick, disabled = false, autoFocus = false, label = 'Color' }) {
  const current = validColor(value);
  const firstRef = useRef(null);
  useEffect(() => { if (autoFocus) firstRef.current?.focus({ preventScroll: true }); }, [autoFocus]);
  const options = [{ id: 'none', name: 'No color', hex: null }, ...HOST_COLORS];
  return (
    <div className="color-swatches" role="radiogroup" aria-label={label}>
      {options.map(o => {
        const selected = (o.hex || null) === current;
        return (
          <button
            key={o.id}
            ref={selected ? firstRef : undefined}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={o.name}
            title={o.name}
            disabled={disabled}
            className={`color-swatch${o.hex ? '' : ' none'}${selected ? ' selected' : ''}`}
            style={o.hex ? { '--swatch': o.hex } : undefined}
            onClick={() => onPick(o.hex)}
          >
            {selected && o.hex && <CheckIcon className="color-swatch-check" strokeWidth={3} />}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Swatches in a floating box next to `anchor` (a DOMRect-like {left, top,
 * right, bottom}). Rendered in <body> with position:fixed, so the tab strip's
 * overflow and the title bar's drag region cannot clip or swallow it.
 * One click calls `onPick(hex|null)`; when that resolves the popover closes,
 * when it rejects the message stays in the box (e.g. main refusing a host
 * sealed by another device). Esc, a click outside or Android back close it.
 * `ignoreEl`: the button that opened it, so its own click can toggle it shut.
 */
export function ColorPopover({ anchor, value, onPick, onClose, title, ignoreEl }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: anchor.left, top: anchor.bottom + 6, ready: false });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useBackHandler(true, onClose);

  /* Keep it on screen: below the anchor if it fits, else above; clamp x */
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const m = 8;
    let left = Math.min(anchor.left, window.innerWidth - width - m);
    left = Math.max(m, left);
    let top = anchor.bottom + 6;
    if (top + height > window.innerHeight - m) top = Math.max(m, anchor.top - height - 6);
    setPos({ left, top, ready: true });
  }, [anchor.left, anchor.top, anchor.bottom, error]);

  useEffect(() => {
    const down = (e) => {
      if (ref.current?.contains(e.target)) return;
      if (ignoreEl && ignoreEl.contains(e.target)) return;
      onClose();
    };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('mousedown', down, true);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('mousedown', down, true);
      document.removeEventListener('keydown', key, true);
    };
  }, [onClose, ignoreEl]);

  const pick = async (hex) => {
    setBusy(true);
    setError(null);
    try {
      await onPick(hex);
      if (alive.current) onClose();
    } catch (err) {
      if (alive.current) setError(err?.message || 'Could not change the color');
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return createPortal(
    <div
      ref={ref}
      className="color-popover"
      role="dialog"
      aria-label={title || 'Color'}
      style={{ left: pos.left, top: pos.top, visibility: pos.ready ? 'visible' : 'hidden' }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {title && <div className="color-popover-title">{title}</div>}
      <ColorSwatches value={value} onPick={pick} disabled={busy} autoFocus label={title || 'Color'} />
      {error && <div className="color-popover-error" role="alert">{error}</div>}
    </div>,
    document.body
  );
}

/* Rect of the element an event came from, for ColorPopover's `anchor` */
export const anchorOf = (el) => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
};
