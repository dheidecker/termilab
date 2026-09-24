import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../../contexts/AppContext';
import { FEATURES, IS_ANDROID } from '../../platform';
import { MobileTopBar } from '../Mobile/MobileScreen';
import { FingerprintIcon, SearchIcon, CloseIcon, ImportIcon, TrashIcon, CopyIcon } from '../Icons/icons';
import { displayHost, keyTypeLabel } from './format';
import ViewOptions, { useViewChoice, useSortChoice, sortItems } from '../ViewOptions/ViewOptions';
import '../HostList/HostList.css';
import '../HostForm/HostForm.css';
import './KnownHosts.css';
import { useBackHandler } from '../../hooks/useBackHandler';

/**
 * Known Hosts: the server keys this computer trusts (local only, never
 * synced). Entries appear when the user accepts a key in the host key dialog,
 * or by importing ~/.ssh/known_hosts. Deleting one makes the next connection
 * to that server ask again.
 */

const formatDate = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });
};

const importSummary = (r) => {
  const parts = [`Imported ${r.imported}`, `skipped ${r.skipped} (hashed/unsupported)`];
  if (r.duplicates) parts.push(`${r.duplicates} already known`);
  return parts.join(', ');
};

/* The drawer: same pattern (and classes) as the host editor. */
export function KnownHostDrawer({ entry, onClose, onDelete, deleting = false }) {
  const [copied, setCopied] = useState(false);

  useBackHandler(true, () => onClose());

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(entry.fingerprint);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked: the text is selectable anyway */ }
  };

  return (
    <div className="host-form-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="host-form" role="dialog" aria-modal="true" aria-label="Known host">
        {IS_ANDROID ? <MobileTopBar title="Known Host" onBack={onClose} /> : <div className="host-form-header">
          <h2>Known Host</h2>
          <button className="host-form-close-btn" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>}
        <div className="host-form-body">
          <div className="kh-drawer-title">
            <div className="hv-icon kh-icon"><FingerprintIcon /></div>
            <div className="kh-drawer-host">{displayHost(entry.host, entry.port)}</div>
          </div>
          <dl className="kh-facts">
            <dt>Host</dt>
            <dd className="kh-mono">{entry.host}</dd>
            <dt>Port</dt>
            <dd>{entry.port || 22}</dd>
            <dt>Key type</dt>
            <dd>{keyTypeLabel(entry.keyType)} <span className="kh-dim">{entry.keyType}</span></dd>
            <dt>Fingerprint</dt>
            <dd className="kh-fp-row">
              <span className="kh-mono kh-fp">{entry.fingerprint}</span>
              <button className="kh-copy" onClick={copy} title="Copy fingerprint" aria-label="Copy fingerprint">
                <CopyIcon />
              </button>
              {copied && <span className="kh-copied">Copied</span>}
            </dd>
            <dt>Added</dt>
            <dd>{formatDate(entry.addedAt)}</dd>
          </dl>
          <p className="kh-help">
            Deleting it does not block the server: the next connection shows its key again and asks you to accept it.
          </p>
        </div>
        <div className="host-form-footer">
          <button className="host-form-cancel" onClick={onClose}>Close</button>
          <button className="kh-delete" onClick={onDelete} disabled={deleting}>
            <TrashIcon /> Delete
          </button>
        </div>
      </aside>
    </div>
  );
}

