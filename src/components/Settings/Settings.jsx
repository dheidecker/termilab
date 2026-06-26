import React, { useState, useEffect } from 'react';
import { useApp } from '../../contexts/AppContext';
import { getThemeList } from '../../themes/terminal-themes';
import './Settings.css';

const ACCENT_COLORS = [
  '#58a6ff', '#79c0ff', '#3fb950', '#56d364',
  '#d29922', '#e3b341', '#bc8cff', '#d2a8ff',
  '#ff7b72', '#ffa198', '#f778ba', '#ff9bce',
];

const TABS = [
  { id: 'general', label: 'General', icon: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z' },
  { id: 'terminal', label: 'Terminal', icon: 'M4 17l6-6-6-6M12 19h8' },
  { id: 'appearance', label: 'Appearance', icon: 'M12 2.69l5.66 5.66a8 8 0 11-11.31 0z' },
  { id: 'ai', label: 'AI Assistant', icon: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5' },
  { id: 'about', label: 'About', icon: 'M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10zM12 16v-4M12 8h.01' },
];

export default function Settings({ fullPage = false }) {
  const { state, actions } = useApp();
  const [settings, setSettings] = useState(state.settings);
  const [activeTab, setActiveTab] = useState('general');
  const [appVersion, setAppVersion] = useState('1.0.0');
  const [updateStatus, setUpdateStatus] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => { setSettings(state.settings); }, [state.settings]);

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

  return (
    <div className={`settings-panel ${fullPage ? 'full-page' : ''}`}>
      {fullPage ? (
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
              <div className="settings-sync-placeholder">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="23 4 23 10 17 10" />
                  <polyline points="1 20 1 14 7 14" />
                  <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
                </svg>
                <p>Cloud sync is coming soon.<br />Your settings and hosts will sync across devices.</p>
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

        {/* ═══ AI Assistant Tab ═══ */}
        {activeTab === 'ai' && (
          <>
            <div className="settings-section">
              <div className="settings-section-title">Provider</div>

              <div className="settings-field">
                <div className="settings-field-label">
                  <span>Active Provider</span>
                  <small>Select your preferred AI provider</small>
                </div>
                <select
                  value={settings.ai?.provider || 'claude-api'}
                  onChange={e => update('ai.provider', e.target.value)}
                >
                  <option value="claude-api">Claude (Anthropic)</option>
                  <option value="deepseek">DeepSeek</option>
                  <option value="openai">OpenAI</option>
                </select>
              </div>
            </div>

            {/* Claude API */}
            {(settings.ai?.provider || 'claude-api') === 'claude-api' && (
              <div className="settings-section">
                <div className="settings-section-title">Claude Configuration</div>
                <div className="settings-field">
                  <div className="settings-field-label">
                    <span>API Key</span>
                    <small>Get your key at console.anthropic.com</small>
                  </div>
                  <div className="settings-api-key-row">
                    <input
                      type="password"
                      value={settings.ai?.claudeApiKey || ''}
                      onChange={e => update('ai.claudeApiKey', e.target.value)}
                      placeholder="sk-ant-api03-..."
                    />
                    <button
                      className="settings-test-btn"
                      onClick={async () => {
                        try {
                          const key = settings.ai?.claudeApiKey;
                          if (!key) return alert('Enter an API key first');
                          const res = await window.electronAPI?.ai?.chat({
                            messages: [{ role: 'user', content: 'Say "Connected!" in one word' }],
                            terminalContext: '',
                            apiKey: key,
                            model: settings.ai?.claudeModel || 'claude-opus-4.8',
                            provider: 'claude-api',
                          });
                          alert(res ? '✅ Connection successful!' : '❌ Failed');
                        } catch (err) {
                          alert('❌ ' + err.message);
                        }
                      }}
                    >Test</button>
                  </div>
                </div>
                <div className="settings-field">
                  <div className="settings-field-label">
                    <span>Model</span>
                    <small>Claude model for assistance</small>
                  </div>
                  <select
                    value={settings.ai?.claudeModel || 'claude-opus-4.8'}
                    onChange={e => update('ai.claudeModel', e.target.value)}
                  >
                    <option value="claude-opus-4.8">Claude Opus 4.8 (Recommended)</option>
                    <option value="claude-sonnet-4.6">Claude Sonnet 4.6</option>
                    <option value="claude-haiku-4.5">Claude Haiku 4.5 (Fast)</option>
                  </select>
                </div>
              </div>
            )}

            {/* DeepSeek */}
            {settings.ai?.provider === 'deepseek' && (
              <div className="settings-section">
                <div className="settings-section-title">DeepSeek Configuration</div>
                <div className="settings-field">
                  <div className="settings-field-label">
                    <span>API Key</span>
                    <small>Get your key at platform.deepseek.com</small>
                  </div>
                  <div className="settings-api-key-row">
                    <input
                      type="password"
                      value={settings.ai?.deepseekApiKey || ''}
                      onChange={e => update('ai.deepseekApiKey', e.target.value)}
                      placeholder="sk-..."
                    />
                    <button className="settings-test-btn" onClick={async () => {
                        try {
                          const key = settings.ai?.deepseekApiKey;
                          if (!key) return alert('Enter an API key first');
                          await window.electronAPI?.ai?.chat({
                            messages: [{ role: 'user', content: 'Say "Connected!" in one word' }],
                            terminalContext: '', apiKey: key,
                            model: settings.ai?.deepseekModel || 'deepseek-v4-pro',
                            provider: 'deepseek',
                          });
                          alert('✅ Connection successful!');
                        } catch (err) { alert('❌ ' + err.message); }
                      }}>Test</button>
                  </div>
                </div>
                <div className="settings-field">
                  <div className="settings-field-label">
                    <span>Model</span>
                    <small>DeepSeek model to use</small>
                  </div>
                  <select
                    value={settings.ai?.deepseekModel || 'deepseek-v4-pro'}
                    onChange={e => update('ai.deepseekModel', e.target.value)}
                  >
                    <option value="deepseek-v4-pro">DeepSeek V4 Pro (Recommended)</option>
                    <option value="deepseek-v4-flash">DeepSeek V4 Flash (Fast)</option>
                  </select>
                </div>
              </div>
            )}

            {/* OpenAI */}
            {settings.ai?.provider === 'openai' && (
              <div className="settings-section">
                <div className="settings-section-title">OpenAI Configuration</div>
                <div className="settings-field">
                  <div className="settings-field-label">
                    <span>API Key</span>
                    <small>Get your key at platform.openai.com</small>
                  </div>
                  <div className="settings-api-key-row">
                    <input
                      type="password"
                      value={settings.ai?.openaiApiKey || ''}
                      onChange={e => update('ai.openaiApiKey', e.target.value)}
                      placeholder="sk-..."
                    />
                    <button className="settings-test-btn" onClick={async () => {
                        try {
                          const key = settings.ai?.openaiApiKey;
                          if (!key) return alert('Enter an API key first');
                          await window.electronAPI?.ai?.chat({
                            messages: [{ role: 'user', content: 'Say "Connected!" in one word' }],
                            terminalContext: '', apiKey: key,
                            model: settings.ai?.openaiModel || 'gpt-5.5',
                            provider: 'openai',
                          });
                          alert('✅ Connection successful!');
                        } catch (err) { alert('❌ ' + err.message); }
                      }}>Test</button>
                  </div>
                </div>
                <div className="settings-field">
                  <div className="settings-field-label">
                    <span>Model</span>
                    <small>OpenAI model to use</small>
                  </div>
                  <select
                    value={settings.ai?.openaiModel || 'gpt-5.5'}
                    onChange={e => update('ai.openaiModel', e.target.value)}
                  >
                    <option value="gpt-5.5">GPT-5.5 (Recommended)</option>
                    <option value="gpt-5.4">GPT-5.4</option>
                    <option value="gpt-5.4-mini">GPT-5.4 Mini (Fast)</option>
                  </select>
                </div>
              </div>
            )}

            <div className="settings-section">
              <div className="settings-section-title">Behavior</div>
              <div className="settings-field">
                <div className="settings-field-label">
                  <span>Default Mode</span>
                  <small>How the AI handles command execution</small>
                </div>
                <select
                  value={settings.ai?.defaultMode || 'ask'}
                  onChange={e => update('ai.defaultMode', e.target.value)}
                >
                  <option value="ask">Ask — Approve each command</option>
                  <option value="auto-approve">Auto-Approve — Auto-run safe, ask for risky</option>
                  <option value="autonomous">Autonomous — Run everything</option>
                </select>
              </div>
              <div className="settings-field">
                <div className="settings-field-label">
                  <span>Terminal Context Lines</span>
                  <small>Lines of terminal output sent as context</small>
                </div>
                <input
                  type="number"
                  value={settings.ai?.contextLines || 50}
                  onChange={e => update('ai.contextLines', parseInt(e.target.value, 10))}
                  min="10" max="200" step="10"
                />
              </div>
            </div>
          </>
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

      {activeTab !== 'about' && (
        <div className="settings-save-bar">
          <button className={`settings-save-btn ${saved ? 'saved' : ''}`} onClick={handleSave}>
            {saved ? '✓ Saved!' : 'Save Settings'}
          </button>
        </div>
      )}
    </div>
  );
}
