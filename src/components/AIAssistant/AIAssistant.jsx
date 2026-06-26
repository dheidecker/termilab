import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useApp } from '../../contexts/AppContext';
import './AIAssistant.css';

/* ─── SVG Icon Components ─── */
const Icons = {
  chat: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>,
  bolt: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
  cpu: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>,
  play: <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>,
  warn: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
  send: <svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>,
  trash: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>,
  key: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>,
  close: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  stop: <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>,
  terminal: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>,
  sparkle: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>,
  chevron: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"/></svg>,
  globe: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>,
  back: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>,
};

const MODES = [
  { id: 'ask', label: 'Ask', icon: Icons.chat, desc: 'Suggests commands, you approve each one' },
  { id: 'auto-approve', label: 'Auto-Approve', icon: Icons.bolt, desc: 'Runs commands automatically, shows progress' },
  { id: 'autonomous', label: 'Autonomous', icon: Icons.cpu, desc: 'Full auto — executes everything without asking' },
];

/* Parse response into text blocks and command blocks */
function parseResponse(text) {
  const blocks = [];
  const regex = /```(bash:run|bash)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      blocks.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    }
    blocks.push({
      type: match[1] === 'bash:run' ? 'command' : 'code',
      content: match[2].trim(),
      dangerous: isDangerous(match[2].trim()),
    });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    blocks.push({ type: 'text', content: text.slice(lastIndex) });
  }
  return blocks;
}

function isDangerous(cmd) {
  const patterns = [/rm\s+(-rf?|--recursive)/i, /mkfs/i, /dd\s+if=/i, /drop\s+(database|table)/i, /shutdown/i, /reboot/i];
  return patterns.some(r => r.test(cmd));
}

function renderMarkdown(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^### (.*$)/gm, '<h4>$1</h4>')
    .replace(/^## (.*$)/gm, '<h3>$1</h3>')
    .replace(/^# (.*$)/gm, '<h2>$1</h2>')
    .replace(/^- (.*$)/gm, '<li>$1</li>')
    .replace(/\n/g, '<br/>');
}

export default function AIAssistant({ visible, onClose, getTerminalContent, sendToTerminal }) {
  const { state } = useApp();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState(state.settings?.ai?.defaultMode || 'ask');
  const [showModeMenu, setShowModeMenu] = useState(false);
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [pendingCommands, setPendingCommands] = useState([]);
  const [webviewMode, setWebviewMode] = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const agentLoopRef = useRef(false);

  /* Get AI config from settings */
  const aiSettings = state.settings?.ai || {};
  const provider = aiSettings.provider || 'claude-api';
  const isWebProvider = provider === 'claude-web';
  const apiKey = provider === 'claude-api' ? (aiSettings.claudeApiKey || '')
    : provider === 'deepseek' ? (aiSettings.deepseekApiKey || '')
    : provider === 'openai' ? (aiSettings.openaiApiKey || '') : '';
  const model = provider === 'claude-api' ? (aiSettings.claudeModel || 'claude-sonnet-4-20250514')
    : provider === 'deepseek' ? (aiSettings.deepseekModel || 'deepseek-chat')
    : provider === 'openai' ? (aiSettings.openaiModel || 'gpt-4o') : '';

  useEffect(() => {
    if (aiSettings.defaultMode) setMode(aiSettings.defaultMode);
  }, [aiSettings.defaultMode]);

  useEffect(() => {
    setWebviewMode(isWebProvider);
  }, [isWebProvider]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  useEffect(() => {
    if (visible && !isWebProvider) setTimeout(() => inputRef.current?.focus(), 100);
  }, [visible, isWebProvider]);

  const getContext = useCallback(() => {
    if (getTerminalContent) {
      const content = getTerminalContent();
      if (content) {
        const lines = content.split('\n');
        const limit = aiSettings.contextLines || 50;
        return lines.slice(-limit).join('\n');
      }
    }
    return '';
  }, [getTerminalContent, aiSettings.contextLines]);

  const executeCommand = useCallback((cmd) => {
    if (sendToTerminal) sendToTerminal(cmd + '\n');
  }, [sendToTerminal]);

  const sendMessage = useCallback(async (userMessage, isFollowUp = false) => {
    if (!apiKey && !isWebProvider) {
      setShowKeyInput(true);
      return;
    }
    if (!userMessage.trim() && !isFollowUp) return;

    const newMessages = isFollowUp ? [...messages] : [...messages, { role: 'user', content: userMessage }];
    if (!isFollowUp) { setMessages(newMessages); setInput(''); }
    setLoading(true);

    try {
      const termContext = getContext();
      const apiMessages = newMessages.map(m => ({
        role: m.role === 'command-output' ? 'user' : m.role,
        content: m.role === 'command-output' ? `Terminal output after running command:\n\`\`\`\n${m.content}\n\`\`\`` : m.content,
      }));

      const hasApi = window.electronAPI?.ai;
      let response;

      if (hasApi) {
        response = await window.electronAPI.ai.chat({ messages: apiMessages, terminalContext: termContext, apiKey, model, provider });
      } else {
        response = {
          content: "I can see your terminal. Here's a command:\n\n```bash:run\nuname -a\n```\n\nThis will show your system information.",
          commands: [{ command: 'uname -a', dangerous: false }],
        };
      }

      const assistantMsg = { role: 'assistant', content: response.content, commands: response.commands || [] };
      const updatedMessages = [...newMessages, assistantMsg];
      setMessages(updatedMessages);

      if (response.commands && response.commands.length > 0) {
        if (mode === 'autonomous') {
          agentLoopRef.current = true;
          for (const cmd of response.commands) {
            if (!agentLoopRef.current) break;
            executeCommand(cmd.command);
            await new Promise(r => setTimeout(r, 2000));
            const output = getContext();
            updatedMessages.push({ role: 'command-output', content: output });
          }
          setMessages([...updatedMessages]);
          if (agentLoopRef.current && response.commands.length > 0) {
            setTimeout(() => sendMessage('Continue with the task. Here is the terminal output.', true), 500);
          }
        } else if (mode === 'auto-approve') {
          for (const cmd of response.commands) {
            if (cmd.dangerous) {
              setPendingCommands(prev => [...prev, cmd]);
            } else {
              executeCommand(cmd.command);
              await new Promise(r => setTimeout(r, 1500));
            }
          }
          const hasDangerous = response.commands.some(c => c.dangerous);
          if (!hasDangerous) {
            await new Promise(r => setTimeout(r, 2000));
            const output = getContext();
            updatedMessages.push({ role: 'command-output', content: output });
            setMessages([...updatedMessages]);
            setTimeout(() => sendMessage('Continue with the task. Here is the terminal output.', true), 500);
          }
        }
      }
    } catch (err) {
      setMessages(prev => [...prev, { role: 'error', content: err.message }]);
    } finally {
      setLoading(false);
    }
  }, [apiKey, messages, mode, getContext, executeCommand, isWebProvider, model, provider]);

  const handleRunCommand = async (cmd) => {
    executeCommand(cmd);
    await new Promise(r => setTimeout(r, 2000));
    const output = getContext();
    setMessages(prev => [...prev, { role: 'command-output', content: output }]);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input); }
  };

  const stopAgent = () => { agentLoopRef.current = false; setLoading(false); };

  const clearChat = () => {
    setMessages([]); setPendingCommands([]); agentLoopRef.current = false;
    window.electronAPI?.ai?.clear?.('main');
  };

  const currentMode = MODES.find(m => m.id === mode);

  if (!visible) return null;

  /* ─── Webview Mode (Claude Account) ─── */
  if (webviewMode) {
    return (
      <div className="ai-assistant">
        <div className="ai-header">
          <div className="ai-header-left">
            <span className="ai-icon-sm">{Icons.globe}</span>
            <span className="ai-title">Claude (Account)</span>
          </div>
          <div className="ai-header-actions">
            <button className="ai-btn-icon" onClick={() => setWebviewMode(false)} title="Switch to API mode">
              <span className="ai-icon-sm">{Icons.back}</span>
            </button>
            <button className="ai-btn-icon" onClick={onClose} title="Close">
              <span className="ai-icon-sm">{Icons.close}</span>
            </button>
          </div>
        </div>
        <webview
          className="ai-webview"
          src="https://claude.ai"
          style={{ flex: 1, width: '100%', border: 'none' }}
        />
      </div>
    );
  }

  /* ─── API Chat Mode ─── */
  return (
    <div className="ai-assistant">
      {/* Header */}
      <div className="ai-header">
        <div className="ai-header-left">
          <span className="ai-icon-sm accent">{Icons.sparkle}</span>
          <span className="ai-title">AI Assistant</span>
          <span className="ai-provider-badge">{
            provider === 'claude-api' ? 'Claude' : provider === 'deepseek' ? 'DeepSeek' : provider === 'openai' ? 'OpenAI' : 'AI'
          }</span>
        </div>
        <div className="ai-header-actions">
          {provider === 'claude-api' && (
            <button className="ai-btn-icon" onClick={() => setWebviewMode(true)} title="Open Claude Web">
              <span className="ai-icon-sm">{Icons.globe}</span>
            </button>
          )}
          <button className="ai-btn-icon" onClick={clearChat} title="Clear chat">
            <span className="ai-icon-sm">{Icons.trash}</span>
          </button>
          <button className="ai-btn-icon" onClick={onClose} title="Close">
            <span className="ai-icon-sm">{Icons.close}</span>
          </button>
        </div>
      </div>

      {/* Mode selector */}
      <div className="ai-mode-bar">
        <div className="ai-mode-selector" onClick={() => setShowModeMenu(!showModeMenu)}>
          <span className="ai-icon-sm">{currentMode.icon}</span>
          <span className="ai-mode-label">{currentMode.label}</span>
          <span className="ai-icon-xs">{Icons.chevron}</span>
        </div>
        {showModeMenu && (
          <div className="ai-mode-menu">
            {MODES.map(m => (
              <button
                key={m.id}
                className={`ai-mode-option ${mode === m.id ? 'active' : ''}`}
                onClick={() => { setMode(m.id); setShowModeMenu(false); }}
              >
                <span className="ai-icon-sm">{m.icon}</span>
                <div>
                  <div className="ai-mode-option-label">{m.label}</div>
                  <div className="ai-mode-option-desc">{m.desc}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Messages */}
      <div className="ai-messages">
        {messages.length === 0 && (
          <div className="ai-welcome">
            <div className="ai-welcome-icon">{Icons.terminal}</div>
            <h3>AI Assistant</h3>
            <p>I can help you with terminal commands, troubleshooting, and server administration.</p>
            <div className="ai-suggestions">
              <button onClick={() => sendMessage('What OS is this server running?')}>What OS is this?</button>
              <button onClick={() => sendMessage('Show me disk usage')}>Disk usage</button>
              <button onClick={() => sendMessage('Install Docker')}>Install Docker</button>
              <button onClick={() => sendMessage('Set up a firewall')}>Setup firewall</button>
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`ai-msg ai-msg-${msg.role}`}>
            {msg.role === 'user' && (
              <div className="ai-msg-bubble user"><p>{msg.content}</p></div>
            )}
            {msg.role === 'assistant' && (
              <div className="ai-msg-bubble assistant">
                {parseResponse(msg.content).map((block, j) => {
                  if (block.type === 'text') {
                    return <div key={j} className="ai-text" dangerouslySetInnerHTML={{ __html: renderMarkdown(block.content) }} />;
                  }
                  if (block.type === 'command') {
                    return (
                      <div key={j} className={`ai-command-block ${block.dangerous ? 'dangerous' : ''}`}>
                        {block.dangerous && (
                          <div className="ai-warning">
                            <span className="ai-icon-xs">{Icons.warn}</span> Potentially dangerous command
                          </div>
                        )}
                        <pre className="ai-command-code">{block.content}</pre>
                        {mode === 'ask' && (
                          <button className="ai-run-btn" onClick={() => handleRunCommand(block.content)}>
                            <span className="ai-icon-xs">{Icons.play}</span> Run
                          </button>
                        )}
                        {mode === 'auto-approve' && block.dangerous && (
                          <button className="ai-run-btn" onClick={() => handleRunCommand(block.content)}>
                            <span className="ai-icon-xs">{Icons.warn}</span> Approve & Run
                          </button>
                        )}
                      </div>
                    );
                  }
                  if (block.type === 'code') {
                    return <pre key={j} className="ai-code-block">{block.content}</pre>;
                  }
                  return null;
                })}
              </div>
            )}
            {msg.role === 'command-output' && (
              <div className="ai-msg-bubble output">
                <div className="ai-output-label">Terminal Output</div>
                <pre className="ai-output-code">{msg.content}</pre>
              </div>
            )}
            {msg.role === 'error' && (
              <div className="ai-msg-bubble error"><p>{msg.content}</p></div>
            )}
          </div>
        ))}

        {loading && (
          <div className="ai-msg ai-msg-assistant">
            <div className="ai-msg-bubble assistant">
              <div className="ai-typing"><span /><span /><span /></div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="ai-input-area">
        {agentLoopRef.current && (
          <button className="ai-stop-btn" onClick={stopAgent}>
            <span className="ai-icon-xs">{Icons.stop}</span> Stop Agent
          </button>
        )}
        <div className="ai-input-row">
          <textarea
            ref={inputRef}
            className="ai-input"
            placeholder={apiKey ? 'Ask anything...' : 'Configure your API key in Settings → AI Assistant'}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={loading}
          />
          <button className="ai-send-btn" onClick={() => sendMessage(input)} disabled={loading || !input.trim()}>
            <span className="ai-icon-sm">{Icons.send}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