export default function KnownHosts() {
  const { actions } = useApp();
  const { listKnownHosts, deleteKnownHost, importKnownHosts } = actions;

  const [items, setItems] = useState(null);   // null = loading
  const [loadError, setLoadError] = useState(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState(null);  // { kind: 'ok'|'error', text }
  const [view, setView] = useViewChoice('termilab.knownhosts.view');
  const [sort, setSort] = useSortChoice('termilab.knownhosts.sort');
  const searchRef = useRef(null);

  const reload = useCallback(async () => {
    try {
      const list = await listKnownHosts();
      setItems(Array.isArray(list) ? list : []);
      setLoadError(null);
    } catch (err) {
      setItems([]);
      setLoadError(err?.message || 'Could not read known hosts');
    }
  }, [listKnownHosts]);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  const handleImport = async () => {
    setImporting(true);
    setNotice(null);
    try {
      const r = await importKnownHosts();
      setNotice({ kind: 'ok', text: importSummary(r) });
      await reload();
    } catch (err) {
      setNotice({ kind: 'error', text: err?.message || 'Import failed' });
    } finally {
      setImporting(false);
    }
  };

  const handleDelete = async () => {
    if (!selected) return;
    const where = displayHost(selected.host, selected.port);
    if (!window.confirm(`Delete the saved ${keyTypeLabel(selected.keyType)} key for ${where}? The next connection will ask you to accept its key again.`)) return;
    setDeleting(true);
    try {
      await deleteKnownHost(selected.id);
      setItems(list => (list || []).filter(e => e.id !== selected.id));
      setSelected(null);
    } catch (err) {
      setNotice({ kind: 'error', text: err?.message || 'Could not delete it' });
    } finally {
      setDeleting(false);
    }
  };

  const closeSearch = () => { setSearch(''); setSearchOpen(false); };

  const q = search.trim().toLowerCase();
  const visible = sortItems(
    (items || []).filter(e => !q || [displayHost(e.host, e.port), e.host, e.keyType, keyTypeLabel(e.keyType), e.fingerprint]
      .some(v => String(v || '').toLowerCase().includes(q))),
    sort,
    /* Same host with two key types: the key type breaks the tie */
    { label: e => `${displayHost(e.host, e.port)} ${e.keyType}`, date: e => e.addedAt }
  );

  /* Android has no ~/.ssh/known_hosts to read */
  const importButton = (primary) => FEATURES.knownHostsFileImport && (
    <button className={`hv-btn ${primary ? 'hv-btn-primary' : ''}`} onClick={handleImport} disabled={importing}>
      <ImportIcon />
      {importing ? 'Importing…' : 'Import'}
    </button>
  );

  return (
    <div className="hosts-view kh-view">
      <div className="hv-top">
        <div className="hv-actions">
          {importButton(false)}
          <div className="hv-actions-spacer" />
          {searchOpen ? (
            <div className="hv-search kh-search">
              <SearchIcon className="hv-search-icon" />
              <input
                ref={searchRef}
                type="text"
                placeholder="Filter known hosts…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape') closeSearch(); }}
                spellCheck={false}
                aria-label="Filter known hosts"
              />
              <button className="hv-search-clear" onClick={closeSearch} aria-label="Close search">
                <CloseIcon />
              </button>
            </div>
          ) : (
            <button className="kh-icon-btn" onClick={() => setSearchOpen(true)} aria-label="Search known hosts" title="Search">
              <SearchIcon />
            </button>
          )}
          <ViewOptions view={view} onViewChange={setView} sort={sort} onSortChange={setSort} />
        </div>
        {notice && (
          <div className={`kh-notice ${notice.kind === 'error' ? 'error' : ''}`} role="status">
            <span>{notice.text}</span>
            <button className="hv-search-clear" onClick={() => setNotice(null)} aria-label="Dismiss"><CloseIcon /></button>
          </div>
        )}
      </div>

      <div className="hv-scroll">
        {items === null ? null : loadError ? (
          <div className="hv-empty">
            <h3>Could not load known hosts</h3>
            <p>{loadError}</p>
          </div>
        ) : items.length === 0 ? (
          <div className="hv-empty">
            <div className="hv-empty-icon"><FingerprintIcon /></div>
            <h3>No known hosts yet</h3>
            {FEATURES.knownHostsFileImport
              ? <p>A server is added here the first time you accept its key, or import the ones OpenSSH already trusts from <code>~/.ssh/known_hosts</code>.</p>
              : <p>A server is added here the first time you accept its key. Keys you trusted on your other devices arrive with sync.</p>}
            {importButton(true)}
          </div>
        ) : visible.length === 0 ? (
          <div className="hv-empty">
            <div className="hv-empty-icon"><SearchIcon /></div>
            <h3>No known hosts match “{search.trim()}”</h3>
            <p>Try a hostname, a key type or part of a fingerprint.</p>
          </div>
        ) : (
          <section className="hv-section">
            <h4 className="hv-section-title">Known Hosts</h4>
            <div className={`hv-grid ${view === 'list' ? 'hv-list' : ''}`}>
              {visible.map(entry => {
                const label = displayHost(entry.host, entry.port);
                return (
                  <div
                    key={entry.id}
                    className="hv-card"
                    role="button"
                    tabIndex={0}
                    title={entry.fingerprint}
                    onClick={() => setSelected(entry)}
                    onKeyDown={(e) => { if (e.key === 'Enter') setSelected(entry); }}
                  >
                    <div className="hv-icon kh-icon"><FingerprintIcon /></div>
                    <div className="hv-card-text">
                      <div className="hv-card-label">{label}</div>
                      <div className="hv-card-sub">{keyTypeLabel(entry.keyType)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>

      {selected && (
        <KnownHostDrawer
          entry={selected}
          deleting={deleting}
          onClose={() => setSelected(null)}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}
