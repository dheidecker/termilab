import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useApp } from '../../contexts/AppContext';
import DigitCode from './DigitCode';
import { errorMessage, platformLabel, toPendingList } from './helpers';
import './Sync.css';

/**
 * Shown on a device that already holds the master key when another device is
 * asking for it. Approving is not a formality: it lets that computer decrypt
 * every SSH private key in the account.
 *
 * The digits below are computed on this device, from the requester's public key
 * and the ephemeral key this device will answer with — the server never makes
 * them up. The requesting computer can only show them once this one has
 * answered, so the comparison happens right after approving, and a mismatch
 * means the device that got approved is not the one the user is holding.
 */
export default function PairingApprovals({ count, onHandled }) {
  const { actions } = useApp();
  const { syncPairingPending, syncPairingApprove, syncPairingReject, refreshSyncStatus } = actions;

  const [pending, setPending] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
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
      const result = await syncPairingPending();
      if (!mounted.current) return;
      setPending(toPendingList(result));
    } catch (err) {
      if (mounted.current) setError(errorMessage(err, 'Could not read the pending requests.'));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [syncPairingPending]);

  /* `count` comes from the status push, so a request that arrives while this
     panel is open shows up without polling. */
  useEffect(() => { load(); }, [load, count]);

  const decide = async (item, approve) => {
    setBusyId(item.id);
    setError(null);
    try {
      if (approve) await syncPairingApprove(item.id);
      else await syncPairingReject(item.id);
      if (!mounted.current) return;
      /* Reported upwards: handling the last request unmounts this card. */
      onHandled?.(approve
        ? `Approved. Check that “${item.deviceName || 'that device'}” now shows the same six digits — if it does not, revoke it below straight away.`
        : 'Rejected. That device received nothing.');
      await load();
      await refreshSyncStatus();
    } catch (err) {
      if (mounted.current) {
        setError(errorMessage(err, approve ? 'Could not approve the request.' : 'Could not reject the request.'));
      }
    } finally {
      if (mounted.current) setBusyId(null);
    }
  };

  return (
    <div className="sync-card sync-card-attention">
      <div className="sync-card-title">
        <KeyIcon />
        <span>A device is asking for your keys</span>
      </div>

      <p className="sync-text">
        Approving hands over the master key that decrypts every SSH private key in your account.
        Do it only if you are the one asking, from the computer named below.
      </p>

      {loading && <p className="sync-text sync-text-dim">Loading requests…</p>}

      {!loading && pending.length === 0 && (
        <p className="sync-text sync-text-dim">
          {count > 0
            ? 'The request is no longer available — it may have expired or been handled on another device.'
            : 'No requests waiting.'}
        </p>
      )}

      {pending.map(item => (
        <div className="sync-pairing-request" key={item.id}>
          <div className="sync-pairing-request-head">
            <div>
              <div className="sync-pairing-device">{item.deviceName || 'Unnamed device'}</div>
              <div className="sync-text-dim">{platformLabel(item.platform)}</div>
            </div>
          </div>
          <DigitCode digits={item.digits} />
          <p className="sync-text sync-text-warn">
            Write these down. The other computer shows them right after you approve: if they are
            different, it is not the computer you think it is — revoke it immediately.
          </p>
          <div className="sync-actions">
            <button
              className="sync-btn sync-btn-primary"
              onClick={() => decide(item, true)}
              disabled={busyId === item.id}
            >
              {busyId === item.id ? 'Working…' : 'Approve — it is my computer'}
            </button>
            <button
              className="sync-btn sync-btn-danger"
              onClick={() => decide(item, false)}
              disabled={busyId === item.id}
            >
              Reject
            </button>
          </div>
        </div>
      ))}

      {error && <div className="sync-banner sync-banner-error">{error}</div>}
    </div>
  );
}

function KeyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3" />
    </svg>
  );
}
