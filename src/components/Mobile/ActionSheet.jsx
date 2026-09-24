import React, { useEffect, useRef } from 'react';
import { useBackHandler } from '../../hooks/useBackHandler';
import './Mobile.css';

/**
 * Android: a bottom sheet of actions (long-press on a host card).
 * actions: [{ id, label, Icon?, danger?, onSelect }]
 */
export default function ActionSheet({ title, subtitle, actions, onClose }) {
  const firstRef = useRef(null);
  useBackHandler(true, onClose);
  useEffect(() => { firstRef.current?.focus({ preventScroll: true }); }, []);

  return (
    <div className="m-sheet-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="m-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="m-sheet-grip" aria-hidden="true" />
        {(title || subtitle) && (
          <div className="m-sheet-head">
            {title && <div className="m-sheet-title">{title}</div>}
            {subtitle && <div className="m-sheet-sub">{subtitle}</div>}
          </div>
        )}
        <div className="m-sheet-actions">
          {actions.map((a, i) => (
            <button
              key={a.id}
              ref={i === 0 ? firstRef : undefined}
              className={`m-sheet-item${a.danger ? ' danger' : ''}`}
              onClick={() => { onClose(); a.onSelect(); }}
            >
              {a.Icon && <a.Icon />}
              <span>{a.label}</span>
            </button>
          ))}
        </div>
        <button className="m-sheet-cancel" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
