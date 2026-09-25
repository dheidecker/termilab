import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { useApp } from '../../contexts/AppContext';
import { getTheme } from '../../themes/terminal-themes';
import { IS_ANDROID } from '../../platform';
import ExtraKeys, { useStickyModifiers } from './mobile/ExtraKeys';
import SessionHeader from './mobile/SessionHeader';
import { applyModifiers, keySequence } from './mobile/keys';
import { attachTouch, readPinchedFont, writePinchedFont, FONT_EVENT } from './mobile/touch';
import { readClipboard, writeClipboard } from './mobile/clipboard';
import { sessionStatus } from '../Mobile/sessions';
import { liveSessionId } from '../SplitPane/sessions';
import './TerminalView.css';

const hasApi = () => typeof window !== 'undefined' && !!window.electronAPI;

export default function TerminalView({ tab }) {
  const { state, dispatch } = useApp();
  const termRef = useRef(null);
  const containerRef = useRef(null);
  const fitAddonRef = useRef(null);
  const searchAddonRef = useRef(null);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [connected, setConnected] = useState(false);
  const initializedRef = useRef(false);
  const sessionIdRef = useRef(null);
  const mountedRef = useRef(true);
  const [isLogging, setIsLogging] = useState(false);
  const logBufferRef = useRef([]);
  const isLoggingRef = useRef(false);
  const activeTabIdRef = useRef(state.activeTabId);
  const broadcastRef = useRef(state.broadcast);
  const tabsRef = useRef(state.tabs);
  /* Android: sticky Ctrl/Alt from the extra-keys row modify what the soft
     keyboard types; keys the row itself sends skip that (bypassRef). */
  const modifiers = useStickyModifiers();
  const inputFilterRef = useRef(null);
  const bypassRef = useRef(false);
  const [hasSelection, setHasSelection] = useState(false);
  inputFilterRef.current = IS_ANDROID ? (data) => {
    if (bypassRef.current) return data;
    const mods = modifiers.peek();
    if (!mods.ctrl && !mods.alt) return data;
    const r = applyModifiers(data, mods);
    if (r.used) modifiers.spend();
    return r.data;
  } : null;

  /* Keep broadcast & tabs refs in sync with state */
  useEffect(() => { broadcastRef.current = state.broadcast; }, [state.broadcast]);
  useEffect(() => { tabsRef.current = state.tabs; }, [state.tabs]);

  const isLocal = tab.type === 'local-terminal';

  /* Terminal settings from app */
  const termSettings = state.settings?.terminal || {};
  const termSettingsRef = useRef(termSettings);
  termSettingsRef.current = termSettings;
  const lastSettingsFontRef = useRef(undefined);

  useEffect(() => {
    /* For SSH tabs: wait until sessionId is available (connecting is done) */
    if (!isLocal && tab.connecting) return;
    if (!isLocal && !tab.sessionId) return;
    if (initializedRef.current || !containerRef.current) return;
    initializedRef.current = true;
    mountedRef.current = true;
    /* This run's cleanup happened (pane closed, or StrictMode's remount) */
    let disposed = false;

    const term = new Terminal({
      fontFamily: termSettings.fontFamily || 'JetBrains Mono, Consolas, monospace',
      fontSize: (IS_ANDROID && readPinchedFont()) || termSettings.fontSize || 14,
      cursorStyle: termSettings.cursorStyle || 'block',
      cursorBlink: true,
      scrollback: termSettings.scrollback || 5000,
      theme: getTheme(termSettings.theme || 'github-dark'),
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    const searchAddon = new SearchAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.loadAddon(searchAddon);

    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;
    termRef.current = term;

    term.open(containerRef.current);

    /* ─── Bell notification for inactive tabs ─── */
    term.onBell(() => {
      if (tab.id !== activeTabIdRef.current) {
        dispatch({ type: 'TAB_NOTIFY', payload: tab.id });
      }
    });

    /* ─── Copy / Paste support ─── */
    term.attachCustomKeyEventHandler((ev) => {
      // Ctrl+Shift+C → Copy selection
      if (ev.ctrlKey && ev.shiftKey && ev.key === 'C' && ev.type === 'keydown') {
        const sel = term.getSelection();
        if (sel) navigator.clipboard.writeText(sel);
        return false;
      }
      // Ctrl+Shift+V → Paste from clipboard
      if (ev.ctrlKey && ev.shiftKey && ev.key === 'V' && ev.type === 'keydown') {
        navigator.clipboard.readText().then(text => {
          if (text) {
            const sid = sessionIdRef.current;
            if (isLocal) {
              window.electronAPI?.localShell?.write(sid, text);
            } else {
              window.electronAPI?.ssh?.sendData(sid, text);
            }
          }
        });
        return false;
      }
      // Ctrl+F → Search
      if (ev.ctrlKey && !ev.shiftKey && ev.key === 'f' && ev.type === 'keydown') {
        setShowSearch(true);
        return false;
      }
      return true;
    });

    /* Right-click → paste (on Android a long-press is a contextmenu too:
       there it selects instead, see mobile/touch.js) */
    if (!IS_ANDROID) containerRef.current.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      navigator.clipboard.readText().then(text => {
        if (text) {
          const sid = sessionIdRef.current;
          if (isLocal) {
            window.electronAPI?.localShell?.write(sid, text);
          } else {
            window.electronAPI?.ssh?.sendData(sid, text);
          }
        }
      });
    });

    /* Android: pinch zoom, long-press selection, and the size other
       terminals were pinched to. */
    let detachTouch = null;
    const onPinchedFont = (e) => {
      const size = e.detail || termSettingsRef.current.fontSize || 14;
      if (term.options.fontSize !== size) term.options.fontSize = size;
      requestAnimationFrame(() => { try { fitAddon.fit(); } catch (err) { /* ignore */ } });
    };
    if (IS_ANDROID) {
      detachTouch = attachTouch(term, () => fitAddon.fit(), containerRef.current);
      /* For checks over CDP on the emulator (selection, modes); page-local */
      containerRef.current.__xterm = term;
      term.onSelectionChange(() => setHasSelection(term.hasSelection()));
      /* The keyboard or a rotation shrinks the rows: keep the prompt in view */
      term.onResize(() => term.scrollToBottom());
      window.addEventListener(FONT_EVENT, onPinchedFont);
    }
    /* Input from the keyboard, after the sticky modifiers */
    const filterInput = (data) => (inputFilterRef.current ? inputFilterRef.current(data) : data);

    /* Fit after a small delay */
    requestAnimationFrame(() => {
      try { fitAddon.fit(); } catch (e) { /* ignore */ }
    });


    /* Setup data flow based on mode */
    if (hasApi()) {
      if (isLocal) {
        /* ─── Local Terminal Mode ─── */
        term.writeln('\x1b[90mOpening local shell...\x1b[0m');

        /* Register data listeners FIRST with a pending queue */
        const pendingData = [];
        let sessionReady = false;

        window.electronAPI.localShell.onData((sid, data) => {
          if (!mountedRef.current) return;
          if (!sessionReady) {
            pendingData.push({ sid, data });
            return;
          }
          if (sid === sessionIdRef.current) {
            term.write(data);
            if (isLoggingRef.current) {
              logBufferRef.current.push(data);
            }
          }
        });

        window.electronAPI.localShell.onClose((sid, exitCode) => {
          if (mountedRef.current && sid === sessionIdRef.current) {
            setConnected(false);
            term.writeln('\r\n\x1b[90m[Session ended]\x1b[0m');
          }
        });

        window.electronAPI.localShell.onError((sid, error) => {
          if (mountedRef.current && sid === sessionIdRef.current) {
            term.writeln(`\r\n\x1b[31m[Error: ${error}]\x1b[0m`);
          }
        });

        /* Now spawn the shell */
        const cols = term.cols || 80;
        const rows = term.rows || 24;

        window.electronAPI.localShell.spawn({ cols, rows })
          .then((result) => {
            const realSessionId = result?.sessionId;
            /* Closed before the pty existed: nobody else knows its id, so
               nobody else would ever kill it */
            if (disposed || !mountedRef.current) {
              if (realSessionId) window.electronAPI.localShell.kill(realSessionId)?.catch?.(() => {});
              return;
            }
            if (!realSessionId) return;

            sessionIdRef.current = realSessionId;
            sessionReady = true;
            setConnected(true);
            /* tab.sessionId is only a placeholder: closing, broadcast and
               snippets need the pty's id (not in this effect's deps) */
            dispatch({ type: 'UPDATE_TAB', payload: { id: tab.id, ptySessionId: realSessionId } });

            /* Flush any queued data */
            for (const item of pendingData) {
              if (item.sid === realSessionId) {
                term.write(item.data);
              }
            }
            pendingData.length = 0;

            /* Clear the "Opening..." message */
            term.clear();

            /* Terminal -> local shell */
            term.onData((raw) => {
              const data = filterInput(raw);
              if (sessionIdRef.current) {
                window.electronAPI.localShell.write(sessionIdRef.current, data);
              }
              /* Broadcast: forward input to all other terminal sessions */
              if (broadcastRef.current) {
                const currentSid = sessionIdRef.current;
                tabsRef.current.forEach(otherTab => {
                  const sid = liveSessionId(otherTab);
                  if (!sid || sid === currentSid) return;
                  if (otherTab.type === 'local-terminal') {
                    window.electronAPI.localShell.write(sid, data);
                  } else if (otherTab.type === 'terminal' || otherTab.type === 'ssh') {
                    window.electronAPI.ssh.sendData(sid, data);
                  }
                });
              }
            });

            /* Resize */
            term.onResize(({ cols: c, rows: r }) => {
              if (sessionIdRef.current) {
                window.electronAPI.localShell.resize(sessionIdRef.current, c, r);
              }
            });

            /* Send initial fit resize */
            try {
              fitAddon.fit();
              window.electronAPI.localShell.resize(realSessionId, term.cols, term.rows);
            } catch (e) { /* ignore */ }
          })
          .catch((err) => {
            if (!mountedRef.current) return;
            term.writeln(`\x1b[31m✗ Failed to open local shell:\x1b[0m`);
            term.writeln(`\x1b[31m  ${err.message || err}\x1b[0m`);
          });

      } else {
        /* ─── SSH Terminal Mode ─── */
        if (!tab.sessionId) return;  /* Still connecting — don't init yet */
        sessionIdRef.current = tab.sessionId;

        /* Register listeners */
        window.electronAPI.ssh.onData((sid, data) => {
          if (mountedRef.current && sid === sessionIdRef.current) {
            term.write(data);
            if (isLoggingRef.current) {
              logBufferRef.current.push(data);
            }
          }
        });

        window.electronAPI.ssh.onClose((sid) => {
          if (mountedRef.current && sid === sessionIdRef.current) {
            setConnected(false);
            /* The Sessions screen shows it as disconnected */
            if (IS_ANDROID) dispatch({ type: 'UPDATE_TAB', payload: { id: tab.id, closed: true } });
            term.writeln('\r\n\x1b[90m[Connection closed]\x1b[0m');
          }
        });

        window.electronAPI.ssh.onError((sid, error) => {
          if (mountedRef.current && sid === sessionIdRef.current) {
            term.writeln(`\r\n\x1b[31m[Error: ${error}]\x1b[0m`);
          }
        });

        /* Terminal -> SSH */
        term.onData((raw) => {
          const data = filterInput(raw);
          if (sessionIdRef.current) {
            window.electronAPI.ssh.sendData(sessionIdRef.current, data);
          }
          /* Broadcast: forward input to all other terminal sessions */
          if (broadcastRef.current) {
            const currentSid = sessionIdRef.current;
            tabsRef.current.forEach(otherTab => {
              const sid = liveSessionId(otherTab);
              if (!sid || sid === currentSid) return;
              if (otherTab.type === 'local-terminal') {
                window.electronAPI.localShell.write(sid, data);
              } else if (otherTab.type === 'terminal' || otherTab.type === 'ssh') {
                window.electronAPI.ssh.sendData(sid, data);
              }
            });
          }
        });

        /* Resize */
        term.onResize(({ cols: c, rows: r }) => {
          if (sessionIdRef.current) {
            window.electronAPI.ssh.resize(sessionIdRef.current, c, r);
          }
        });

        setConnected(true);

        /* Send initial resize to sync terminal dimensions */
        setTimeout(() => {
          if (!mountedRef.current) return;
          try {
            fitAddon.fit();
            window.electronAPI.ssh.resize(sessionIdRef.current, term.cols, term.rows);
          } catch (e) { /* ignore */ }
        }, 100);
      }
    } else {
      /* ─── Mock mode for browser dev ─── */
      setConnected(true);
      const username = isLocal ? 'user' : (tab.label || 'demo');
      const hostname = isLocal ? 'localhost' : 'server';
      term.writeln(`\x1b[32m✓ Connected to ${hostname}\x1b[0m`);
      term.writeln(`\x1b[90mWelcome to Termilab — ${isLocal ? 'Local' : 'SSH'} session\x1b[0m`);
      term.writeln('');
      term.write(`\x1b[36m${username}@${hostname}\x1b[0m:\x1b[34m~\x1b[0m$ `);

      term.onData((data) => {
        if (data === '\r') {
          term.writeln('');
          term.write(`\x1b[36m${username}@${hostname}\x1b[0m:\x1b[34m~\x1b[0m$ `);
        } else if (data === '\x7f') {
          term.write('\b \b');
        } else {
          term.write(data);
        }
      });
    }

    /* ResizeObserver for auto-fit */
    const ro = new ResizeObserver(() => {
      try { fitAddon.fit(); } catch (e) { /* ignore */ }
    });
    ro.observe(containerRef.current);

    /* Keyboard shortcut: Ctrl+Shift+F for search */
    const keyHandler = (e) => {
      /* Every terminal of the app is mounted (split panes, hidden tabs):
         only the one with the keyboard opens its search */
      const own = containerRef.current?.closest('.terminal-container');
      if (!IS_ANDROID && (!own || !own.contains(document.activeElement))) return;
      if (e.ctrlKey && e.shiftKey && e.key === 'F') {
        e.preventDefault();
        setShowSearch(prev => !prev);
      }
    };
    document.addEventListener('keydown', keyHandler);

    return () => {
      disposed = true;
      mountedRef.current = false;
      initializedRef.current = false;  // Allow re-init on StrictMode remount
      ro.disconnect();
      document.removeEventListener('keydown', keyHandler);
      if (detachTouch) detachTouch();
      window.removeEventListener(FONT_EVENT, onPinchedFont);
      term.dispose();
    };

  }, [tab.sessionId, tab.connecting]); // Re-run when sessionId arrives

  /* Keep activeTabIdRef in sync for the onBell closure */
  useEffect(() => {
    activeTabIdRef.current = state.activeTabId;
  }, [state.activeTabId]);

  /* Apply terminal settings reactively (font size, cursor, etc.) */
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    /* Android: a pinched size wins until Settings changes the size */
    const settingsFont = termSettings.fontSize || 14;
    if (IS_ANDROID && lastSettingsFontRef.current !== undefined && lastSettingsFontRef.current !== settingsFont) {
      writePinchedFont(null);
    }
    lastSettingsFontRef.current = settingsFont;
    const newFontSize = (IS_ANDROID && readPinchedFont()) || settingsFont;
    const newFontFamily = termSettings.fontFamily || 'JetBrains Mono, Consolas, monospace';
    const newCursorStyle = termSettings.cursorStyle || 'block';

    if (term.options.fontSize !== newFontSize) term.options.fontSize = newFontSize;
    if (term.options.fontFamily !== newFontFamily) term.options.fontFamily = newFontFamily;
    if (term.options.cursorStyle !== newCursorStyle) term.options.cursorStyle = newCursorStyle;

    /* Re-fit after font change */
    requestAnimationFrame(() => {
      try { fitAddonRef.current?.fit(); } catch (e) { /* ignore */ }
    });
  }, [termSettings.fontSize, termSettings.fontFamily, termSettings.cursorStyle]);


  /* Search handlers */
  const handleSearch = useCallback(() => {
    if (searchAddonRef.current && searchQuery) {
      searchAddonRef.current.findNext(searchQuery);
    }
  }, [searchQuery]);

  const handleSearchPrev = useCallback(() => {
    if (searchAddonRef.current && searchQuery) {
      searchAddonRef.current.findPrevious(searchQuery);
    }
  }, [searchQuery]);

  const closeSearch = () => {
    setShowSearch(false);
    setSearchQuery('');
    if (searchAddonRef.current) {
      searchAddonRef.current.clearDecorations();
    }
    termRef.current?.focus();
  };

  /* The chrome around xterm should match the terminal theme's own background,
     not the app theme — otherwise a light terminal sits in a dark frame. */
  const containerStyle = {
    '--terminal-bg': getTheme(termSettings.theme || 'github-dark').background,
  };

  /* ─── Android: header, extra keys, selection ─── */
  const inject = (term, fn) => {
    bypassRef.current = true;
    try { fn(); } finally { bypassRef.current = false; }
  };
  const sendKey = (id) => {
    const term = termRef.current;
    if (!term) return;
    const mods = modifiers.peek();
    const seq = keySequence(id, { appCursor: !!term.modes?.applicationCursorKeysMode, ...mods });
    if (mods.ctrl || mods.alt) modifiers.spend();
    /* term.input fires onData synchronously: same path as typing, so
       broadcast and everything else downstream see it */
    inject(term, () => term.input(seq, true));
  };
  const pasteClipboard = async () => {
    const text = await readClipboard();
    const term = termRef.current;
    if (term && text) inject(term, () => term.paste(text));
  };
  const copySelection = async () => {
    const term = termRef.current;
    if (!term) return;
    await writeClipboard(term.getSelection());
    term.clearSelection();
  };
  const mobileHeader = IS_ANDROID ? (
    <SessionHeader
      tab={tab}
      status={sessionStatus(tab)}
      onResetZoom={() => writePinchedFont(null)}
    />
  ) : null;

  /* Show loading overlay for SSH connecting state */
  if (!isLocal && (tab.connecting || (!tab.sessionId && !tab.error))) {
    return (
      <div className="terminal-container" style={containerStyle}>
        {mobileHeader}
        <div className="terminal-connecting">
          <div className="terminal-connecting-spinner" />
          <div className="terminal-connecting-text">Connecting to {tab.label || 'host'}...</div>
          <div className="terminal-connecting-host">
            {tab.hostConfig?.username}@{tab.hostConfig?.hostname}:{tab.hostConfig?.port || 22}
          </div>
        </div>
        <div className="terminal-status">
          <span className="terminal-status-dot disconnected" />
          <span>{tab.label || 'SSH'} — Connecting...</span>
        </div>
      </div>
    );
  }

  /* Show error state */
  if (tab.error) {
    return (
      <div className="terminal-container" style={containerStyle}>
        {mobileHeader}
        <div className="terminal-connecting">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--color-danger)" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="15" y1="9" x2="9" y2="15"/>
            <line x1="9" y1="9" x2="15" y2="15"/>
          </svg>
          <div style={{color: 'var(--color-danger)', fontWeight: 500}}>Connection Failed</div>
          <div className="terminal-connecting-host">{tab.error}</div>
        </div>
        <div className="terminal-status">
          <span className="terminal-status-dot disconnected" />
          <span>{tab.label || 'SSH'} — Failed</span>
        </div>
      </div>
    );
  }

  return (
    <div className="terminal-container" style={containerStyle}>
      {mobileHeader}
      {showSearch && (
        <div className="terminal-search">
          <input
            type="text"
            placeholder="Search..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                if (e.shiftKey) handleSearchPrev();
                else handleSearch();
              }
              if (e.key === 'Escape') closeSearch();
            }}
            autoFocus
          />
          <button className="terminal-search-btn" onClick={handleSearchPrev} title="Previous">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="18 15 12 9 6 15" />
            </svg>
          </button>
          <button className="terminal-search-btn" onClick={handleSearch} title="Next">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          <button className="terminal-search-btn" onClick={closeSearch} title="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="6" y1="18" x2="18" y2="6" />
            </svg>
          </button>
        </div>
      )}

      <div className="terminal-wrapper" ref={containerRef} />

      {IS_ANDROID && hasSelection && (
        <div className="m-selection-bar">
          <button type="button" className="m-chip m-chip-primary" onMouseDown={(e) => e.preventDefault()} onClick={copySelection}>Copy</button>
          <button type="button" className="m-chip" onMouseDown={(e) => e.preventDefault()} onClick={() => termRef.current?.clearSelection()}>Cancel</button>
        </div>
      )}
      {IS_ANDROID && <ExtraKeys modifiers={modifiers} onKey={sendKey} onPaste={pasteClipboard} />}

      {/* ─── Bottom Bar: Status (desktop; on Android the header says it) ─── */}
      {!IS_ANDROID && <div className="terminal-bottom-bar">
        <div className="terminal-status">
          <span className={`terminal-status-dot ${connected ? '' : 'disconnected'}`} />
          <span>
            {isLocal ? 'Local Shell' : (tab.label || 'SSH')}
            {connected ? '' : ' — Disconnected'}
          </span>
        </div>

        {/* ─── Session Log Controls ─── */}
        <div className="session-log-controls">
          <button
            className={`session-log-toggle ${isLogging ? 'active' : ''}`}
            onClick={() => {
              const next = !isLogging;
              setIsLogging(next);
              isLoggingRef.current = next;
              if (next) logBufferRef.current = [];
            }}
            title={isLogging ? 'Stop logging' : 'Start session logging'}
          >
            {isLogging && <span className="session-log-rec-dot" />}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
              <line x1="16" y1="13" x2="8" y2="13"/>
              <line x1="16" y1="17" x2="8" y2="17"/>
              <polyline points="10 9 9 9 8 9"/>
            </svg>
            <span>Log</span>
          </button>
          {isLogging && (
            <button
              className="session-log-save"
              onClick={() => {
                const text = logBufferRef.current.join('');
                const blob = new Blob([text], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                const ts = new Date().toISOString().replace(/[:.]/g, '-');
                a.href = url;
                a.download = `session-${ts}.log`;
                a.click();
                URL.revokeObjectURL(url);
              }}
              title="Save session log"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              Save
            </button>
          )}
        </div>
      </div>}
    </div>
  );
}
