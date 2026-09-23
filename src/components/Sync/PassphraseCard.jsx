import React, { useState, useRef, useEffect } from 'react';
import { errorMessage } from './helpers';

/* The main process enforces this too, and its check is the one that counts.
   This copy only keeps the button disabled until the rule is met. */
const MIN_LENGTH = 6;
/* Code points, like main: a character outside the BMP counts as one, not two. */
const lengthOf = (s) => [...s].length;

/**
 * Create the account passphrase (first computer) or unlock this computer with
 * it (every other one). The key that encrypts saved passwords and SSH keys is
 * derived from this passphrase, so every computer that knows it ends up with
 * the same key and none can drift onto a key of its own.
 *
 * The passphrase lives only in this component's state until it is submitted,
 * and the fields are cleared before the request goes out.
 */
export default function PassphraseCard({ mode, deviceName, onSubmit }) {
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const mounted = useRef(true);

  /* StrictMode mounts twice in dev: set it back to true on the second mount. */
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const isSetup = mode === 'setup';
  const tooShort = passphrase.length > 0 && lengthOf(passphrase) < MIN_LENGTH;
  const mismatch = isSetup && confirm.length > 0 && confirm !== passphrase;
  const valid = lengthOf(passphrase) >= MIN_LENGTH && (!isSetup || confirm === passphrase);

  const submit = async (e) => {
    e.preventDefault();
    if (!valid || busy) return;
    const value = passphrase;
    setPassphrase('');
    setConfirm('');
    setBusy(true);
    setError(null);
    try {
      await onSubmit(value);
    } catch (err) {
      if (mounted.current) {
        setError(errorMessage(err, isSetup ? 'Could not set the passphrase.' : 'Could not unlock this computer.'));
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const who = deviceName ? <strong>{deviceName}</strong> : 'this computer';

  return (
    <form className="sync-card sync-card-attention" onSubmit={submit}>
      <div className="sync-card-title">
        <LockIcon />
        <span>{isSetup ? 'Create the account passphrase' : 'Unlock this computer'}</span>
      </div>

      {isSetup ? (
        <p className="sync-text">
          Saved passwords and SSH keys are encrypted before they leave {who}, with a key derived
          from a passphrase only you know. Use the same passphrase on every computer you sync —
          the server never sees it.
        </p>
      ) : (
        <p className="sync-text">
          This account is protected by a passphrase. Enter it so {who} can open and back up your
          saved passwords and SSH keys.
        </p>
      )}

      <label className="sync-field">
        <span>Passphrase</span>
        <input
          type="password"
          autoComplete={isSetup ? 'new-password' : 'current-password'}
          spellCheck={false}
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          disabled={busy}
        />
      </label>

      {isSetup && (
        <label className="sync-field">
          <span>Repeat it</span>
          <input
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={busy}
          />
        </label>
      )}

      {tooShort && <span className="sync-field-hint">At least {MIN_LENGTH} characters.</span>}
      {mismatch && <span className="sync-field-hint">The two passphrases do not match.</span>}

      {isSetup && (
        <p className="sync-text">
          <strong>If you forget it, the passwords and keys stored in your account cannot be
          recovered</strong> — not by you, not by the server. The copies already on each
          computer are kept.
        </p>
      )}

      {error && <div className="sync-banner sync-banner-error">{error}</div>}

      <div className="sync-actions">
        <button type="submit" className="sync-btn sync-btn-primary" disabled={!valid || busy}>
          {busy
            ? (isSetup ? 'Encrypting…' : 'Unlocking…')
            : (isSetup ? 'Set passphrase' : 'Unlock')}
        </button>
      </div>
    </form>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 018 0v4" />
    </svg>
  );
}
