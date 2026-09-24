import React from 'react';
import { UploadIcon, DownloadIcon, TransferIcon, CloseIcon, RefreshIcon, ChevronDownIcon, FolderIcon, CheckIcon, AlertIcon } from '../Icons/icons';
import { formatSize, formatDuration } from './paths';

const ACTIVE = new Set(['queued', 'running']);

function DirectionIcon({ item }) {
  if (item.isDir) return <FolderIcon />;
  if (item.src.kind === 'local' && item.dst.kind === 'remote') return <UploadIcon />;
  if (item.src.kind === 'remote' && item.dst.kind === 'local') return <DownloadIcon />;
  return <TransferIcon />;
}

function statusLine(item) {
  const { state, transferred = 0, total = 0, speed, error } = item;
  if (state === 'queued') return 'Waiting…';
  if (state === 'running') {
    if (!total && !transferred) return 'Starting…';
    const parts = [`${formatSize(transferred)} of ${formatSize(total)}`];
    if (speed > 0) {
      parts.push(`${formatSize(speed)}/s`);
      const left = (total - transferred) / speed;
      if (Number.isFinite(left)) parts.push(`${formatDuration(left)} left`);
    }
    if (item.files > 1) parts.push(`${item.filesDone}/${item.files} files`);
    return parts.join(' · ');
  }
  if (state === 'done') {
    const secs = item.endedAt && item.startedAt ? (item.endedAt - item.startedAt) / 1000 : 0;
    return `${formatSize(item.bytes ?? total)}${item.files > 1 ? ` · ${item.files} files` : ''}${secs >= 1 ? ` in ${formatDuration(secs)}` : ''}`;
  }
  if (state === 'cancelled') return 'Cancelled';
  if (state === 'error') return error || 'Failed';
  return '';
}

/**
 * The queue at the bottom of the SFTP tab. Collapses to its header; shows
 * the running count and aggregate progress while collapsed.
 */
export default function TransferQueue({ items, open, onToggle, onCancel, onRetry, onRetryFailed, onClearDone }) {
  if (!items.length) return null;
  const active = items.filter(i => ACTIVE.has(i.state));
  const failed = items.filter(i => i.state === 'error');
  const finished = items.filter(i => !ACTIVE.has(i.state));
  const running = items.filter(i => i.state === 'running');
  const totalBytes = running.reduce((s, i) => s + (i.total || 0), 0);
  const doneBytes = running.reduce((s, i) => s + (i.transferred || 0), 0);
  const aggregate = totalBytes ? doneBytes / totalBytes : 0;

  return (
    <section className={`sftp-queue ${open ? 'open' : ''}`} aria-label="Transfers">
      <header className="sftp-queue-head">
        <button className="sftp-queue-toggle" onClick={onToggle} aria-expanded={open}>
          <ChevronDownIcon className="sftp-queue-chevron" />
          <span className="sftp-queue-title">Transfers</span>
          <span className="sftp-queue-counts">
            {active.length > 0 && <span>{active.length} active</span>}
            {failed.length > 0 && <span className="sftp-queue-failed">{failed.length} failed</span>}
            {active.length === 0 && failed.length === 0 && <span>{finished.length} done</span>}
          </span>
          {!open && running.length > 0 && (
            <span className="sftp-progress sftp-progress-mini" aria-hidden="true">
              <span style={{ width: `${Math.round(aggregate * 100)}%` }} />
            </span>
          )}
        </button>
        <div className="sftp-queue-actions">
          {failed.length > 0 && (
            <button className="sftp-link-btn" onClick={onRetryFailed}><RefreshIcon /> Retry failed</button>
          )}
          {finished.length > 0 && (
            <button className="sftp-link-btn" onClick={onClearDone}>Clear completed</button>
          )}
        </div>
      </header>
      {open && (
        <ul className="sftp-queue-list">
          {items.map(item => {
            const pct = item.total ? Math.min(100, (item.transferred / item.total) * 100) : (item.state === 'done' ? 100 : 0);
            return (
              <li key={item.id} className={`sftp-qitem sftp-q-${item.state}`}>
                <span className="sftp-qitem-icon"><DirectionIcon item={item} /></span>
                <div className="sftp-qitem-main">
                  <div className="sftp-qitem-top">
                    <span className="sftp-qitem-name" title={item.srcPath}>{item.name}</span>
                    <span className="sftp-qitem-route">{item.fromLabel} → {item.toLabel}</span>
                  </div>
                  <div className="sftp-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={`${item.name} progress`}>
                    <span style={{ width: `${pct}%` }} />
                  </div>
                  <div className="sftp-qitem-status">
                    {item.state === 'done' && <CheckIcon className="sftp-q-ok" />}
                    {item.state === 'error' && <AlertIcon className="sftp-q-bad" />}
                    <span>{statusLine(item)}</span>
                  </div>
                </div>
                <div className="sftp-qitem-actions">
                  {ACTIVE.has(item.state) && (
                    <button className="sftp-icon-btn" onClick={() => onCancel(item.id)} aria-label={`Cancel ${item.name}`} title="Cancel">
                      <CloseIcon />
                    </button>
                  )}
                  {(item.state === 'error' || item.state === 'cancelled') && (
                    <button className="sftp-icon-btn" onClick={() => onRetry(item.id)} aria-label={`Retry ${item.name}`} title="Retry">
                      <RefreshIcon />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
