import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useApp } from '../../contexts/AppContext';
import DigitCode from './DigitCode';
import { errorMessage } from './helpers';
import './Sync.css';

/**
 * Shown when this computer is signed in but has no master key yet.
 *
 * The master key never leaves the OS keychain in the clear and the server
 * cannot read it: a new device receives it from a device that already has it.
 * The six digits are derived from both devices' ephemeral public keys, so if
 * they do not match on both screens the exchange has been tampered with.
 *
 * Timing worth knowing: `pairing.request()` cannot return the digits, because
 * they need the other device's public key. They arrive later on the status
 * push (`status.pairing.digits`). So this component asks for the pairing,
 * waits, shows the digits when they land, and only calls `pairing.claim()`
 * after the user says they match — claim() is what installs the master key,
 * and firing it automatically would mean nobody ever compared anything.
 */
export default function PairingClaim({ deviceName, pairing, onPaired }) {
  const { actions } = useApp();
  const { syncPairingRequest, syncPairingClaim, refreshSyncStatus } = actions;

  const [local, setLocal] = useState(null);      // what pairing.request() returned
  const [requesting, setRequesting] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState(null);
  const [gaveUp, setGaveUp] = useState(false);   // user cancelled a mismatch

  const mounted = useRef(true);
  /* StrictMode runs effects twice in dev; without this we would open two
     pairings and show the digits of the one the other device is not looking at. */
  const requested = useRef(false);

  /* StrictMode mounts twice in dev: without setting it back to true on the
     second mount, every "still mounted?" guard below would be permanently
     false and no state update would ever land. */
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const pairingId = pairing?.id || local?.pairingId || null;
  const digits = pairing?.digits || local?.digits || null;
  const state = pairing?.state || null;
  const rejected = state === 'rejected';
  const expired = state === 'expired' || (requested.current && !requesting && !pairingId && !error);

  const request = useCallback(async () => {
    requested.current = true;
    setRequesting(true);
    setError(null);
    setGaveUp(false);
    try {
      const result = await syncPairingRequest();
      if (!mounted.current) return;
      if (!result || !result.pairingId) {
        setError('The pairing request came back empty. Try again.');
        return;
      }
      setLocal({ pairingId: result.pairingId, digits: result.digits || null });
    } catch (err) {
      if (mounted.current) setError(errorMessage(err, 'Could not start pairing.'));
    } finally {
      if (mounted.current) setRequesting(false);
    }
  }, [syncPairingRequest]);

  /* Adopt a pairing that is already in flight (the main process keeps it in
     memory across panel mounts) instead of opening a second one. */
  useEffect(() => {
    if (requested.current || pairing?.id) { requested.current = true; return; }
    request();
  }, [request, pairing]);

  const confirmMatch = async () => {
    if (!pairingId) return;
    setClaiming(true);
    setError(null);
    try {
      const result = await syncPairingClaim(pairingId);
      if (!mounted.current) return;
      if (result && result.ok === false) {
        setError('The other device has not approved this request yet.');
        return;
      }
      onPaired?.('This computer is paired. Your SSH keys can be decrypted here now.');
      await refreshSyncStatus();
    } catch (err) {
      /* claim() waits for the other side for up to half a minute before it
         gives up, so a rejection here is a real answer, not impatience. */
      if (mounted.current) setError(errorMessage(err, 'Could not finish pairing.'));
    } finally {
      if (mounted.current) setClaiming(false);
    }
  };

  const startOver = () => { requested.current = false; setLocal(null); request(); };

  return (
    <div className="sync-card sync-card-attention">
      <div className="sync-card-title">
        <ShieldIcon />
        <span>Pair this computer</span>
      </div>

      <p className="sync-text">
        Your SSH private keys are encrypted with a master key that lives in the system keychain —
        the server never has it. {deviceName ? <strong>{deviceName}</strong> : 'This computer'} does
        not have that key yet, so it cannot read your keys until another Termilab device hands it
        over.
      </p>

      {error && <div className="sync-banner sync-banner-error">{error}</div>}

      {gaveUp && (
        <>
          <div className="sync-banner sync-banner-error">
            Pairing stopped. The digits did not match, so treat that other approval as hostile:
            revoke the device that approved it and start again with both computers in front of you.
          </div>
          <div className="sync-actions">
            <button className="sync-btn sync-btn-ghost" onClick={startOver}>Start again</button>
          </div>
        </>
      )}

      {!gaveUp && rejected && (
        <>
          <div className="sync-banner sync-banner-error">
            The other device rejected this request.
          </div>
          <div className="sync-actions">
            <button className="sync-btn sync-btn-primary" onClick={startOver}>Ask again</button>
          </div>
        </>
      )}

      {!gaveUp && !rejected && expired && (
        <>
          <div className="sync-banner sync-banner-error">
            This pairing request is no longer active. Start a new one with both computers in front
            of you.
          </div>
          <div className="sync-actions">
            <button className="sync-btn sync-btn-primary" onClick={startOver}>New request</button>
          </div>
        </>
      )}

      {!gaveUp && !rejected && !expired && (
        requesting || !pairingId ? (
          <div className="sync-waiting">
            <span className="sync-spinner" aria-hidden="true" />
            <div className="sync-waiting-body"><strong>Asking to pair…</strong></div>
          </div>
        ) : !digits ? (
          <>
            <div className="sync-waiting">
              <span className="sync-spinner" aria-hidden="true" />
              <div className="sync-waiting-body">
                <strong>Waiting for another device</strong>
                <span className="sync-text-dim">
                  Six digits will appear here as soon as it answers.
                </span>
              </div>
            </div>
            <ol className="sync-steps">
              <li>Open Termilab on a computer that already has your data.</li>
              <li>Go to Settings → Sync: it will show a request from this computer, with six digits.</li>
              <li>Approve it there, then compare the digits with the ones that appear here.</li>
            </ol>
          </>
        ) : (
          <>
            <p className="sync-text">
              The other device answered. These six digits were computed here, from both devices'
              keys:
            </p>
            <DigitCode digits={digits} />
            <p className="sync-text sync-text-warn">
              They must be identical to the ones the other computer showed you. If they differ,
              someone is sitting between the two devices — do not continue.
            </p>
            <div className="sync-actions">
              <button className="sync-btn sync-btn-primary" onClick={confirmMatch} disabled={claiming}>
                {claiming ? 'Finishing…' : 'They match — finish pairing'}
              </button>
              <button
                className="sync-btn sync-btn-danger"
                onClick={() => setGaveUp(true)}
                disabled={claiming}
              >
                They don't match
              </button>
            </div>
          </>
        )
      )}
    </div>
  );
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}
