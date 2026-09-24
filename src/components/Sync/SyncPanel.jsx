import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useApp } from '../../contexts/AppContext';
import SyncDevices from './SyncDevices';
import PairingClaim from './PairingClaim';
import PairingApprovals from './PairingApprovals';
import PassphraseCard from './PassphraseCard';
import { errorMessage, formatRelative, formatAbsolute } from './helpers';
import './Sync.css';
import { IS_ANDROID, MACHINE, MACHINES } from '../../platform';

/* The browser sign-in link the sync API mints is good for ten minutes. */
const LOGIN_WINDOW_MS = 10 * 60 * 1000;

function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export default function SyncPanel() {
  const { state, actions } = useApp();
  const { available, loading, status } = state.sync;

  const [signingIn, setSigningIn] = useState(false);
  const [deadline, setDeadline] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [loginError, setLoginError] = useState(null);
  const [loginHint, setLoginHint] = useState(null);
  const [busy, setBusy] = useState(null);        // 'sync' | 'logout' | null
  const [actionError, setActionError] = useState(null);
  const [lastResult, setLastResult] = useState(null);
  const [showPairing, setShowPairing] = useState(false);
  /* Kept here on purpose: handling the last pairing unmounts the card that
     produced the message, and the user still has to read it. */
  const [pairingNotice, setPairingNotice] = useState(null);

  const mounted = useRef(true);
  /* Bumped whenever the user stops waiting, so a login promise that resolves
     afterwards cannot re-enter the waiting UI. */
  const loginToken = useRef(0);

  /* StrictMode mounts twice in dev: without setting it back to true on the
     second mount, every "still mounted?" guard below would be permanently
     false and no state update would ever land. */
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  /* Tick only while waiting for the browser. */
  useEffect(() => {
    if (!signingIn) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [signingIn]);

  const stopWaiting = useCallback(() => {
    loginToken.current += 1;
    setSigningIn(false);
    setDeadline(0);
  }, []);

  /* The link expired while we were waiting. */
  useEffect(() => {
    if (!signingIn || !deadline || now < deadline) return;
    stopWaiting();
    setLoginHint(null);
    setLoginError('The sign-in link expired after 10 minutes. Start again when you are ready.');
  }, [signingIn, deadline, now, stopWaiting]);

  const handleLogin = async () => {
    const token = loginToken.current + 1;
    loginToken.current = token;
    setLoginError(null);
    setLoginHint(null);
    setSigningIn(true);
    setNow(Date.now());
    setDeadline(Date.now() + LOGIN_WINDOW_MS);
    try {
      const result = await actions.syncLogin();
      if (!mounted.current || loginToken.current !== token) return;
      setSigningIn(false);
      setDeadline(0);
      if (result && result.ok === false) {
        setLoginError('Sign-in was not completed in the browser.');
        return;
      }
      await actions.refreshSyncStatus();
    } catch (err) {
      if (!mounted.current || loginToken.current !== token) return;
      setSigningIn(false);
      setDeadline(0);
      setLoginError(errorMessage(err, 'Sign-in failed. Check your connection and try again.'));
    }
  };

  /* "I closed the browser" — we cannot cancel the flow already running in the
     main process, so we only stop showing the spinner and tell the user how to
     recover either way. */
  const handleStopWaiting = () => {
    stopWaiting();
    setLoginHint('Stopped waiting. If you did finish in the browser, press Refresh status.');
  };

  /* Android: a real cancel. logout() sets the service's abort flag, so the
     /auth/poll loop stops within one interval, the login promise rejects, and
     mobile/node/main.js drops `signingIn`: the foreground service (and its
     "signing in" notification) stops and the Custom Tab closes. Nothing was
     stored yet, so there is nothing else for logout to undo. */
  const handleCancelLogin = async () => {
    stopWaiting();
    setLoginHint(null);
    setLoginError(null);
    try {
      await actions.syncLogout();
    } catch (err) {
      if (mounted.current) setLoginError(errorMessage(err, 'Could not cancel the sign-in.'));
    }
  };

  const handleRefresh = async () => {
    setActionError(null);
    await actions.refreshSyncStatus();
  };

  /* Setup and unlock both run a sync in the main process, which rewrites the
     store files: reload them, like after Sync now. Errors propagate to the
     card, which shows them next to the field. */
  const handlePassphrase = async (mode, value) => {
    const run = mode === 'setup' ? actions.syncSetupPassphrase : actions.syncUnlock;
    const result = await run(value);
    await actions.reloadStore().catch(() => {});
    await actions.refreshSyncStatus();
    if (mounted.current && result && result.synced === false) {
      setPairingNotice('Unlocked. The first sync did not finish; it will retry on its own.');
    }
  };

  const handleSyncNow = async () => {
    setBusy('sync');
    setActionError(null);
    setLastResult(null);
    try {
      const result = await actions.syncNow();
      if (!mounted.current) return;
      setLastResult(result || {});
      /* A pull rewrites the store files underneath us. */
      if (!result || result.pulled === undefined || result.pulled > 0) {
        await actions.reloadStore().catch(() => {});
      }
      await actions.refreshSyncStatus();
    } catch (err) {
      if (mounted.current) setActionError(errorMessage(err, 'Sync failed.'));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const handleLogout = async () => {
    setBusy('logout');
    setActionError(null);
    try {
      await actions.syncLogout();
      if (mounted.current) setLastResult(null);
    } catch (err) {
      if (mounted.current) setActionError(errorMessage(err, 'Could not sign out.'));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  /* ── Bridge missing entirely ── */
  if (!available) {
    return (
      <div className="sync-card sync-card-muted">
        <p className="sync-text">
          Sync is not available in this build. Hosts, groups, snippets and keys stay on this
          {' '}{MACHINE} only.
        </p>
      </div>
    );
  }

  /* ── First status still in flight ── */
  if (loading || !status) {
    return (
      <div className="sync-card sync-card-muted">
        <span className="sync-spinner" aria-hidden="true" />
        <p className="sync-text">Checking sync status…</p>
      </div>
    );
  }

  /* ── Signed out ── */
  if (!status.signedIn) {
    return (
      <div className="sync-card">
        <p className="sync-text">
          Keep your hosts, groups, snippets and keys on every {MACHINE} you use. Sign-in happens in
          your browser: Termilab never sees your Google account, only a device token you can revoke
          from any of your devices.
        </p>
        <p className="sync-text sync-text-dim">
          SSH private keys travel end-to-end encrypted. The server stores them as opaque ciphertext
          and cannot read them.
        </p>

        {signingIn ? (
          <div className="sync-waiting">
            <span className="sync-spinner" aria-hidden="true" />
            <div className="sync-waiting-body">
              <strong>Finish signing in in your browser</strong>
              <span className="sync-text-dim">
                {IS_ANDROID ? 'This screen' : 'This window'} updates on its own when you are done.
                {deadline ? ` The link expires in ${formatCountdown(deadline - now)}.` : ''}
              </span>
            </div>
            {IS_ANDROID ? (
              <button className="sync-btn sync-btn-ghost" onClick={handleCancelLogin}>
                Cancel
              </button>
            ) : (
              <button className="sync-btn sync-btn-ghost" onClick={handleStopWaiting}>
                Stop waiting
              </button>
            )}
          </div>
        ) : (
          <div className="sync-actions">
            <button className="sync-btn sync-btn-primary" onClick={handleLogin}>
              <GoogleMark />
              Sign in with Google
            </button>
          </div>
        )}

        {loginHint && (
          <div className="sync-note">
            <span>{loginHint}</span>
            <button className="sync-btn sync-btn-ghost" onClick={handleRefresh}>Refresh status</button>
          </div>
        )}
        {loginError && <div className="sync-banner sync-banner-error">{loginError}</div>}
        {status.error && <div className="sync-banner sync-banner-error">{status.error}</div>}
      </div>
    );
  }

  /* ── Signed in ── */
  const lastSync = formatRelative(status.lastSyncAt);
  const lastSyncTitle = formatAbsolute(status.lastSyncAt);
  /* `unlocked` decides, not `hasMasterKey`: every install older than the
     passphrase has a random key, which would make this computer look ready. */
  const locked = !status.unlocked;
  const passphraseMode = status.vaultExists ? 'unlock' : 'setup';
  /* Only a computer holding the verified account key should hand it over. */
  const hasIncoming = status.unlocked && status.pendingPairings > 0;

  return (
    <div className="sync-stack">
      <div className="sync-card">
        <div className="sync-account">
          <div className="sync-account-avatar" aria-hidden="true">
            {(status.email || '?').charAt(0).toUpperCase()}
          </div>
          <div className="sync-account-body">
            <div className="sync-account-email">{status.email || 'Signed in'}</div>
            <div className="sync-account-meta">
              <span>{status.deviceName || `This ${MACHINE}`}</span>
              <span className="sync-dot" aria-hidden="true">·</span>
              <span title={lastSyncTitle || undefined}>
                {status.syncing
                  ? 'Syncing…'
                  : lastSync
                    ? `Last synced ${lastSync}`
                    : 'Never synced'}
              </span>
            </div>
          </div>
          <div className="sync-actions">
            <button
              className="sync-btn sync-btn-primary"
              onClick={handleSyncNow}
              disabled={busy === 'sync' || status.syncing}
            >
              {busy === 'sync' || status.syncing ? 'Syncing…' : 'Sync now'}
            </button>
            <button
              className="sync-btn sync-btn-ghost"
              onClick={handleLogout}
              disabled={busy === 'logout'}
            >
              {busy === 'logout' ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </div>

        {lastResult && (
          <div className="sync-banner sync-banner-ok">
            {`Sent ${lastResult.pushed ?? 0} change${lastResult.pushed === 1 ? '' : 's'}, received ${lastResult.pulled ?? 0}.`}
          </div>
        )}
        <SecretsNotice
          withheld={status.secretsWithheld}
          blocked={status.secretsBlocked}
          undecryptable={status.undecryptableCount}
          unlocked={status.unlocked}
        />
        {pairingNotice && (
          <div className="sync-banner sync-banner-ok">
            <span>{pairingNotice}</span>
            <button className="sync-btn sync-btn-ghost sync-btn-sm" onClick={() => setPairingNotice(null)}>
              Dismiss
            </button>
          </div>
        )}
        {actionError && <div className="sync-banner sync-banner-error">{actionError}</div>}
        {status.error && <div className="sync-banner sync-banner-error">{status.error}</div>}
      </div>

      {locked && (
        <PassphraseCard
          key={passphraseMode}
          mode={passphraseMode}
          deviceName={status.deviceName}
          onSubmit={(value) => handlePassphrase(passphraseMode, value)}
        />
      )}
      {/* Pairing is the secondary way in, and only once the account has a
          passphrase: the key it receives is checked against it. Behind a
          button because mounting PairingClaim sends a pairing request. */}
      {locked && status.vaultExists && (showPairing ? (
        <PairingClaim
          deviceName={status.deviceName}
          pairing={status.pairing}
          onPaired={setPairingNotice}
        />
      ) : (
        <div className="sync-actions">
          <button className="sync-btn sync-btn-ghost" onClick={() => setShowPairing(true)}>
            Pair from another {MACHINE} instead
          </button>
        </div>
      ))}
      {hasIncoming && (
        <PairingApprovals count={status.pendingPairings} onHandled={setPairingNotice} />
      )}

      <SyncDevices lastSyncAt={status.lastSyncAt} pendingPairings={status.pendingPairings} />
    </div>
  );
}

/**
 * Passwords and passphrases are encrypted field by field before they leave the
 * machine. Without this notice a host that arrived without its password reads
 * as data loss, and the user goes looking for a password that is right there,
 * sealed. One message per state, never two that contradict each other.
 */
function SecretsNotice({ withheld, blocked, undecryptable, unlocked }) {
  const plural = (n) => (n === 1 ? '' : 's');

  if (!unlocked) {
    if (!withheld && !blocked) return null;
    return (
      <div className="sync-secrets">
        {blocked > 0 && (
          <span>
            <strong>
              {blocked} saved password{plural(blocked)} arrived from your other {MACHINES} still
              encrypted.
            </strong>{' '}
            The hosts are here; the passwords open once this {MACHINE} is unlocked.
          </span>
        )}
        {withheld > 0 && (
          <span>
            <strong>
              {withheld} saved password{plural(withheld)} stayed on this {MACHINE}.
            </strong>{' '}
            Termilab only backs them up encrypted, and this {MACHINE} is not unlocked yet.
          </span>
        )}
        {/* Not sync-text-dim: --text-tertiary lands at 3.5:1 on this background,
            and this is the line that says what to do about it. */}
        <span>Unlock it with the account passphrase below. Nothing was lost.</span>
      </div>
    );
  }

  const stuck = undecryptable || blocked;
  if (!stuck) return null;
  const it = stuck === 1;
  return (
    <div className="sync-secrets">
      <span>
        <strong>{stuck} item{plural(stuck)} can’t be opened here yet.</strong>{' '}
        Another {MACHINE} encrypted {it ? 'it' : 'them'} with its own old key, before this account
        had a passphrase. {it ? 'It opens' : 'They open'} once that {MACHINE} is updated to this
        version and unlocked with the same passphrase. That {MACHINE} still has the original, so
        nothing was lost.
      </span>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" width="14" height="14" aria-hidden="true" focusable="false">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 01-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 009 18z" />
      <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 010-3.44V4.95H.96a9 9 0 000 8.1l3.01-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 00.96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
    </svg>
  );
}
