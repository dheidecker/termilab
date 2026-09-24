import React, { useEffect, useRef, useState } from 'react';
import { AlertIcon, FingerprintIcon } from '../Icons/icons';
import { displayHost, keyTypeLabel } from '../KnownHosts/format';
import './HostKeyPrompt.css';
import { useBackHandler } from '../../hooks/useBackHandler';

/**
 * The dialog main opens when a server's host key is unknown or has changed
 * (electron/services/host-key-service.js). Main waits up to 120 s for the
 * answer and then rejects on its own; 'ssh:host-key-prompt-cancel' closes the
 * dialog in that case. One subscriber in the whole renderer: this component.
 *
 * `changed` and `new-key-type` are the dangerous ones: Cancel has the focus,
 * the accept button is red and says what it does ("Replace key & connect" /
 * "Add key & connect"). `new-key-type` = the host is known, but only by other
 * key types (an attacker offering just ECDSA for a host known by ed25519);
 * accepting adds the key and keeps the known ones.
 */
export function HostKeyDialog({ prompt, busy = false, error = null, queued = 0, onAccept, onCancel }) {
  const changed = prompt.reason === 'changed';
  const newType = prompt.reason === 'new-key-type';
  const warn = changed || newType;
  const known = Array.isArray(prompt.knownFingerprints) ? prompt.knownFingerprints : [];
  const cancelRef = useRef(null);
  const acceptRef = useRef(null);

  useEffect(() => {
    (warn ? cancelRef : acceptRef).current?.focus();
  }, [prompt.requestId, warn]);

  /* Back = Cancel, never accept. While an answer is in flight it is swallowed. */
  useBackHandler(true, () => { if (!busy) onCancel(); });

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onCancel(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const where = displayHost(prompt.host, prompt.port);
  const titleId = `hkp-title-${prompt.requestId}`;

  return (
    <div className="hkp-overlay">
      <div
        className={`hkp-modal ${warn ? 'hkp-changed' : ''}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="hkp-header">
          <div className={`hkp-badge ${warn ? 'danger' : ''}`}>
            {warn ? <AlertIcon /> : <FingerprintIcon />}
          </div>
          <div className="hkp-heading">
            <h3 id={titleId}>{changed ? 'Host key has changed' : newType ? 'Unexpected host key type' : 'Unknown host'}</h3>
            <p>
              {changed
                ? <>The key <strong>{where}</strong> presented is not the one saved for it.</>
                : newType
                  ? <><strong>{where}</strong> presented a key of a type Termilab has never saved for it.</>
                  : <>Termilab has not connected to <strong>{where}</strong> before.</>}
            </p>
          </div>
        </div>

        <div className="hkp-body">
          {changed && (
            <div className="hkp-warning" role="alert">
              <AlertIcon />
              <div>
                <strong>The server&rsquo;s identity changed &mdash; this can mean someone is intercepting the connection.</strong>
                <span>Only replace the key if you know the server was reinstalled or re-keyed. If not, cancel and check with whoever runs it.</span>
              </div>
            </div>
          )}
          {newType && (
            <div className="hkp-warning" role="alert">
              <AlertIcon />
              <div>
                <strong>This host is known by a different key &mdash; this can mean someone is intercepting the connection.</strong>
                <span>Only add the key if you know the server gained a new key type. If not, cancel and check with whoever runs it.</span>
              </div>
            </div>
          )}

          <dl className="hkp-facts">
            <dt>Host</dt>
            <dd className="hkp-mono">{where}</dd>
            <dt>Key type</dt>
            <dd>{keyTypeLabel(prompt.keyType)} <span className="hkp-dim">{prompt.keyType}</span></dd>
            {changed && (
              <>
                <dt>Saved fingerprint</dt>
                <dd className="hkp-mono hkp-fp hkp-fp-old">{prompt.previousFingerprint}</dd>
              </>
            )}
            {newType && known.map((k, i) => (
              <React.Fragment key={`${k.keyType}-${k.fingerprint}-${i}`}>
                <dt>Saved ({keyTypeLabel(k.keyType)})</dt>
                <dd className="hkp-mono hkp-fp hkp-fp-old">{k.fingerprint}</dd>
              </React.Fragment>
            ))}
            <dt>{warn ? 'New fingerprint' : 'Fingerprint'}</dt>
            <dd className="hkp-mono hkp-fp">{prompt.fingerprint}</dd>
          </dl>

          {!warn && (
            <p className="hkp-hint">
              Compare it with the server&rsquo;s own fingerprint (<code>ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub</code>) before you accept.
            </p>
          )}
          {error && <p className="hkp-error">{error}</p>}
          {queued > 0 && <p className="hkp-dim hkp-queue">{queued} more waiting</p>}
        </div>

        <div className="hkp-footer">
          <button ref={cancelRef} className="hkp-btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            ref={acceptRef}
            className={`hkp-btn ${warn ? 'hkp-btn-danger' : 'hkp-btn-primary'}`}
            onClick={onAccept}
            disabled={busy}
          >
            {changed ? 'Replace key & connect' : newType ? 'Add key & connect' : 'Accept & save'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function HostKeyPrompt() {
  const [queue, setQueue] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const ssh = window.electronAPI?.ssh;
    if (!ssh || typeof ssh.onHostKeyPrompt !== 'function') return undefined;
    const onPrompt = ssh.onHostKeyPrompt((p) => {
      if (!p || typeof p.requestId !== 'string') return;
      setQueue(q => (q.some(x => x.requestId === p.requestId) ? q : [...q, p]));
    });
    const onCancel = ssh.onHostKeyPromptCancel?.((c) => {
      setQueue(q => q.filter(x => x.requestId !== c?.requestId));
    });
    return () => {
      ssh.removeHostKeyPromptListener?.(onPrompt);
      ssh.removeHostKeyPromptListener?.(onCancel);
    };
  }, []);

  const current = queue[0];

  /* A new dialog starts clean */
  useEffect(() => { setError(null); setBusy(false); }, [current?.requestId]);

  if (!current) return null;

  const answer = async (accept) => {
    if (busy) return;
    setBusy(true);
    try {
      await window.electronAPI.ssh.respondHostKey(current.requestId, accept);
      setQueue(q => q.filter(x => x.requestId !== current.requestId));
    } catch (err) {
      /* Main already gave up on it (timeout); drop it rather than trap the user */
      if (!accept) setQueue(q => q.filter(x => x.requestId !== current.requestId));
      else setError(err?.message || 'Could not answer the prompt');
      setBusy(false);
    }
  };

  return (
    <HostKeyDialog
      prompt={current}
      busy={busy}
      error={error}
      queued={queue.length - 1}
      onAccept={() => answer(true)}
      onCancel={() => answer(false)}
    />
  );
}
