import React, { useState, useEffect, useRef } from 'react';
import { CopyBlock } from './CommandLine';
import './RemoteAccess.css';

/*
 * Settings → General → "Remote access": this PC serves Termilab to a browser
 * inside the owner's Tailscale network (tailnet). Tailscale is mandatory:
 * main refuses to serve without it (electron/web/tailscale.js), this only
 * shows the state and explains what is missing.
 *
 *   window.electronAPI.web.status() / enable() / disable() / setName(name) -> {
 *     tailscale: { installed, running, login, dnsName, httpsEnabled, tagged, reason },
 *     remoteAccess: { enabled, port, hostName },
 *     serving, url,
 *     error: null | { code, message, command? }
 *   }
 *
 * No API (browser, Android, an older main) -> renders nothing.
 */

const webApi = () => (typeof window !== 'undefined' && window.electronAPI && window.electronAPI.web) || null;

const REASONS = {
  'not-installed': {
    text: 'Tailscale is not installed on this computer. Remote access only works inside your private Tailscale network, never on the open internet.',
    link: { href: 'https://tailscale.com/download', label: 'Download Tailscale' },
  },
  stopped: {
    text: 'Tailscale is installed but not running. Start it and come back to this page.',
  },
  'logged-out': {
    text: 'Tailscale is not signed in. Sign in to your Tailscale account on this computer, then come back to this page.',
  },
  'https-disabled': {
    text: 'HTTPS certificates are turned off for your Tailscale network. Turn on MagicDNS and HTTPS Certificates in the Tailscale admin console.',
    link: { href: 'https://login.tailscale.com/admin/dns', label: 'Open DNS settings' },
  },
  tagged: {
    text: 'This computer is tagged in Tailscale. Tagged devices do not tell Termilab who is connecting, so remote access is blocked. Remove the tags from this device in the Tailscale admin console.',
  },
};

const ERRORS = {
  'funnel-on': 'Tailscale Funnel is on for this port, which would put Termilab on the public internet. Turn Funnel off for that port first.',
  'port-busy': 'Another service already uses this port in Tailscale. Remove it, or stop the other app, and try again.',
  'operator-required': 'Tailscale does not let your user share apps yet. Run this once in a terminal, then try again:',
  'serve-exited': 'Tailscale stopped sharing Termilab. Retrying…',
};

export function RemoteAccessView({ state, busy, error, nameDraft, onNameChange, onNameSave, onToggle }) {
  if (!state) return null;
  const ts = state.tailscale || {};
  const ra = state.remoteAccess || {};
  const reason = ts.reason ? REASONS[ts.reason] || { text: `Tailscale is not ready (${ts.reason}).` } : null;
  const shownError = error || state.error;
  const enabled = !!ra.enabled;
  const nameDirty = nameDraft.trim() !== (ra.hostName || '');

  return (
    <div className="settings-section">
      <div className="settings-section-title">Remote access</div>

      <div className="settings-field">
        <div className="settings-field-label">
          <span>Open Termilab from a browser</span>
          <small>Share this computer&apos;s sessions with your other devices through Tailscale. Only devices in your own tailnet can reach it.</small>
        </div>
        <button
          className={`settings-toggle ${enabled ? 'active' : ''}`}
          onClick={onToggle}
          disabled={!!reason || !!busy}
          aria-pressed={enabled}
          aria-label="Remote access"
        />
      </div>

      {reason && (
        <div className="ra-note" role="note">
          <p>{reason.text}</p>
          {reason.link && (
            <p>
              <a href={reason.link.href} target="_blank" rel="noreferrer" className="ra-link">{reason.link.label}</a>
            </p>
          )}
        </div>
      )}

      {!reason && (
        <>
          <div className="settings-field">
            <div className="settings-field-label">
              <span>Tailscale account</span>
              <small>Signed in as <strong className="ra-strong">{ts.login || 'unknown'}</strong></small>
            </div>
          </div>

          <div className="settings-field">
            <div className="settings-field-label">
              <span>Name of this computer</span>
              <small>How this PC is shown when you pick between several from the browser</small>
            </div>
            <div className="ra-name">
              <input
                type="text"
                value={nameDraft}
                maxLength={63}
                onChange={e => onNameChange(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && nameDirty) onNameSave(); }}
                aria-label="Name of this computer"
              />
              {nameDirty && (
                <button className="settings-test-btn" onClick={onNameSave} disabled={!!busy || !nameDraft.trim()}>
                  {busy === 'name' ? 'Saving…' : 'Save'}
                </button>
              )}
            </div>
          </div>

          {enabled && state.url && (
            <div className="ra-url">
              <p>Open this address on any device signed in to your tailnet:</p>
              <CopyBlock text={state.url} label="address" />
            </div>
          )}
        </>
      )}

      {shownError && shownError.code !== ts.reason && (
        <div className="cli-error" role="alert">
          {ERRORS[shownError.code] || shownError.message}
          {shownError.command && (
            <div className="ra-error-cmd"><CopyBlock text={shownError.command} label="command" /></div>
          )}
        </div>
      )}

      {/* With remote access on, closing the window only hides it: this quits for real.
          Desktop only (lifecycle is not exposed to the web or Android). */}
      {typeof window !== 'undefined' && typeof window.electronAPI?.lifecycle?.quit === 'function' && (
        <div className="settings-field">
          <div className="settings-field-label">
            <span>Quit Termilab</span>
            <small>Closing the window keeps Termilab running for your browser. This stops it, and remote access with it.</small>
          </div>
          <button className="settings-test-btn" onClick={() => { window.electronAPI.lifecycle.quit().catch(() => {}); }}>
            Quit Termilab
          </button>
        </div>
      )}
    </div>
  );
}

export default function RemoteAccess() {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [nameDraft, setNameDraft] = useState('');
  const mounted = useRef(false);

  const apply = (s) => {
    if (!mounted.current || !s) return;
    setState(s);
    setNameDraft(s.remoteAccess?.hostName || '');
  };

  useEffect(() => {
    mounted.current = true;
    const api = webApi();
    if (api && typeof api.status === 'function') api.status().then(apply).catch(() => {});
    return () => { mounted.current = false; };
  }, []);

  const run = async (kind, call) => {
    const api = webApi();
    if (!api || busy) return;
    setBusy(kind);
    setError(null);
    try {
      apply(await call(api));
    } catch (err) {
      if (mounted.current) setError({ code: 'error', message: err?.message || String(err) });
      try { apply(await api.status()); } catch (_) { /* keep the old state */ }
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  return (
    <RemoteAccessView
      state={state}
      busy={busy}
      error={error}
      nameDraft={nameDraft}
      onNameChange={setNameDraft}
      onNameSave={() => run('name', api => api.setName(nameDraft))}
      onToggle={() => run('toggle', api => (state?.remoteAccess?.enabled ? api.disable() : api.enable()))}
    />
  );
}
