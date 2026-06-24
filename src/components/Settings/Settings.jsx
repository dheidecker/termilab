import React, { useState, useEffect } from 'react';
import { useApp } from '../../contexts/AppContext';
import './Settings.css';

const ACCENT_COLORS = [
  '#58a6ff', '#79c0ff', '#3fb950', '#56d364',
  '#d29922', '#e3b341', '#bc8cff', '#d2a8ff',
  '#ff7b72', '#ffa198', '#f778ba', '#ff9bce',
];

export default function Settings({ fullPage = false }) {
  const { state, actions } = useApp();
  const [settings, setSettings] = useState(state.settings);
  const [appVersion, setAppVersion] = useState('1.0.0');
  const [updateStatus, setUpdateStatus] = useState(null); // null | {status, version?, percent?, message?}

  useEffect(() => {
    setSettings(state.settings);
  }, [state.settings]);

  /* Get app version and listen for update events */
  useEffect(() => {
    if (window.electronAPI?.updater) {
      window.electronAPI.updater.getVersion?.().then(v => v && setAppVersion(v)).catch(() => {});
      window.electronAPI.updater.onStatus((data) => setUpdateStatus(data));
      return () => window.electronAPI.updater.removeStatusListener?.();
    }
  }, []);

  const handleCheckUpdates = () => {
    setUpdateStatus({ status: 'checking' });
    window.electronAPI?.updater?.check?.().catch(() => setUpdateStatus({ status: 'error', message: 'Could not check for updates' }));
  };

  const handleDownloadUpdate = () => {
    window.electronAPI?.updater?.download?.();
  };

  const handleInstallUpdate = () => {
    window.electronAPI?.updater?.install?.();
  };

  const update = (path, value) => {
    setSettings(prev => {
      const copy = JSON.parse(JSON.stringify(prev));
      const keys = path.split('.');
      let obj = copy;
      for (let i = 0; i < keys.length - 1; i++) {
        if (!obj[keys[i]]) obj[keys[i]] = {};
        obj = obj[keys[i]];
      }
      obj[keys[keys.length - 1]] = value;
      return copy;
    });
  };

  const handleSave = () => {
    actions.saveSettings(settings);
  };

  return (
    <div className={`settings-panel ${fullPage ? 'full-page' : ''}`}>
      {fullPage ? (
        <div className="settings-full-header">
          <h2>Settings</h2>
          <p>Customize your Terminal experience</p>
        </div>
      ) : (
        <div className="settings-header">
          <h2>Settings</h2>
        </div>
      )}

      <div className="settings-content">
        {/* General */}
        <div className="settings-section">
          <div className="settings-section-title">General</div>

          <div className="settings-field">
            <div className="settings-field-label">
              <span>Default SSH Port</span>
              <small>Port used when not specified</small>
            </div>
            <input
              type="number"
              value={settings.ssh?.defaultPort || 22}
              onChange={e => update('ssh.defaultPort', parseInt(e.target.value, 10))}
              min="1"
              max="65535"
            />
          </div>

          <div className="settings-field">
            <div className="settings-field-label">
              <span>Connection Timeout</span>
              <small>Seconds before connection times out</small>
            </div>
            <input
              type="number"
              value={settings.ssh?.keepAliveInterval || 30}
              onChange={e => update('ssh.keepAliveInterval', parseInt(e.target.value, 10))}
              min="5"
              max="120"
            />
          </div>

          <div className="settings-field">
            <div className="settings-field-label">
              <span>Auto-connect</span>
              <small>Reconnect sessions on startup</small>
            </div>
            <button
              className={`settings-toggle ${settings.general?.autoConnect ? 'active' : ''}`}
              onClick={() => update('general.autoConnect', !settings.general?.autoConnect)}
            />
          </div>
        </div>

        {/* Terminal */}
        <div className="settings-section">
          <div className="settings-section-title">Terminal</div>

          <div className="settings-field">
            <div className="settings-field-label">
              <span>Font Size</span>
              <small>Terminal font size in pixels</small>
            </div>
            <input
              type="number"
              value={settings.terminal?.fontSize || 14}
              onChange={e => update('terminal.fontSize', parseInt(e.target.value, 10))}
              min="8"
              max="32"
            />
          </div>

          <div className="settings-field">
            <div className="settings-field-label">
              <span>Font Family</span>
              <small>Monospace font for terminal</small>
            </div>
            <select
              value={settings.terminal?.fontFamily || 'JetBrains Mono'}
              onChange={e => update('terminal.fontFamily', e.target.value)}
            >
              <option value="JetBrains Mono">JetBrains Mono</option>
              <option value="Fira Code">Fira Code</option>
              <option value="Cascadia Code">Cascadia Code</option>
              <option value="Consolas">Consolas</option>
              <option value="Monaco">Monaco</option>
              <option value="monospace">System Mono</option>
            </select>
          </div>

          <div className="settings-field">
            <div className="settings-field-label">
              <span>Cursor Style</span>
              <small>Terminal cursor appearance</small>
            </div>
            <select
              value={settings.terminal?.cursorStyle || 'block'}
              onChange={e => update('terminal.cursorStyle', e.target.value)}
            >
              <option value="block">Block</option>
              <option value="underline">Underline</option>
              <option value="bar">Bar</option>
            </select>
          </div>

          <div className="settings-field">
            <div className="settings-field-label">
              <span>Scrollback Lines</span>
              <small>Number of lines to keep in buffer</small>
            </div>
            <input
              type="number"
              value={settings.terminal?.scrollback || 5000}
              onChange={e => update('terminal.scrollback', parseInt(e.target.value, 10))}
              min="100"
              max="100000"
              step="500"
            />
          </div>
        </div>

        {/* Appearance */}
        <div className="settings-section">
          <div className="settings-section-title">Appearance</div>

          <div className="settings-field">
            <div className="settings-field-label">
              <span>Accent Color</span>
              <small>Primary accent color across the app</small>
            </div>
            <div className="settings-color-picker">
              {ACCENT_COLORS.map(color => (
                <button
                  key={color}
                  className={`settings-color-swatch ${settings.appearance?.accentColor === color ? 'active' : ''}`}
                  style={{ background: color }}
                  onClick={() => update('appearance.accentColor', color)}
                  title={color}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Sync */}
        <div className="settings-section">
          <div className="settings-section-title">Sync</div>
          <div className="settings-sync-placeholder">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
            </svg>
            <p>Cloud sync is coming soon.<br />Your settings and hosts will sync across devices.</p>
          </div>
        </div>
        {/* About & Updates */}
        <div className="settings-section">
          <div className="settings-section-title">About</div>
          <div className="settings-about">
            <div className="settings-about-logo">
              <svg viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
            </div>
            <div className="settings-about-info">
              <div className="settings-about-name">Termilab</div>
              <div className="settings-about-version">Version {appVersion}</div>
            </div>
          </div>

          <div className="settings-update-section">
            {!updateStatus || updateStatus.status === 'error' ? (
              <button className="settings-update-btn" onClick={handleCheckUpdates}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="23 4 23 10 17 10" />
                  <polyline points="1 20 1 14 7 14" />
                  <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
                </svg>
                Check for Updates
              </button>
            ) : null}

            {updateStatus?.status === 'checking' && (
              <div className="settings-update-status">
                <div className="settings-update-spinner" />
                <span>Checking for updates...</span>
              </div>
            )}

            {updateStatus?.status === 'up-to-date' && (
              <div className="settings-update-status success">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12" /></svg>
                <span>Termilab is up to date!</span>
              </div>
            )}

            {updateStatus?.status === 'available' && (
              <div className="settings-update-available">
                <div className="settings-update-status">
                  <svg viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  <span>Version {updateStatus.version} is available!</span>
                </div>
                <button className="settings-update-btn primary" onClick={handleDownloadUpdate}>
                  Download Update
                </button>
              </div>
            )}

            {updateStatus?.status === 'downloading' && (
              <div className="settings-update-status">
                <div className="settings-update-progress">
                  <div className="settings-update-progress-bar" style={{ width: `${updateStatus.percent || 0}%` }} />
                </div>
                <span>Downloading... {updateStatus.percent || 0}%</span>
              </div>
            )}

            {updateStatus?.status === 'ready' && (
              <div className="settings-update-available">
                <div className="settings-update-status success">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12" /></svg>
                  <span>Update ready! Version {updateStatus.version}</span>
                </div>
                <button className="settings-update-btn primary" onClick={handleInstallUpdate}>
                  Restart & Install
                </button>
              </div>
            )}

            {updateStatus?.status === 'error' && (
              <div className="settings-update-status error">
                <span>{updateStatus.message || 'Update check failed'}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="settings-save-bar">
        <button className="settings-save-btn" onClick={handleSave}>
          Save Settings
        </button>
      </div>
    </div>
  );
}
