import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useApp } from '../../contexts/AppContext';
import { errorMessage, formatRelative, formatAbsolute, platformLabel, toDeviceList } from './helpers';
import './Sync.css';
import { MACHINE } from '../../platform';

/**
 * Every device holding a token for this account. Revoking one kills its token
 * server-side; revoking the current one disconnects this computer, so it asks
 * first.
 */
export default function SyncDevices({ lastSyncAt, pendingPairings }) {
  const { actions } = useApp();
  const { syncDevices, syncRevokeDevice, refreshSyncStatus } = actions;

  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [confirmId, setConfirmId] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const mounted = useRef(true);
  /* StrictMode mounts twice in dev: without setting it back to true on the
     second mount, every "still mounted?" guard below would be permanently
     false and no state update would ever land. */
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await syncDevices();
      if (!mounted.current) return;
      setDevices(toDeviceList(result));
    } catch (err) {
      if (mounted.current) setError(errorMessage(err, 'Could not load your devices.'));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [syncDevices]);

  /* Reload after every sync and after a pairing changes, instead of polling. */
  useEffect(() => { load(); }, [load, lastSyncAt, pendingPairings]);

  const revoke = async (id) => {
    setBusyId(id);
    setError(null);
    try {
      await syncRevokeDevice(id);
      if (!mounted.current) return;
      setConfirmId(null);
      await load();
      await refreshSyncStatus();
    } catch (err) {
      if (mounted.current) setError(errorMessage(err, 'Could not revoke that device.'));
    } finally {
      if (mounted.current) setBusyId(null);
    }
  };

  /* Booleans may arrive as undefined or as 0/1 from JSON, hence the casts. */
  const sorted = [...devices].sort((a, b) => {
    if (!!a.current !== !!b.current) return a.current ? -1 : 1;
    if (!!a.revoked !== !!b.revoked) return a.revoked ? 1 : -1;
    return String(b.last_seen_at || '').localeCompare(String(a.last_seen_at || ''));
  });

  return (
    <div className="sync-card">
      <div className="sync-card-title">
        <DevicesIcon />
        <span>Devices</span>
      </div>

      {loading && <p className="sync-text sync-text-dim">Loading devices…</p>}
      {!loading && sorted.length === 0 && !error && (
        <p className="sync-text sync-text-dim">No devices registered yet.</p>
      )}

      <ul className="sync-device-list">
        {sorted.map((device, index) => {
          const seen = formatRelative(device.last_seen_at);
          const added = formatRelative(device.created_at);
          const rowKey = device.id || `row-${index}`;
          const confirming = confirmId != null && confirmId === device.id;
          return (
            <li className={`sync-device ${device.revoked ? 'is-revoked' : ''}`} key={rowKey}>
              <div className="sync-device-row">
                <div className="sync-device-body">
                  <div className="sync-device-name">
                    <span>{device.name || 'Unnamed device'}</span>
                    {device.current && <span className="sync-badge sync-badge-current">This {MACHINE}</span>}
                    {device.revoked && <span className="sync-badge sync-badge-revoked">Revoked</span>}
                  </div>
                  <div className="sync-device-meta" title={formatAbsolute(device.last_seen_at) || undefined}>
                    {platformLabel(device.platform)}
                    {seen ? ` · last seen ${seen}` : ''}
                    {!seen && added ? ` · added ${added}` : ''}
                  </div>
                </div>
                {!device.revoked && (
                  <button
                    className="sync-btn sync-btn-ghost sync-btn-sm"
                    onClick={() => setConfirmId(confirming ? null : device.id)}
                    disabled={busyId === device.id}
                  >
                    {confirming ? 'Cancel' : 'Revoke'}
                  </button>
                )}
              </div>

              {confirming && (
                <div className="sync-device-confirm">
                  <p className="sync-text">
                    {device.current
                      ? `This is the ${MACHINE} you are using. Revoking it signs Termilab out here and stops syncing; you would have to sign in and pair this ${MACHINE} again.`
                      : `“${device.name || 'That device'}” will lose its token immediately and stop syncing. Your data stays on it until you remove it there.`}
                  </p>
                  <div className="sync-actions">
                    <button
                      className="sync-btn sync-btn-danger"
                      onClick={() => revoke(device.id)}
                      disabled={busyId === device.id}
                    >
                      {busyId === device.id
                        ? 'Revoking…'
                        : device.current ? `Yes, disconnect this ${MACHINE}` : 'Revoke device'}
                    </button>
                    <button
                      className="sync-btn sync-btn-ghost"
                      onClick={() => setConfirmId(null)}
                      disabled={busyId === device.id}
                    >
                      Keep it
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {error && <div className="sync-banner sync-banner-error">{error}</div>}
    </div>
  );
}

function DevicesIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="4" width="14" height="10" rx="1" />
      <path d="M2 18h14" />
      <rect x="17" y="9" width="5" height="11" rx="1" />
    </svg>
  );
}
