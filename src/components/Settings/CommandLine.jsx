import React, { useState, useEffect, useRef } from 'react';
import { writeText } from '../Terminal/clipboardPaste';
import './CommandLine.css';

/*
 * Settings → General → "Command line": links termilab-cli and termilab-mcp
 * into a bin directory (~/.local/bin) on platforms whose package does not put
 * them on the PATH (macOS). Main owns everything; this only shows CliStatus:
 *
 *   window.electronAPI.cli.status() / install() / uninstall() -> {
 *     supported, reason,          // 'linux-packaged' | 'windows' | 'dev-build' | 'scripts-missing'
 *     binDir, installed, stale,   // stale: links that point at another copy of the app
 *     onPath, pathLine, shellRc,  // !onPath: the exact line to add, and the file it goes in
 *     entries: [{ name, linkPath, target }]
 *   }
 *
 * No API (browser, Android, an older main) or a failing status() -> renders
 * nothing. The !onPath note is the part that matters most: on a fresh Mac
 * ~/.local/bin is not on the PATH and "command not found" reads as "the
 * install did not work".
 */

const COMMANDS = ['termilab-cli', 'termilab-mcp'];
const MCP_EXAMPLE = 'claude mcp add termilab -- termilab-mcp';

const cliApi = () => (typeof window !== 'undefined' && window.electronAPI && window.electronAPI.cli) || null;

function CopyBlock({ text, label }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    const ok = await writeText(text);
    if (!ok) return;
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="cli-copy">
      <code className="cli-copy-text">{text}</code>
      <button
        type="button"
        className="cli-copy-btn"
        onClick={copy}
        aria-label={copied ? 'Copied' : `Copy ${label}`}
        title={copied ? 'Copied' : 'Copy'}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export function CommandLineView({ status, busy, error, onInstall, onUninstall }) {
  if (!status) return null;

  if (!status.supported) {
    if (status.reason !== 'linux-packaged') return null;
    return (
      <div className="settings-section">
        <div className="settings-section-title">Command line</div>
        <p className="cli-note">
          The <code className="cli-cmd">termilab-cli</code> and <code className="cli-cmd">termilab-mcp</code>{' '}
          commands come installed with the Termilab package, ready for scripts and AI agents.
        </p>
      </div>
    );
  }

  const names = Array.isArray(status.entries) && status.entries.length
    ? status.entries.map(e => e.name)
    : COMMANDS;
  const installed = !!status.installed;
  const stale = !!status.stale;

  return (
    <div className="settings-section">
      <div className="settings-section-title">Command line</div>

      {!installed && !stale && (
        <div className="settings-field">
          <div className="settings-field-label">
            <span>Command line tools</span>
            <small>Commands to use Termilab from scripts and AI agents</small>
          </div>
          <button className="settings-test-btn" onClick={onInstall} disabled={!!busy}>
            {busy === 'install' ? 'Installing…' : 'Install command line tools'}
          </button>
        </div>
      )}

      {stale && (
        <div className="settings-field">
          <div className="settings-field-label">
            <span>Command line tools</span>
            <small>
              The commands in <code className="cli-cmd">{status.binDir}</code> point to another copy of
              Termilab. Update them to use this one.
            </small>
          </div>
          <div className="cli-actions">
            <button className="settings-test-btn" onClick={onInstall} disabled={!!busy}>
              {busy === 'install' ? 'Updating…' : 'Update links'}
            </button>
          </div>
        </div>
      )}

      {installed && !stale && (
        <div className="settings-field">
          <div className="settings-field-label">
            <span>Command line tools</span>
            <small>Installed in <code className="cli-cmd">{status.binDir}</code></small>
          </div>
          <button className="cli-secondary-btn" onClick={onUninstall} disabled={!!busy}>
            {busy === 'uninstall' ? 'Removing…' : 'Uninstall'}
          </button>
        </div>
      )}

      {installed && (
        <ul className="cli-commands">
          {names.map(n => <li key={n}><code className="cli-cmd">{n}</code></li>)}
        </ul>
      )}

      {installed && !status.onPath && (
        <div className="cli-path-note" role="note">
          <p>
            <strong>One more step:</strong> <code className="cli-cmd">{status.binDir}</code> is not on your PATH,
            so a terminal will answer “command not found”. Add this line to{' '}
            {status.shellRc ? <code className="cli-cmd">{status.shellRc}</code> : 'your shell startup file'}:
          </p>
          {status.pathLine && <CopyBlock text={status.pathLine} label="PATH line" />}
          <p>Then open a new terminal. Terminals that are already open will not see the change.</p>
        </div>
      )}

      {installed && (
        <div className="cli-example">
          <p>To give an AI agent access, for example Claude Code:</p>
          <CopyBlock text={MCP_EXAMPLE} label="command" />
        </div>
      )}

      {error && <div className="cli-error" role="alert">{error}</div>}
    </div>
  );
}

export default function CommandLine() {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  const mounted = useRef(false);

  useEffect(() => {
    /* true on every mount: StrictMode mounts, cleans up and mounts again */
    mounted.current = true;
    const api = cliApi();
    if (api && typeof api.status === 'function') {
      api.status()
        .then(s => { if (mounted.current && s) setStatus(s); })
        .catch(() => {});
    }
    return () => { mounted.current = false; };
  }, []);

  const run = async (action) => {
    const api = cliApi();
    if (!api || typeof api[action] !== 'function' || busy) return;
    setBusy(action);
    setError('');
    try {
      const next = await api[action]();
      if (!mounted.current) return;
      if (next && typeof next === 'object') setStatus(next);
      else if (typeof api.status === 'function') setStatus(await api.status());
    } catch (err) {
      if (!mounted.current) return;
      setError(err?.message || String(err));
      /* the failure may have left things half done: show what is there now */
      try {
        const s = await api.status?.();
        if (mounted.current && s) setStatus(s);
      } catch (_) { /* keep the old status */ }
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  return (
    <CommandLineView
      status={status}
      busy={busy}
      error={error}
      onInstall={() => run('install')}
      onUninstall={() => run('uninstall')}
    />
  );
}
