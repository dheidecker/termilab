import React, { useEffect, useRef, useState } from 'react';
import { AlertIcon, LockIcon, FolderIcon, FileIcon, TrashIcon, TransferIcon } from '../Icons/icons';
import { formatSize, formatDate, permString, isDirLike } from './paths';

/* Modal shell for the SFTP screen. Escape cancels; clicks on the backdrop
   cancel; focus goes to `initialFocus` (a ref) or the first input. */
function Modal({ title, subtitle, icon, tone, onCancel, children, footer, labelledBy, width = 460 }) {
  const ref = useRef(null);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);
  useEffect(() => {
    const el = ref.current?.querySelector('[data-autofocus]') || ref.current?.querySelector('input, button');
    el?.focus();
    if (el?.select) el.select();
  }, []);
  return (
    <div className="sftp-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className={`sftp-modal ${tone ? `sftp-modal-${tone}` : ''}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy} ref={ref} style={{ width }}>
        <div className="sftp-modal-header">
          {icon && <div className={`sftp-modal-badge ${tone || ''}`}>{icon}</div>}
          <div className="sftp-modal-heading">
            <h3 id={labelledBy}>{title}</h3>
            {subtitle && <p>{subtitle}</p>}
          </div>
        </div>
        <div className="sftp-modal-body">{children}</div>
        <div className="sftp-modal-footer">{footer}</div>
      </div>
    </div>
  );
}

function names(entries, max = 4) {
  const shown = entries.slice(0, max).map(e => e.name);
  const more = entries.length - shown.length;
  return { shown, more };
}

/** Delete: local goes to the Trash; remote is permanent and says so. */
export function DeleteDialog({ entries, remote, where, onConfirm, onCancel, busy, error }) {
  const n = entries.length;
  const folders = entries.filter(isDirLike).length;
  const { shown, more } = names(entries);
  const what = n === 1 ? `"${entries[0].name}"` : `${n} items`;
  return (
    <Modal
      labelledBy="sftp-del-title"
      tone="danger"
      icon={<TrashIcon />}
      title={remote ? `Delete ${what} permanently?` : `Move ${what} to the Trash?`}
      subtitle={where}
      onCancel={onCancel}
      footer={(
        <>
          <button className="sftp-btn" onClick={onCancel} disabled={busy} data-autofocus>Cancel</button>
          <button className="sftp-btn sftp-btn-danger" onClick={onConfirm} disabled={busy}>
            {busy ? 'Deleting…' : remote ? 'Delete permanently' : 'Move to Trash'}
          </button>
        </>
      )}
    >
      <ul className="sftp-name-list">
        {shown.map(nm => <li key={nm}>{nm}</li>)}
        {more > 0 && <li className="sftp-dim">and {more} more</li>}
      </ul>
      {remote ? (
        <div className="sftp-warning">
          <AlertIcon />
          <span>
            There is no trash on the server: this cannot be undone.
            {folders > 0 && ' Folders are deleted with everything inside them.'}
          </span>
        </div>
      ) : (
        <p className="sftp-dim">You can restore {n === 1 ? 'it' : 'them'} from the Trash.</p>
      )}
      {error && <p className="sftp-error" role="alert">{error}</p>}
    </Modal>
  );
}

/** New folder / new file. `validate(name)` returns '' or the problem. */
export function NameDialog({ title, label, initial = '', confirmLabel, icon, validate, onConfirm, onCancel, busy, error }) {
  const [value, setValue] = useState(initial);
  const problem = value ? validate(value) : '';
  const submit = (e) => {
    e.preventDefault();
    if (!value.trim() || problem || busy) return;
    onConfirm(value);
  };
  return (
    <Modal
      labelledBy="sftp-name-title"
      icon={icon || <FolderIcon />}
      title={title}
      onCancel={onCancel}
      footer={(
        <>
          <button type="button" className="sftp-btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" form="sftp-name-form" className="sftp-btn sftp-btn-primary" disabled={!value.trim() || !!problem || busy}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </>
      )}
    >
      <form id="sftp-name-form" onSubmit={submit}>
        <label className="sftp-field">
          <span>{label}</span>
          <input
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            data-autofocus
          />
        </label>
        {(problem || error) && <p className="sftp-error" role="alert">{problem || error}</p>}
      </form>
    </Modal>
  );
}

/**
 * "x already exists" for one transfer. Resolves to overwrite / rename / skip,
 * with "apply to all" for the rest of this batch.
 */
