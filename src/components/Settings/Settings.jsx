import React, { useState, useEffect, useRef } from 'react';
import { useApp } from '../../contexts/AppContext';
import { getThemeList } from '../../themes/terminal-themes';
import SyncPanel from '../Sync/SyncPanel';
import { IS_ANDROID } from '../../platform';
import { MobileTopBar } from '../Mobile/MobileScreen';
import './Settings.css';

const ACCENT_COLORS = [
  '#58a6ff', '#79c0ff', '#3fb950', '#56d364',
  '#d29922', '#e3b341', '#bc8cff', '#d2a8ff',
  '#ff7b72', '#ffa198', '#f778ba', '#ff9bce',
];

const APP_THEMES = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
];

const TABS = [
  { id: 'general', label: 'General', icon: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z' },
  { id: 'terminal', label: 'Terminal', icon: 'M4 17l6-6-6-6M12 19h8' },
  { id: 'appearance', label: 'Appearance', icon: 'M12 2.69l5.66 5.66a8 8 0 11-11.31 0z' },
  { id: 'about', label: 'About', icon: 'M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10zM12 16v-4M12 8h.01' },
];

/* onBack: Android only, the page's top bar (back / Settings / Save) */
export default function Settings({ fullPage = false, onBack }) {
  const { state, dispatch, actions } = useApp();
  const [settings, setSettings] = useState(state.settings);
  const [activeTab, setActiveTab] = useState('general');
  const [appVersion, setAppVersion] = useState('1.0.0');
  const [updateStatus, setUpdateStatus] = useState(null);
  const [saved, setSaved] = useState(false);
  const importFileRef = useRef(null);

  useEffect(() => { setSettings(state.settings); }, [state.settings]);

  useEffect(() => {
    if (window.electronAPI?.updater) {
      window.electronAPI.updater.getVersion?.().then(v => v && setAppVersion(v)).catch(() => {});
      const listener = window.electronAPI.updater.onStatus((data) => setUpdateStatus(data));
      return () => window.electronAPI.updater.removeStatusListener?.(listener);
    }
  }, []);

  const handleCheckUpdates = () => {
    setUpdateStatus({ status: 'checking' });
    window.electronAPI?.updater?.check?.().catch(() => setUpdateStatus({ status: 'error', message: 'Could not check for updates' }));
  };

  const update = (path, value) => {
    setSaved(false);
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
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleExportData = () => {
    /* Never dump settings blindly: a settings.json written before the AI
       assistant was removed still carries `ai` with API keys in clear text.
       Whitelisting is not possible here (settings grow), so drop `ai`
       explicitly and keep the rest. */
    const { ai: _droppedAiSettings, ...exportableSettings } = state.settings || {};

    const data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      hosts: state.hosts,
      groups: state.groups,
      snippets: state.snippets,
      keys: state.keys,
      portForwards: state.portForwards,
      settings: exportableSettings,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `termilab-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleImportData = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const data = JSON.parse(evt.target.result);
        if (!data.hosts && !data.groups && !data.snippets && !data.settings) {
          alert('Invalid backup file: no recognizable data found.');
          return;
        }
        const counts = [
          data.hosts?.length && `${data.hosts.length} hosts`,
          data.groups?.length && `${data.groups.length} groups`,
          data.snippets?.length && `${data.snippets.length} snippets`,
          data.keys?.length && `${data.keys.length} keys`,
          data.portForwards?.length && `${data.portForwards.length} port forwards`,
          data.settings && 'settings',
        ].filter(Boolean).join(', ');
        const ok = window.confirm(
          `Import will replace your current data with:\n${counts}\n\nThis cannot be undone. Continue?`
        );
        if (!ok) return;
        if (data.hosts) dispatch({ type: 'SET_HOSTS', payload: data.hosts });
        if (data.groups) dispatch({ type: 'SET_GROUPS', payload: data.groups });
        if (data.snippets) dispatch({ type: 'SET_SNIPPETS', payload: data.snippets });
        if (data.keys) dispatch({ type: 'SET_KEYS', payload: data.keys });
        if (data.portForwards) dispatch({ type: 'SET_PORT_FORWARDS', payload: data.portForwards });
        if (data.settings) {
          dispatch({ type: 'SET_SETTINGS', payload: data.settings });
          setSettings(data.settings);
        }
        /* Persist to Electron store if available */
        if (window.electronAPI?.store) {
          const store = window.electronAPI.store;
          if (data.hosts) await store.saveHosts?.(data.hosts).catch(() => {});
          if (data.groups) await store.saveGroups?.(data.groups).catch(() => {});
          if (data.snippets) await store.saveSnippets?.(data.snippets).catch(() => {});
          if (data.keys) await store.saveKeys?.(data.keys).catch(() => {});
          if (data.portForwards) await store.savePortForwards?.(data.portForwards).catch(() => {});
          if (data.settings) await store.saveSettings?.(data.settings).catch(() => {});
        }
        alert('✅ Data imported successfully!');
      } catch (err) {
        alert('❌ Failed to import: ' + err.message);
      }
    };
    reader.readAsText(file);
    // Reset so the same file can be re-selected
    e.target.value = '';
  };

  const mobileBar = IS_ANDROID && onBack;

  return (
    <div className={`settings-panel ${fullPage ? 'full-page' : ''}`}>
      {mobileBar ? (
        <MobileTopBar
          title="Settings"
          onBack={onBack}
          action={activeTab !== 'about' ? { label: saved ? 'Saved' : 'Save', onClick: handleSave } : null}
        />
      ) : fullPage ? (
        <div className="settings-full-header">
          <h2>Settings</h2>
          <p>Customize your Termilab experience</p>
        </div>
      ) : (
        <div className="settings-header">
          <h2>Settings</h2>
        </div>
      )}

      {/* Tab navigation */}
      <div className="settings-tabs">
        {TABS.map(tab => (
          <button
            key={tab.id}
            className={`settings-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d={tab.icon} />
            </svg>
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      <div className="settings-content">

        {/* ═══ General Tab ═══ */}
        {activeTab === 'general' && (
          <>
            <div className="settings-section">
              <div className="settings-section-title">Connection</div>

              <div className="settings-field">
                <div className="settings-field-label">
                  <span>Default SSH Port</span>
                  <small>Port used when not specified</small>
                </div>
                <input
                  type="number"
                  value={settings.ssh?.defaultPort || 22}
                  onChange={e => update('ssh.defaultPort', parseInt(e.target.value, 10))}
                  min="1" max="65535"
                />
              </div>

              <div className="settings-field">
                <div className="settings-field-label">
                  <span>Keep-Alive Interval</span>
                  <small>Seconds between keep-alive packets</small>
                </div>
                <input
                  type="number"
                  value={settings.ssh?.keepAliveInterval || 30}
                  onChange={e => update('ssh.keepAliveInterval', parseInt(e.target.value, 10))}
                  min="5" max="120"
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

            <div className="settings-section">
              <div className="settings-section-title">Sync</div>
              <SyncPanel />
            </div>

            <div className="settings-section">
              <div className="settings-section-title">Data Management</div>

              <div className="settings-field">
                <div className="settings-field-label">
                  <span>Export Data</span>
                  <small>Download all hosts, groups, snippets, keys, port forwards and settings as a JSON backup file</small>
                </div>
                <button className="settings-test-btn" onClick={handleExportData}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 14, height: 14, marginRight: 6 }}>
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  Export
                </button>
              </div>

              <div className="settings-field">
                <div className="settings-field-label">
                  <span>Import Data</span>
                  <small>Restore from a previously exported JSON backup file</small>
                </div>
                <input
                  ref={importFileRef}
                  type="file"
                  accept=".json"
                  style={{ display: 'none' }}
                  onChange={handleImportData}
                />
                <button className="settings-test-btn" onClick={() => importFileRef.current?.click()}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 14, height: 14, marginRight: 6 }}>
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  Import
                </button>
              </div>
            </div>
          </>
        )}

        {/* ═══ Terminal Tab ═══ */}
        {activeTab === 'terminal' && (
          <>
          <div className="settings-section">
            <div className="settings-section-title">Color Theme</div>
            <div className="theme-grid">
              {getThemeList().map(theme => (
                <button
                  key={theme.id}
                  className={`theme-card ${(settings.terminal?.theme || 'github-dark') === theme.id ? 'active' : ''}`}
                  onClick={() => update('terminal.theme', theme.id)}
                  title={theme.description}
                >
                  <div className="theme-preview" style={{ background: theme.colors.background }}>
                    <span style={{ color: theme.colors.green }}>$</span>
                    <span style={{ color: theme.colors.foreground }}> echo </span>
                    <span style={{ color: theme.colors.yellow }}>"hello"</span>
                    <br/>
                    <span style={{ color: theme.colors.blue }}>user</span>
                    <span style={{ color: theme.colors.foreground }}>@</span>
                    <span style={{ color: theme.colors.magenta }}>host</span>
                    <span style={{ color: theme.colors.cursor }}>█</span>
                  </div>
                  <div className="theme-colors">
                    {[theme.colors.red, theme.colors.green, theme.colors.yellow, theme.colors.blue, theme.colors.magenta, theme.colors.cyan].map((c, i) => (
                      <span key={i} className="theme-dot" style={{ background: c }} />
                    ))}
                  </div>
                  <span className="theme-name">{theme.name}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-title">Terminal Preferences</div>

            <div className="settings-field">
              <div className="settings-field-label">
                <span>Font Size</span>
                <small>Terminal font size in pixels</small>
              </div>
              <input
                type="number"
                value={settings.terminal?.fontSize || 14}
                onChange={e => update('terminal.fontSize', parseInt(e.target.value, 10))}
                min="8" max="32"
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
                min="100" max="100000" step="500"
              />
            </div>

            <div className="settings-field">
              <div className="settings-field-label">
                <span>Copy on Select</span>
                <small>Automatically copy text when selected</small>
              </div>
              <button
                className={`settings-toggle ${settings.terminal?.copyOnSelect !== false ? 'active' : ''}`}
                onClick={() => update('terminal.copyOnSelect', !(settings.terminal?.copyOnSelect !== false))}
              />
            </div>
          </div>
          </>
        )}

        {/* ═══ Appearance Tab ═══ */}
        {activeTab === 'appearance' && (
          <div className="settings-section">
            <div className="settings-section-title">Theme</div>

            <div className="settings-field">
              <div className="settings-field-label">
                <span>App Theme</span>
                <small>Colors of the interface around the terminal</small>
              </div>
              <div className="settings-theme-toggle">
                {APP_THEMES.map(t => (
                  <button
                    key={t.id}
                    className={`settings-theme-option ${(settings.appearance?.theme || 'dark') === t.id ? 'active' : ''}`}
                    onClick={() => update('appearance.theme', t.id)}
                  >
                    <span className={`settings-theme-swatch ${t.id}`} aria-hidden="true" />
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

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
        )}

        {/* ═══ About Tab ═══ */}
        {activeTab === 'about' && (
          <div className="settings-section">
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
                  <button className="settings-update-btn primary" onClick={() => window.electronAPI?.updater?.download?.()}>
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
                  <button className="settings-update-btn primary" onClick={() => window.electronAPI?.updater?.install?.()}>
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
        )}
      </div>

      {activeTab !== 'about' && !mobileBar && (
        <div className="settings-save-bar">
          <button className={`settings-save-btn ${saved ? 'saved' : ''}`} onClick={handleSave}>
            {saved ? '✓ Saved!' : 'Save Settings'}
          </button>
        </div>
      )}
    </div>
  );
}
