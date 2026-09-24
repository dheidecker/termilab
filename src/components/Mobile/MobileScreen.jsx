import React from 'react';
import { ArrowLeftIcon } from '../Icons/icons';
import './Mobile.css';

/**
 * Android: a full-screen page with a top bar (back / title / action).
 * `onBack` omitted = a top-level screen (no arrow).
 */
export function MobileTopBar({ title, onBack, backLabel = 'Back', action = null }) {
  return (
    <header className="m-topbar">
      {onBack ? (
        <button className="m-icon-btn" onClick={onBack} aria-label={backLabel}>
          <ArrowLeftIcon />
        </button>
      ) : <span className="m-topbar-gap" />}
      <h1 className="m-topbar-title">{title}</h1>
      {action ? (
        <button className="m-topbar-action" onClick={action.onClick} disabled={action.disabled}>
          {action.label}
        </button>
      ) : <span className="m-topbar-gap" />}
    </header>
  );
}

export default function MobileScreen({ title, onBack, action, className = '', children }) {
  return (
    <div className={`m-screen ${className}`}>
      <MobileTopBar title={title} onBack={onBack} action={action} />
      <div className="m-screen-body">{children}</div>
    </div>
  );
}
