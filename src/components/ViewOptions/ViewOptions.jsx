import React, { useCallback, useEffect, useRef, useState } from 'react';
import { GridIcon, ListIcon, TagIcon, SortIcon, CheckIcon } from '../Icons/icons';
import './ViewOptions.css';

/**
 * Termius-style icon buttons at the right of a section's action row:
 *   View (grid/list) · Tags (filter, optional) · Sort
 * Used by Hosts, Port Forwarding and Known Hosts. Each one opens a small menu
 * that closes on outside click, Esc or Tab, and is driven with the arrow keys.
 */

export const SORT_OPTIONS = [
  { id: 'az', label: 'A–Z' },
  { id: 'za', label: 'Z–A' },
  { id: 'newest', label: 'Newest' },
  { id: 'oldest', label: 'Oldest' },
];
const SORT_IDS = SORT_OPTIONS.map(o => o.id);
const VIEW_IDS = ['grid', 'list'];

const readChoice = (key, allowed, fallback) => {
  try {
    const v = window.localStorage.getItem(key);
    return allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
};

/** A string choice remembered in localStorage (private mode / blocked storage just forgets). */
export function usePersistentChoice(key, allowed, fallback) {
  const [value, setValue] = useState(() => readChoice(key, allowed, fallback));
  const set = useCallback((next) => {
    setValue(next);
    try { window.localStorage.setItem(key, next); } catch { /* storage blocked */ }
  }, [key]);
  return [value, set];
}

export const useViewChoice = (key) => usePersistentChoice(key, VIEW_IDS, 'grid');
export const useSortChoice = (key) => usePersistentChoice(key, SORT_IDS, 'az');

const time = (v) => {
  const t = v ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? 0 : t;
};

/**
 * Sorted copy. `label(item)` gives the name; `date(item)` the creation date
 * (items without one count as oldest). Ties fall back to the name.
 */
export function sortItems(items, sort, { label, date }) {
  const byName = (a, b) => String(label(a) || '').localeCompare(String(label(b) || ''), undefined, { sensitivity: 'base', numeric: true });
  const list = [...items];
  switch (sort) {
    case 'za': return list.sort((a, b) => byName(b, a));
    case 'newest': return list.sort((a, b) => (time(date(b)) - time(date(a))) || byName(a, b));
    case 'oldest': return list.sort((a, b) => (time(date(a)) - time(date(b))) || byName(a, b));
    case 'az':
    default: return list.sort(byName);
  }
}

/* ─── One icon button + its menu ─── */
function IconMenu({ icon, label, highlighted = false, children }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);

  const items = () => Array.from(menuRef.current?.querySelectorAll('[role^="menuitem"]:not([disabled])') || []);

  const close = useCallback((refocus = false) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    /* Focus the checked item, or the first one */
    const list = items();
    (list.find(el => el.getAttribute('aria-checked') === 'true') || list[0])?.focus();

    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) close(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, close]);

  const onMenuKeyDown = (e) => {
    const list = items();
    const i = list.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'Tab') close(false);
    else if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); list[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); list[list.length - 1]?.focus(); }
  };

  const onButtonKeyDown = (e) => {
    if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true); }
  };

  return (
    <div className="vo-menu-root" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={`vo-btn ${highlighted ? 'highlighted' : ''} ${open ? 'open' : ''}`}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        onKeyDown={onButtonKeyDown}
      >
        {icon}
      </button>
      {open && (
        <div className="hv-menu vo-menu" role="menu" aria-label={label} ref={menuRef} onKeyDown={onMenuKeyDown}>
          {children(close)}
        </div>
      )}
    </div>
  );
}

function MenuCheck({ role = 'menuitemradio', checked, onClick, children, disabled }) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={checked}
      className={`hv-menu-item vo-item ${checked ? 'checked' : ''}`}
      onClick={onClick}
      disabled={disabled}
    >
      <span className="vo-check">{checked && <CheckIcon />}</span>
      <span className="vo-item-label">{children}</span>
    </button>
  );
}

/**
 * @param {object} p
 * @param {'grid'|'list'} p.view
 * @param {(v: string) => void} p.onViewChange
 * @param {string} p.sort            one of SORT_OPTIONS ids
 * @param {(s: string) => void} p.onSortChange
 * @param {string[]} [p.tags]        all tags in use; omit to hide the Tags button
 * @param {string[]} [p.selectedTags]
 * @param {(tags: string[]) => void} [p.onTagsChange]
 */
export default function ViewOptions({ view, onViewChange, sort, onSortChange, tags, selectedTags = [], onTagsChange }) {
  const toggleTag = (tag) => {
    onTagsChange(selectedTags.includes(tag) ? selectedTags.filter(t => t !== tag) : [...selectedTags, tag]);
  };

  return (
    <div className="vo-bar" role="toolbar" aria-label="View options">
      <IconMenu icon={view === 'list' ? <ListIcon /> : <GridIcon />} label="View">
        {(close) => (
          <>
            <div className="vo-heading" aria-hidden="true">View</div>
            {[['grid', 'Grid'], ['list', 'List']].map(([id, text]) => (
              <MenuCheck key={id} checked={view === id} onClick={() => { onViewChange(id); close(true); }}>
                {text}
              </MenuCheck>
            ))}
          </>
        )}
      </IconMenu>

      {tags && (
        <IconMenu
          icon={<TagIcon />}
          label={selectedTags.length ? `Tags (${selectedTags.length} selected)` : 'Tags'}
          highlighted={selectedTags.length > 0}
        >
          {() => (
            <>
              <div className="vo-heading" aria-hidden="true">Filter by tags</div>
              {tags.length === 0 ? (
                <div className="vo-empty">No tags yet. Add tags in a host’s editor.</div>
              ) : (
                <div className="vo-scroll">
                  {tags.map(tag => (
                    <MenuCheck key={tag} role="menuitemcheckbox" checked={selectedTags.includes(tag)} onClick={() => toggleTag(tag)}>
                      {tag}
                    </MenuCheck>
                  ))}
                </div>
              )}
              <div className="vo-sep" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="hv-menu-item vo-item vo-clear"
                disabled={selectedTags.length === 0}
                onClick={() => onTagsChange([])}
              >
                <span className="vo-check" />
                <span className="vo-item-label">Clear</span>
              </button>
            </>
          )}
        </IconMenu>
      )}

      <IconMenu icon={<SortIcon />} label="Sort">
        {(close) => (
          <>
            <div className="vo-heading" aria-hidden="true">Sort by</div>
            {SORT_OPTIONS.map(o => (
              <MenuCheck key={o.id} checked={sort === o.id} onClick={() => { onSortChange(o.id); close(true); }}>
                {o.label}
              </MenuCheck>
            ))}
          </>
        )}
      </IconMenu>
    </div>
  );
}
