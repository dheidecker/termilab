import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../../contexts/AppContext';
import { ClockIcon, BookmarkIcon, ServerIcon, TerminalIcon, TrashIcon, ChevronDownIcon } from '../Icons/icons';
import { distroFor, DistroLogo } from '../Icons/distros';
import { endpointKey, rankForKeeping } from '../HostList/duplicates';
import { parseQuickConnect } from '../HostList/quickConnect';
import { hostColor } from '../HostList/hostColor';
import '../HostList/HostList.css';
import './Logs.css';

/**
 * Logs: connection history recorded by the main process
 * (electron/services/connection-log-service.js). Start/end, where, who — never
 * commands or output. Local only, capped at 1000 entries.
 *
 * A row reconnects: to the saved host if there is one (by id, else by
 * user@host:port), otherwise as a quick connect. The bookmark saves an unsaved
 * connection as a new host, without credentials.
 */

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dayNumber = (d) => Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86400000);

/** { date: 'Sep 14, 2026', time: '12:30 - 14:43 (+7d)' } */
export function formatSpan(startedAt, endedAt) {
  const s = new Date(startedAt);
  if (Number.isNaN(s.getTime())) return { date: '—', time: '' };
  const date = s.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const e = endedAt ? new Date(endedAt) : null;
  if (!e || Number.isNaN(e.getTime())) return { date, time: hhmm(s) };
  const days = dayNumber(e) - dayNumber(s);
  return { date, time: `${hhmm(s)} - ${hhmm(e)}${days > 0 ? ` (+${days}d)` : ''}` };
}

