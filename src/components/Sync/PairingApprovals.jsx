import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useApp } from '../../contexts/AppContext';
import DigitCode from './DigitCode';
import { errorMessage, platformLabel, toPendingList } from './helpers';
import './Sync.css';

/**
 * Shown on a device that already holds the master key when another device is
 * asking for it. This side drives the two steps of the pairing:
 *
 *   1. "Accept" (`pairing.approve`) publishes this device's public key and
 *      NOTHING else. From that moment both computers can show the same six
 *      digits — derived from both ephemeral public keys, never invented by the
 *      server — and the master key has not moved.
 *   2. "The digits match" (`pairing.confirm`) is the only call that lets the
 *      master key leave this machine.
 *
 * Step 2 is not a formality and the UI must not make it look like one: whoever
 * clicks it without looking at the other screen has thrown away the only
 * protection against someone swapping a public key in the middle.
 *
 * Each entry from `pairing.pending()` carries `state`: 'pendiente' (waiting for
 * step 1) or 'aceptado' (waiting for the human comparison).
 */
export default function PairingApprovals({ count, onHandled }) {
  const { actions } = useApp();
  const {
    syncPairingPending,
    syncPairingApprove,
    syncPairingConfirm,
    syncPairingReject,
    refreshSyncStatus,
  } = actions;

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

  /* Update one entry in place. approve() answers with the state and the digits
     it is actually using, so the code appears without waiting for a refresh. */
  const patch = (id, fields) => setPending(list => (
    list.map(item => (item.id === id ? { ...item, ...fields } : item))
  ));

  /* Step 1. Publishes the public key: after this both screens show digits. */
  const accept = async (item) => {
    setBusyId(item.id);
    setError(null);
    try {
      const result = await syncPairingApprove(item.id);
      if (!mounted.current) return;
      patch(item.id, {
        state: result?.state || 'aceptado',
        digits: result?.digits ?? item.digits ?? null,
      });
      await refreshSyncStatus();
    } catch (err) {
      if (mounted.current) setError(errorMessage(err, 'Could not accept the request.'));
    } finally {
      if (mounted.current) setBusyId(null);
    }
  };

  /* Step 2. Hands over the master key. */
  const confirm = async (item) => {
    setBusyId(item.id);
    setError(null);
    try {
      await syncPairingConfirm(item.id);
      if (!mounted.current) return;
      /* Reported upwards: handling the last request unmounts this card. */
      onHandled?.(`Done. “${item.deviceName || 'That device'}” can now decrypt your SSH keys and your saved host passwords.`);
      await load();
      await refreshSyncStatus();
    } catch (err) {
      if (!mounted.current) return;
      /* A 409 means the server has no record of step 1 — the message from the
         main process says so, in Spanish, and says what to do. The request
         stays on screen at step 1: the digits are derived from the same
         ephemeral key, so accepting again shows the same six. */
      setError(errorMessage(err, 'Could not finish the pairing.'));
      patch(item.id, { state: 'pendiente' });
    } finally {
      if (mounted.current) setBusyId(null);
    }
  };

  const reject = async (item) => {
    setBusyId(item.id);
    setError(null);
    try {
      await syncPairingReject(item.id);
      if (!mounted.current) return;
      onHandled?.('Rejected. That device got nothing: your keys and passwords never left this computer.');
      await load();
      await refreshSyncStatus();
    } catch (err) {
      if (mounted.current) setError(errorMessage(err, 'Could not reject the request.'));
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
        This happens in two steps, and the second one is yours to judge: first both computers show
        the same six digits, then you say whether they match.
      </p>

      {loading && <p className="sync-text sync-text-dim">Loading requests…</p>}

      {!loading && pending.length === 0 && (
        <p className="sync-text sync-text-dim">
          {count > 0
            ? 'The request is no longer available — it may have expired or been handled on another device.'
            : 'No requests waiting.'}
        </p>
      )}

      {pending.map(item => {
        const busy = busyId === item.id;
        const name = item.deviceName || 'that device';
        const accepted = item.state === 'aceptado';

        return (
          <div className="sync-pairing-request" key={item.id}>
            <div className="sync-pairing-request-head">
              <div>
                <div className="sync-pairing-device">{item.deviceName || 'Unnamed device'}</div>
                <div className="sync-text-dim">{platformLabel(item.platform)}</div>
              </div>
            </div>

            {!accepted && (
              <>
                <p className="sync-text">
                  Accepting only sends this computer's public key, so both screens can show the same
                  six digits. Nothing is decryptable by that device until you compare them.
                </p>
                <div className="sync-actions">
                  <button
                    className="sync-btn sync-btn-primary"
                    onClick={() => accept(item)}
                    disabled={busy}
                  >
                    {busy ? 'Working…' : 'Accept — show the digits'}
                  </button>
                  <button
                    className="sync-btn sync-btn-danger"
                    onClick={() => reject(item)}
                    disabled={busy}
                  >
                    I did not ask for this — reject
                  </button>
                </div>
              </>
            )}

            {accepted && item.digits && (
              <div className="sync-verify">
                <div className="sync-verify-label">
                  Compare these six digits with the ones on <strong>{name}</strong>
                </div>
                <DigitCode digits={item.digits} size="xl" />
                <p className="sync-text">
                  If the two screens show different digits, someone is sitting between the two
                  computers — reject.
                </p>
                <p className="sync-text">
                  Confirming lets <strong>{name}</strong> decrypt your SSH private keys and the
                  passwords saved for your hosts.
                </p>
                <div className="sync-actions">
                  <button
                    className="sync-btn sync-btn-primary"
                    onClick={() => confirm(item)}
                    disabled={busy}
                  >
                    {busy ? 'Sending…' : 'The digits match — hand over the key'}
                  </button>
                  <button
                    className="sync-btn sync-btn-danger"
                    onClick={() => reject(item)}
                    disabled={busy}
                  >
                    They don't match — reject
                  </button>
                </div>
              </div>
            )}

            {accepted && !item.digits && (
              <div className="sync-verify">
                <p className="sync-text sync-text-warn">
                  The six digits for this request are not available on this computer any more, so
                  there is nothing to compare. Reject it and pair again with both computers in
                  front of you.
                </p>
                <div className="sync-actions">
                  <button
                    className="sync-btn sync-btn-danger"
                    onClick={() => reject(item)}
                    disabled={busy}
                  >
                    Reject
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

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
