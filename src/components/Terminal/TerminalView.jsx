import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { useApp } from '../../contexts/AppContext';
import './TerminalView.css';

const hasApi = () => typeof window !== 'undefined' && !!window.electronAPI;

export default function TerminalView({ tab }) {
  const { state } = useApp();
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

  const isLocal = tab.type === 'local-terminal';

  /* Terminal settings from app */
  const termSettings = state.settings?.terminal || {};

  useEffect(() => {
    /* For SSH tabs: wait until sessionId is available (connecting is done) */
    if (!isLocal && tab.connecting) return;
    if (!isLocal && !tab.sessionId) return;
    if (initializedRef.current || !containerRef.current) return;
    initializedRef.current = true;
    mountedRef.current = true;

    const term = new Terminal({
      fontFamily: termSettings.fontFamily || 'JetBrains Mono, Consolas, monospace',
      fontSize: termSettings.fontSize || 14,
      cursorStyle: termSettings.cursorStyle || 'block',
      cursorBlink: true,
      scrollback: termSettings.scrollback || 5000,
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
        cursorAccent: '#0d1117',
        selectionBackground: 'rgba(88, 166, 255, 0.3)',
        selectionForeground: '#e6edf3',
        black: '#484f58',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39d353',
        white: '#e6edf3',
        brightBlack: '#6e7681',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d364',
        brightWhite: '#f0f6fc',
      },
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
            if (!mountedRef.current) return;

            const realSessionId = result?.sessionId;
            if (!realSessionId) return;

            sessionIdRef.current = realSessionId;
            sessionReady = true;
            setConnected(true);

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
            term.onData((data) => {
              if (sessionIdRef.current) {
                window.electronAPI.localShell.write(sessionIdRef.current, data);
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
          }
        });

        window.electronAPI.ssh.onClose((sid) => {
          if (mountedRef.current && sid === sessionIdRef.current) {
            setConnected(false);
            term.writeln('\r\n\x1b[90m[Connection closed]\x1b[0m');
          }
        });

        window.electronAPI.ssh.onError((sid, error) => {
          if (mountedRef.current && sid === sessionIdRef.current) {
            term.writeln(`\r\n\x1b[31m[Error: ${error}]\x1b[0m`);
          }
        });

        /* Terminal -> SSH */
        term.onData((data) => {
          if (sessionIdRef.current) {
            window.electronAPI.ssh.sendData(sessionIdRef.current, data);
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
      if (e.ctrlKey && e.shiftKey && e.key === 'F') {
        e.preventDefault();
        setShowSearch(prev => !prev);
      }
    };
    document.addEventListener('keydown', keyHandler);

    return () => {
      mountedRef.current = false;
      initializedRef.current = false;  // Allow re-init on StrictMode remount
      ro.disconnect();
      document.removeEventListener('keydown', keyHandler);
      term.dispose();
    };

  }, [tab.sessionId, tab.connecting]); // Re-run when sessionId arrives

  /* Apply terminal settings reactively (font size, cursor, etc.) */
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const newFontSize = termSettings.fontSize || 14;
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

  /* Show loading overlay for SSH connecting state */
  if (!isLocal && (tab.connecting || (!tab.sessionId && !tab.error))) {
    return (
      <div className="terminal-container">
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
      <div className="terminal-container">
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
    <div className="terminal-container">
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

      <div className="terminal-status">
        <span className={`terminal-status-dot ${connected ? '' : 'disconnected'}`} />
        <span>
          {isLocal ? 'Local Shell' : (tab.label || 'SSH')}
          {connected ? '' : ' — Disconnected'}
        </span>
      </div>
    </div>
  );
}