export default function Logs() {
  const { state, actions } = useApp();
  const { hosts, groups, activeSessions } = state;
  const { listConnectionLogs, clearConnectionLogs, connectToHost, openSFTPTab, openLocalTerminal, saveHost } = actions;

  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [newestFirst, setNewestFirst] = useState(true);
  const [saving, setSaving] = useState(null);

  const reload = useCallback(async () => {
    try {
      const list = await listConnectionLogs();
      setItems(Array.isArray(list) ? list : []);
      setError(null);
    } catch (err) {
      setItems([]);
      setError(err?.message || 'Could not read the history');
    }
  }, [listConnectionLogs]);

  /* Main writes start/end asynchronously; re-read shortly after sessions come and go. */
  const sessionCount = Object.keys(activeSessions || {}).length;
  const tabCount = state.tabs.length;
  useEffect(() => {
    reload();
    const t = setTimeout(reload, 600);
    return () => clearTimeout(t);
  }, [reload, sessionCount, tabCount]);

  const groupMap = useMemo(() => Object.fromEntries((groups || []).map(g => [g.id, g])), [groups]);

  /* The saved host behind an entry: same id, else same user@host:port. */
  const savedHostFor = useCallback((entry) => {
    if (entry.type === 'local') return null;
    const byId = entry.hostId && hosts.find(h => h.id === entry.hostId);
    if (byId) return byId;
    const key = endpointKey(entry);
    if (!key) return null;
    return hosts.filter(h => endpointKey(h) === key).sort(rankForKeeping)[0] || null;
  }, [hosts]);

  const rows = useMemo(() => {
    const list = [...(items || [])];
    list.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    if (newestFirst) list.reverse();
    return list;
  }, [items, newestFirst]);

  const reconnect = async (entry) => {
    if (entry.type === 'local') { openLocalTerminal(); return; }
    const saved = savedHostFor(entry);
    const host = saved || parseQuickConnect(`${entry.username}@${entry.hostname}:${entry.port || 22}`);
    if (!host) return;
    try {
      if (entry.type === 'sftp') await openSFTPTab(host);
      else await connectToHost(host);
    } catch (err) {
      console.error('Reconnect failed:', err);
    }
  };

  const save = async (entry) => {
    if (savedHostFor(entry) || saving) return;
    setSaving(entry.id);
    try {
      const host = {
        label: entry.label || `${entry.username}@${entry.hostname}`,
        hostname: entry.hostname,
        port: Number(entry.port) || 22,
        username: entry.username,
        /* No credential: the user adds one in the editor if they want it */
        authType: 'password',
        groupId: null,
        tags: [],
      };
      if (entry.os) host.os = entry.os;
      await saveHost(host);
    } catch (err) {
      setError(err?.message || 'Could not save the host');
    } finally {
      setSaving(null);
    }
  };

  const clear = async () => {
    if (!window.confirm('Clear the whole connection history on this computer? This cannot be undone.')) return;
    try {
      await clearConnectionLogs();
      setItems([]);
    } catch (err) {
      setError(err?.message || 'Could not clear the history');
    }
  };

  const renderHostCell = (entry, saved) => {
    if (entry.type === 'local') {
      return (
        <div className="lg-host">
          <div className="hv-icon lg-icon hv-icon-muted"><TerminalIcon /></div>
          <div className="hv-card-text">
            <div className="hv-card-label">Local Terminal</div>
            <div className="hv-card-sub">local shell</div>
          </div>
        </div>
      );
    }
    const osId = entry.os || saved?.os;
    const distro = distroFor(osId);
    const label = saved?.label || entry.label || entry.hostname;
    const color = hostColor(saved || { hostname: entry.hostname, label }, groupMap);
    return (
      <div className="lg-host">
        <div
          className={`hv-icon lg-icon ${distro ? 'hv-icon-distro' : ''}`}
          style={{ background: distro ? distro.bg : color }}
          title={distro ? distro.label : undefined}
        >
          {distro ? <DistroLogo os={osId} /> : <ServerIcon />}
        </div>
        <div className="hv-card-text">
          <div className="hv-card-label">{label}</div>
          <div className="hv-card-sub">{entry.type === 'sftp' ? 'sftp' : 'ssh'}, {entry.username}</div>
        </div>
      </div>
    );
  };

  return (
    <div className="hosts-view lg-view">
      <div className="hv-top">
        <div className="hv-actions">
          <h2 className="lg-title">Logs</h2>
          <div className="hv-actions-spacer" />
          {items && items.length > 0 && (
            <button className="hv-btn" onClick={clear}>
              <TrashIcon />
              Clear history
            </button>
          )}
        </div>
        {error && <div className="lg-error" role="alert">{error}</div>}
      </div>

      <div className="hv-scroll">
        {items === null ? null : items.length === 0 ? (
          <div className="hv-empty">
            <div className="hv-empty-icon"><ClockIcon /></div>
            <h3>No connections yet</h3>
            <p>Every SSH, SFTP and local terminal session you open on this computer shows up here, with when it started and ended. Nothing you type is recorded.</p>
          </div>
        ) : (
          <table className="lg-table">
            <thead>
              <tr>
                <th className="lg-col-date">
                  <button
                    className="lg-sort"
                    onClick={() => setNewestFirst(v => !v)}
                    aria-label={newestFirst ? 'Date, newest first. Sort oldest first' : 'Date, oldest first. Sort newest first'}
                  >
                    Date
                    <ChevronDownIcon className={newestFirst ? '' : 'lg-sort-up'} />
                  </button>
                </th>
                <th className="lg-col-user">User</th>
                <th className="lg-col-host">Host</th>
                <th className="lg-col-saved">Saved</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(entry => {
                const saved = savedHostFor(entry);
                const span = formatSpan(entry.startedAt, entry.endedAt);
                const isSaved = entry.type === 'local' || !!saved;
                return (
                  <tr
                    key={entry.id}
                    tabIndex={0}
                    onClick={() => reconnect(entry)}
                    onKeyDown={(e) => { if (e.key === 'Enter') reconnect(entry); }}
                    title={entry.type === 'local' ? 'Open a local terminal' : `Connect to ${entry.username}@${entry.hostname}${(Number(entry.port) || 22) !== 22 ? `:${entry.port}` : ''}`}
                  >
                    <td className="lg-col-date">
                      <div className="lg-main">{span.date}</div>
                      <div className="lg-sub" title={entry.endedAt ? undefined : 'No end time recorded'}>{span.time}</div>
                    </td>
                    <td className="lg-col-user">
                      <div className={`lg-main ${entry.email ? '' : 'lg-muted'}`}>{entry.email || 'Not signed in'}</div>
                      <div className="lg-sub">{entry.deviceName ? `• ${entry.deviceName}` : ''}</div>
                    </td>
                    <td className="lg-col-host">{renderHostCell(entry, saved)}</td>
                    <td className="lg-col-saved">
                      {entry.type !== 'local' && (
                        <button
                          className={`lg-bookmark ${isSaved ? 'saved' : ''}`}
                          onClick={(e) => { e.stopPropagation(); save(entry); }}
                          disabled={saving === entry.id}
                          aria-pressed={isSaved}
                          aria-label={isSaved ? `Saved as ${saved.label || saved.hostname}` : 'Save as a new host'}
                          title={isSaved ? `Saved as ${saved.label || saved.hostname}` : 'Save as a new host'}
                        >
                          <BookmarkIcon filled={isSaved} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
