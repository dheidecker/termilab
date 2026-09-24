import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useApp } from '../../contexts/AppContext';
import DigitCode from './DigitCode';
import { errorMessage } from './helpers';
import './Sync.css';
import { MACHINE, MACHINES } from '../../platform';

/**
 * Shown when this computer is signed in but has no master key yet.
 *
 * The master key never leaves the OS keychain in the clear and the server
 * cannot read it: a new device receives it from a device that already has it.
 * The six digits are derived from both devices' ephemeral public keys, so if
 * they do not match on both screens the exchange has been tampered with.
 *
 * The pairing has two steps and `status.pairing.state` says which one we are
 * in — `pairing.request()` cannot return the digits, they need the other
 * device's public key and arrive later on the status push:
 *
 *   'pendiente'  the other device has not accepted yet. No digits.
 *   'verificar'  it accepted and sent its public key: the digits are on both
 *                screens and the master key has NOT been sent anywhere. This
 *                is the moment to compare — the whole point of the protocol.
 *   'listo'      the other side already confirmed; the sealed key is waiting
 *                and `pairing.claim()` will open it. We still make the user
 *                compare, because claiming is what installs it here.
 */
export default function PairingClaim({ deviceName, pairing, onPaired }) {
  const { actions } = useApp();
  const { syncPairingRequest, syncPairingClaim, refreshSyncStatus } = actions;

  const [local, setLocal] = useState(null);      // what pairing.request() returned
  const [requesting, setRequesting] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState(null);
  const [gaveUp, setGaveUp] = useState(false);   // user said the digits differ

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
  /* Digits on screen and the master key still where it belongs: compare now.
     'listo' means the other side confirmed already; the comparison is still
     ours to make, since claim() is what installs the key on this computer. */
  const comparing = !!digits && state !== 'pendiente';

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
        setError('The other device has not confirmed the digits yet.');
        return;
      }
      onPaired?.(`This ${MACHINE} is paired. Your SSH keys and host passwords can be decrypted here now.`);
      await refreshSyncStatus();
    } catch (err) {
      /* claim() waits for the other side for up to half a minute before it
         gives up, so a rejection here is a real answer, not impatience. The
         message from the main process arrives in Spanish and already says
         what happened; the pairing stays on screen, it can be retried. */
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
        <span>Pair this {MACHINE}</span>
      </div>

      <p className="sync-text">
        Your SSH private keys and your saved host passwords are encrypted with a master key that
        lives in the system keychain — the server never has it.{' '}
        {deviceName ? <strong>{deviceName}</strong> : `This ${MACHINE}`} does not have that key yet,
        so it cannot read them until another Termilab device hands it over.
      </p>

      {error && <div className="sync-banner sync-banner-error">{error}</div>}

      {gaveUp && (
        <>
          <div className="sync-banner sync-banner-error">
            Stopped, and nothing was installed here. Different digits mean someone is sitting
            between the two {MACHINES}: reject the request on the other {MACHINE} as well, then try
            again with both of them in front of you.
          </div>
          <div className="sync-actions">
            <button className="sync-btn sync-btn-ghost" onClick={startOver}>Start again</button>
          </div>
        </>
      )}

      {!gaveUp && rejected && (
        <>
          {/* A key that fails the account passphrase check also lands here,
              with its own message in `error`; saying the other side declined
              on top of it would be wrong. */}
          {!error && (
            <div className="sync-banner sync-banner-error">
              The other device rejected this request.
            </div>
          )}
          <div className="sync-actions">
            <button className="sync-btn sync-btn-primary" onClick={startOver}>Ask again</button>
          </div>
        </>
      )}

      {!gaveUp && !rejected && expired && (
        <>
          <div className="sync-banner sync-banner-error">
            This pairing request is no longer active. Start a new one with both {MACHINES} in front
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
        ) : !comparing ? (
          <>
            <div className="sync-waiting">
              <span className="sync-spinner" aria-hidden="true" />
              <div className="sync-waiting-body">
                <strong>Waiting for the other device to accept</strong>
                <span className="sync-text-dim">
                  Six digits will appear here as soon as it does.
                </span>
              </div>
            </div>
            <ol className="sync-steps">
              <li>Open Termilab on a {MACHINE} that already has your data.</li>
              <li>Go to Settings → Sync: it will show a request from this {MACHINE}.</li>
              <li>Accept it there — both screens then show the same six digits to compare.</li>
            </ol>
          </>
        ) : (
          <div className="sync-verify">
            <div className="sync-verify-label">
              Compare these six digits with the ones on the other {MACHINE}
            </div>
            <DigitCode digits={digits} size="xl" />
            <p className="sync-text">
              If the two screens show different digits, someone is sitting between the two
              {' '}{MACHINES} — do not continue.
            </p>
            <p className="sync-text">
              Confirming authorises <strong>{deviceName || `this ${MACHINE}`}</strong> to decrypt your
              SSH private keys and the passwords saved for your hosts.
            </p>
            <div className="sync-actions">
              <button className="sync-btn sync-btn-primary" onClick={confirmMatch} disabled={claiming}>
                {claiming ? 'Finishing…' : `The digits match — pair this ${MACHINE}`}
              </button>
              <button
                className="sync-btn sync-btn-danger"
                onClick={() => setGaveUp(true)}
                disabled={claiming}
              >
                They don't match — stop
              </button>
            </div>
          </div>
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