export function ConflictDialog({ entry, existing, where, remaining, onDecide }) {
  const [all, setAll] = useState(false);
  const dir = isDirLike(entry);
  const decide = (choice) => onDecide(choice, all);
  return (
    <Modal
      labelledBy="sftp-conflict-title"
      tone="warning"
      icon={<TransferIcon />}
      width={520}
      title={`"${entry.name}" already exists`}
      subtitle={`in ${where}`}
      onCancel={() => decide('skip')}
      footer={(
        <>
          <label className="sftp-check sftp-footer-check">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} disabled={remaining === 0} />
            <span>Apply to all{remaining > 0 ? ` (${remaining} more)` : ''}</span>
          </label>
          <button className="sftp-btn" onClick={() => decide('skip')}>Skip</button>
          <button className="sftp-btn" onClick={() => decide('rename')}>Keep both</button>
          <button className="sftp-btn sftp-btn-primary" onClick={() => decide('overwrite')} data-autofocus>
            {dir ? 'Merge' : 'Replace'}
          </button>
        </>
      )}
    >
      <div className="sftp-compare">
        <div className="sftp-compare-col">
          <span className="sftp-compare-tag">Copying</span>
          <span className="sftp-compare-icon">{dir ? <FolderIcon /> : <FileIcon />}</span>
          <strong>{entry.name}</strong>
          <span className="sftp-dim">{dir ? 'Folder' : formatSize(entry.size)} · {formatDate(entry.modifyTime)}</span>
        </div>
        <div className="sftp-compare-col">
          <span className="sftp-compare-tag">Already there</span>
          <span className="sftp-compare-icon">{isDirLike(existing) ? <FolderIcon /> : <FileIcon />}</span>
          <strong>{existing.name}</strong>
          <span className="sftp-dim">{isDirLike(existing) ? 'Folder' : formatSize(existing.size)} · {formatDate(existing.modifyTime)}</span>
        </div>
      </div>
      <p className="sftp-dim">
        {dir
          ? 'Merge copies the folder into the existing one and replaces files with the same name. Keep both copies it as a new folder with a number added.'
          : 'Replace overwrites the existing file once the copy is complete. Keep both saves the copy with a number added to its name.'}
      </p>
    </Modal>
  );
}

const WHO = [['Owner', 6], ['Group', 3], ['Others', 0]];
const WHAT = [['Read', 4], ['Write', 2], ['Execute', 1]];

/** chmod editor: rwx checkboxes and the octal, kept in sync. onConfirm gets the 0-777 part;
    the caller keeps each item's own special bits (setuid…). */
export function PermissionsDialog({ entries, onConfirm, onCancel, busy, error }) {
  const first = entries[0];
  const base = (first.mode ?? 0o644) & 0o777;
  const special = (first.mode ?? 0) & 0o7000;
  const [mode, setMode] = useState(base);
  const [octal, setOctal] = useState(base.toString(8).padStart(3, '0'));
  const mixed = entries.some(e => ((e.mode ?? 0) & 0o777) !== base);

  const toggle = (shift, bit) => {
    const next = mode ^ (bit << shift);
    setMode(next);
    setOctal(next.toString(8).padStart(3, '0'));
  };
  const onOctal = (v) => {
    const clean = v.replace(/[^0-7]/g, '').slice(0, 3);
    setOctal(clean);
    if (clean.length === 3) setMode(parseInt(clean, 8));
  };
  const valid = /^[0-7]{3}$/.test(octal);
  const submit = (e) => {
    e.preventDefault();
    if (valid && !busy) onConfirm(mode);
  };
  return (
    <Modal
      labelledBy="sftp-perm-title"
      icon={<LockIcon />}
      title="Permissions"
      subtitle={entries.length === 1 ? first.name : `${entries.length} items`}
      onCancel={onCancel}
      footer={(
        <>
          <button type="button" className="sftp-btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" form="sftp-perm-form" className="sftp-btn sftp-btn-primary" disabled={!valid || busy}>
            {busy ? 'Applying…' : 'Apply'}
          </button>
        </>
      )}
    >
      <form id="sftp-perm-form" onSubmit={submit}>
        <table className="sftp-perm-grid">
          <thead>
            <tr><th />{WHAT.map(([w]) => <th key={w} scope="col">{w}</th>)}</tr>
          </thead>
          <tbody>
            {WHO.map(([who, shift]) => (
              <tr key={who}>
                <th scope="row">{who}</th>
                {WHAT.map(([w, bit]) => (
                  <td key={w}>
                    <input
                      type="checkbox"
                      aria-label={`${who} ${w.toLowerCase()}`}
                      checked={!!(mode & (bit << shift))}
                      onChange={() => toggle(shift, bit)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="sftp-perm-row">
          <label className="sftp-field sftp-field-inline">
            <span>Octal</span>
            <input type="text" inputMode="numeric" value={octal} onChange={(e) => onOctal(e.target.value)} maxLength={3} spellCheck={false} data-autofocus />
          </label>
          <code className="sftp-perm-string">{isDirLike(first) ? 'd' : '-'}{permString(mode)}</code>
        </div>
        {mixed && <p className="sftp-dim">The selected items have different permissions now; all of them will get these.</p>}
        {special ? <p className="sftp-dim">Special bits ({(special >> 9).toString(8)}xxx) are kept.</p> : null}
        {error && <p className="sftp-error" role="alert">{error}</p>}
      </form>
    </Modal>
  );
}
