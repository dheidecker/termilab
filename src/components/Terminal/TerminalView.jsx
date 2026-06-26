import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { useApp } from '../../contexts/AppContext';
import { getTheme } from '../../themes/terminal-themes';
import './TerminalView.css';

const hasApi = () => typeof window !== 'undefined' && !!window.electronAPI;

export default function TerminalView({ tab, onRegister }) {
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

    /* Register terminal for AI access */
    if (onRegister) onRegister(tab.id, termRef, sessionIdRef);

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

  /* ─── AI inline state ─── */
  const [aiMode, setAiMode] = useState(false);
  const [aiInput, setAiInput] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiMessages, setAiMessages] = useState([]);
  const [aiExpanded, setAiExpanded] = useState(false);
  const aiInputRef = useRef(null);
  const [aiAutoAnalyze, setAiAutoAnalyze] = useState(true);
  const autoAnalyzeRef = useRef(true);
  const toggleAutoAnalyze = useCallback(() => {
    setAiAutoAnalyze(prev => {
      const next = !prev;
      autoAnalyzeRef.current = next;
      return next;
    });
  }, []);
  const [chatHeight, setChatHeight] = useState(220);
  const chatHeightRef = useRef(220);

  const handleResizeStart = useCallback((e) => {
    e.preventDefault();
    let lastY = e.clientY;

    const onMove = (ev) => {
      const delta = lastY - ev.clientY; // positive = mouse moved up = chat bigger
      lastY = ev.clientY;
      const newH = Math.max(80, Math.min(600, chatHeightRef.current + delta));
      chatHeightRef.current = newH;
      setChatHeight(newH);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      fitAddonRef.current?.fit();
    };
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  const aiSettings = state.settings?.ai || {};
  const aiProvider = aiSettings.provider || 'claude-api';
  const aiApiKey = aiProvider === 'claude-api' ? (aiSettings.claudeApiKey || '')
    : aiProvider === 'deepseek' ? (aiSettings.deepseekApiKey || '')
    : aiProvider === 'openai' ? (aiSettings.openaiApiKey || '') : '';
  const defaultModel = aiProvider === 'claude-api' ? (aiSettings.claudeModel || 'claude-opus-4.8')
    : aiProvider === 'deepseek' ? (aiSettings.deepseekModel || 'deepseek-v4-pro')
    : aiProvider === 'openai' ? (aiSettings.openaiModel || 'gpt-5.5') : '';
  const [modelOverride, setModelOverride] = useState(null);
  const aiModel = modelOverride || defaultModel;

  const PROVIDER_MODELS = {
    'claude-api': [
      { value: 'claude-opus-4.8', label: 'Opus 4.8' },
      { value: 'claude-sonnet-4.6', label: 'Sonnet 4.6' },
      { value: 'claude-haiku-4.5', label: 'Haiku 4.5' },
    ],
    'deepseek': [
      { value: 'deepseek-v4-pro', label: 'V4 Pro' },
      { value: 'deepseek-v4-flash', label: 'V4 Flash' },
    ],
    'openai': [
      { value: 'gpt-5.5', label: 'GPT-5.5' },
      { value: 'gpt-5.4', label: 'GPT-5.4' },
      { value: 'gpt-5.4-mini', label: '5.4 Mini' },
    ],
  };

  const getTermContext = useCallback(() => {
    const term = termRef.current;
    if (!term) return '';
    const buffer = term.buffer?.active;
    if (!buffer) return '';
    const lines = [];
    const start = Math.max(0, buffer.length - (aiSettings.contextLines || 100));
    for (let i = start; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    return lines.join('\n');
  }, [aiSettings.contextLines]);

  const sendAiMessage = useCallback(async (msg) => {
    if (!msg.trim()) return;
    if (!aiApiKey) { setAiMessages(prev => [{ role: 'error', text: 'No API key configured. Go to Settings → AI Assistant.' }]); return; }

    const newMsgs = [...aiMessages, { role: 'user', text: msg }];
    setAiMessages(newMsgs);
    setAiInput('');
    setAiLoading(true);
    setAiExpanded(true);

    try {
      const termContext = getTermContext();
      const apiMsgs = newMsgs.filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({ role: m.role, content: m.text }));

      const hasStreamApi = window.electronAPI?.ai?.chatStream;
      if (hasStreamApi) {
        let streamText = '';
        setAiMessages(prev => [...prev, { role: 'streaming', text: '' }]);

        window.electronAPI.ai.onStreamChunk((chunk) => {
          streamText += chunk;
          setAiMessages(prev => {
            const updated = [...prev];
            const si = updated.findIndex(m => m.role === 'streaming');
            if (si !== -1) updated[si] = { role: 'streaming', text: streamText };
            return updated;
          });
        });

        const result = await window.electronAPI.ai.chatStream({
          messages: apiMsgs, terminalContext: termContext, apiKey: aiApiKey, model: aiModel, provider: aiProvider,
        });

        window.electronAPI.ai.removeStreamListeners();
        setAiMessages(prev => {
          const updated = prev.filter(m => m.role !== 'streaming');
          return [...updated, { role: 'assistant', text: result.content, commands: result.commands || [] }];
        });
        // Auto mode: execute safe commands automatically
        if (autoAnalyzeRef.current && result.commands?.length > 0) {
          const safeCmds = result.commands.filter(c => !c.dangerous);
          if (safeCmds.length > 0) {
            setTimeout(() => safeCmds.forEach(c => runCommandRef.current(c.command)), 500);
          }
        }
      } else {
        const hasApi = window.electronAPI?.ai;
        let response;
        if (hasApi) {
          response = await window.electronAPI.ai.chat({ messages: apiMsgs, terminalContext: termContext, apiKey: aiApiKey, model: aiModel, provider: aiProvider });
        } else {
          response = { content: 'Mock: try `uname -a`', commands: [] };
        }
        setAiMessages(prev => [...prev, { role: 'assistant', text: response.content, commands: response.commands || [] }]);
      }
    } catch (err) {
      window.electronAPI?.ai?.removeStreamListeners?.();
      setAiMessages(prev => [...prev.filter(m => m.role !== 'streaming'), { role: 'error', text: err.message }]);
    } finally {
      setAiLoading(false);
    }
  }, [aiMessages, aiApiKey, aiModel, aiProvider, getTermContext]);

  const runCommandRef = useRef(null);
  const runCommand = useCallback((cmd) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    if (isLocal) {
      window.electronAPI?.localShell?.write(sid, cmd + '\n');
    } else {
      window.electronAPI?.ssh?.sendData(sid, cmd + '\n');
    }
    setAiMessages(prev => [...prev, { role: 'ran', text: cmd }]);
    setTimeout(() => {
      const output = getTermContext();
      if (output) {
        const lastLines = output.split('\n').slice(-20).join('\n');
        setAiMessages(prev => [...prev, { role: 'output', text: lastLines }]);
        if (autoAnalyzeRef.current) {
          sendAiMessage(`I ran \`${cmd}\`. Output:\n\`\`\`\n${lastLines}\n\`\`\`\nAnalyze briefly. If errors, suggest fix. If ok, confirm.`);
        }
      }
    }, 2000);
  }, [isLocal, getTermContext, sendAiMessage]);
  runCommandRef.current = runCommand;

  const aiScrollRef = useRef(null);
  useEffect(() => {
    aiScrollRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [aiMessages, aiLoading]);

  const toggleAi = () => {
    setAiMode(!aiMode);
    if (!aiMode) {
      setTimeout(() => aiInputRef.current?.focus(), 50);
    } else {
      termRef.current?.focus();
    }
  };

  const handleAiKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAiMessage(aiInput); }
    if (e.key === 'Escape') { setAiMode(false); termRef.current?.focus(); }
  };

  const parseCommands = (text) => {
    const blocks = [];
    const regex = /```(?:bash:run|bash)\n([\s\S]*?)```/g;
    let last = 0, m;
    while ((m = regex.exec(text)) !== null) {
      if (m.index > last) blocks.push({ type: 'text', content: text.slice(last, m.index) });
      blocks.push({ type: 'cmd', content: m[1].trim() });
      last = m.index + m[0].length;
    }
    if (last < text.length) blocks.push({ type: 'text', content: text.slice(last) });
    return blocks;
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

      {/* ─── AI Response Panel ─── */}
      {aiExpanded && aiMessages.length > 0 && (
        <>
        <div className="tai-resize-handle" onMouseDown={handleResizeStart}>
          <div className="tai-resize-grip" />
        </div>
        <div className="tai-responses" style={{ height: chatHeight }}>
          <div className="tai-responses-header">
            <span>AI Chat</span>
            <div className="tai-responses-actions">
              <button onClick={() => { setAiMessages([]); setAiExpanded(false); }} title="Clear">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
              </button>
              <button onClick={() => setAiExpanded(false)} title="Collapse">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"/></svg>
              </button>
            </div>
          </div>
          <div className="tai-responses-body">
            {aiMessages.map((msg, i) => (
              <div key={i} className={`tai-msg tai-msg-${msg.role}`}>
                {msg.role === 'user' && <div className="tai-user">{msg.text}</div>}
                {msg.role === 'assistant' && (
                  <div className="tai-assistant">
                    {parseCommands(msg.text).map((b, j) =>
                      b.type === 'cmd' ? (
                        <div key={j} className="tai-cmd">
                          <code>{b.content}</code>
                          {!aiAutoAnalyze && (
                            <button onClick={() => runCommand(b.content)}>
                              <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                              Run
                            </button>
                          )}
                        </div>
                      ) : (
                        <span key={j} className="tai-text" dangerouslySetInnerHTML={{ __html: b.content.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n/g, '<br/>') }} />
                      )
                    )}
                  </div>
                )}
                {msg.role === 'streaming' && (
                  <div className="tai-assistant tai-streaming">
                    <span className="tai-text" dangerouslySetInnerHTML={{ __html: msg.text.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n/g, '<br/>') }} />
                    <span className="tai-cursor">▊</span>
                  </div>
                )}
                {msg.role === 'ran' && <div className="tai-ran"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{width:12,height:12}}><polyline points="20 6 9 17 4 12"/></svg> Executed: <code>{msg.text}</code></div>}
                {msg.role === 'output' && (
                  <div className="tai-output">
                    <div className="tai-output-label">Terminal Output</div>
                    <pre>{msg.text}</pre>
                  </div>
                )}
                {msg.role === 'error' && <div className="tai-error">{msg.text}</div>}
              </div>
            ))}
            {aiLoading && <div className="tai-loading"><span/><span/><span/></div>}
            <div ref={aiScrollRef} />
          </div>
        </div>
        </>
      )}

      {/* ─── Bottom Bar: Status + AI ─── */}
      <div className="terminal-bottom-bar">
        <div className="terminal-status">
          <span className={`terminal-status-dot ${connected ? '' : 'disconnected'}`} />
          <span>
            {isLocal ? 'Local Shell' : (tab.label || 'SSH')}
            {connected ? '' : ' — Disconnected'}
          </span>
        </div>

        {/* AI Input Bar */}
        <div className={`tai-bar ${aiMode ? 'active' : ''}`}>
          {aiMode ? (
            <>
              <select
                className="tai-model-select"
                value={aiModel}
                onChange={e => setModelOverride(e.target.value)}
                title="Select AI model"
              >
                {(PROVIDER_MODELS[aiProvider] || []).map(m => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
              <input
                ref={aiInputRef}
                className="tai-input"
                placeholder="Ask AI anything... (Esc to go back)"
                value={aiInput}
                onChange={e => setAiInput(e.target.value)}
                onKeyDown={handleAiKeyDown}
              />
              {aiMessages.length > 0 && !aiExpanded && (
                <button className="tai-history-btn" onClick={() => setAiExpanded(true)} title="Show chat">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="18 15 12 9 6 15"/></svg>
                </button>
              )}
              <select
                className="tai-mode-select"
                value={aiAutoAnalyze ? 'auto' : 'manual'}
                onChange={e => {
                  const isAuto = e.target.value === 'auto';
                  setAiAutoAnalyze(isAuto);
                  autoAnalyzeRef.current = isAuto;
                }}
                title="AI behavior mode"
              >
                <option value="auto">Auto</option>
                <option value="manual">Manual</option>
              </select>
              <button className="tai-send" onClick={() => sendAiMessage(aiInput)} disabled={aiLoading || !aiInput.trim()}>
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
              </button>
            </>
          ) : (
            <button className="tai-toggle" onClick={toggleAi} title="Ask AI (integrated)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
              </svg>
              <span>AI</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
