import React, { useEffect, useMemo, useRef, useState } from 'react';
import { SearchIcon, ServerIcon, LaptopIcon, CloseIcon, CheckIcon } from '../Icons/icons';
import { DistroLogo, distroFor } from '../Icons/distros';
import { hostIconBackground } from '../HostList/hostColor';

/**
 * "Select host" for one pane: this computer, or any saved host, searchable
 * by label, address, user or group. Arrow keys + Enter; Escape closes (when
 * there is something to go back to).
 */
export default function HostPicker({ hosts, groups, current, onPick, onClose, title = 'Select host' }) {
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const groupMap = useMemo(() => Object.fromEntries((groups || []).map(g => [g.id, g])), [groups]);

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const local = { key: 'local', source: { kind: 'local' }, label: 'Local', sub: 'This computer', local: true };
    const list = [...(hosts || [])]
      .sort((a, b) => (a.label || a.hostname || '').localeCompare(b.label || b.hostname || ''))
      .map(h => ({
        key: h.id,
        source: { kind: 'host', hostId: h.id },
        label: h.label || h.hostname,
        sub: `${h.username}@${h.hostname}${h.port && Number(h.port) !== 22 ? `:${h.port}` : ''}`,
        group: groupMap[h.groupId]?.label,
        host: h,
      }));
    const all = [local, ...list];
    if (!needle) return all;
    return all.filter(i => [i.label, i.sub, i.group].some(v => v && v.toLowerCase().includes(needle)));
  }, [q, hosts, groupMap]);

  useEffect(() => { setCursor(0); }, [q]);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${cursor}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const isCurrent = (i) => current && (i.source.kind === 'local'
    ? current.kind === 'local'
    : current.kind === 'host' && current.hostId === i.source.hostId);

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(items.length - 1, c + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(c => Math.max(0, c - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[cursor]) onPick(items[cursor].source); }
    else if (e.key === 'Escape' && onClose) { e.preventDefault(); e.stopPropagation(); onClose(); }
  };

  return (
    <div className="sftp-picker" role="dialog" aria-label={title} onKeyDown={onKeyDown}>
      <div className="sftp-picker-head">
        <h3>{title}</h3>
        {onClose && (
          <button className="sftp-icon-btn" onClick={onClose} aria-label="Close host picker" title="Close">
            <CloseIcon />
          </button>
        )}
      </div>
      <div className="sftp-picker-search">
        <SearchIcon />
        <input
          ref={inputRef}
          type="text"
          placeholder="Search hosts"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          spellCheck={false}
          aria-label="Search hosts"
          aria-controls="sftp-picker-list"
        />
      </div>
      <div className="sftp-picker-list" id="sftp-picker-list" role="listbox" ref={listRef}>
        {items.map((i, idx) => {
          const distro = i.host ? distroFor(i.host.os) : null;
          return (
            <button
              key={i.key}
              data-index={idx}
              role="option"
              aria-selected={idx === cursor}
              className={`sftp-picker-item ${idx === cursor ? 'cursor' : ''} ${isCurrent(i) ? 'current' : ''}`}
              onMouseEnter={() => setCursor(idx)}
              onClick={() => onPick(i.source)}
            >
              <span
                className={`sftp-picker-icon ${i.local ? 'local' : ''}`}
                style={i.local ? undefined : { background: hostIconBackground(i.host, distro, groupMap) }}
              >
                {i.local ? <LaptopIcon /> : distro ? <DistroLogo os={i.host.os} /> : <ServerIcon />}
              </span>
              <span className="sftp-picker-text">
                <span className="sftp-picker-label">{i.label}</span>
                <span className="sftp-picker-sub">
                  {i.local ? i.sub : `sftp, ${i.host.username}`}
                  {i.group ? <span className="sftp-dim"> · {i.group}</span> : null}
                </span>
              </span>
              {!i.local && <span className="sftp-picker-addr">{i.sub}</span>}
              {isCurrent(i) && <CheckIcon className="sftp-picker-check" />}
            </button>
          );
        })}
        {items.length === 0 && <div className="sftp-picker-empty">No hosts match “{q}”.</div>}
      </div>
    </div>
  );
}
