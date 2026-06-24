import React, { useState, useMemo } from 'react';
import { useApp } from '../../contexts/AppContext';
import './Snippets.css';

export default function Snippets() {
  const { state, actions } = useApp();
  const { snippets } = state;
  const [search, setSearch] = useState('');
  const [activeId, setActiveId] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingSnippet, setEditingSnippet] = useState(null);
  const [form, setForm] = useState({ name: '', command: '', description: '' });
  const [copied, setCopied] = useState(null);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return snippets.filter(s =>
      s.name?.toLowerCase().includes(q) ||
      s.command?.toLowerCase().includes(q) ||
      s.description?.toLowerCase().includes(q)
    );
  }, [snippets, search]);

  const openForm = (snippet = null) => {
    setEditingSnippet(snippet);
    setForm({
      name: snippet?.name || '',
      command: snippet?.command || '',
      description: snippet?.description || '',
    });
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditingSnippet(null);
    setForm({ name: '', command: '', description: '' });
  };

  const handleSave = async () => {
    if (!form.name.trim() || !form.command.trim()) return;
    await actions.saveSnippet({
      ...(editingSnippet?.id ? { id: editingSnippet.id } : {}),
      name: form.name.trim(),
      command: form.command.trim(),
      description: form.description.trim(),
    });
    closeForm();
  };

  const handleCopy = async (command) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(command);
      setTimeout(() => setCopied(null), 2000);
    } catch (e) {
      /* ignore */
    }
  };

  const handleRun = (command) => {
    /* Find the active terminal tab and send data to it */
    const activeTab = state.tabs.find(t => t.id === state.activeTabId);
    if (activeTab?.sessionId && (activeTab.type === 'terminal' || activeTab.type === 'local-terminal')) {
      const hasElectron = typeof window !== 'undefined' && !!window.electronAPI;
      if (hasElectron) {
        if (activeTab.type === 'local-terminal') {
          window.electronAPI.localShell.write(activeTab.sessionId, command + '\n');
        } else {
          window.electronAPI.ssh.sendData(activeTab.sessionId, command + '\n');
        }
      }
    }
  };

  const handleDelete = async (id) => {
    if (confirm('Delete this snippet?')) {
      await actions.deleteSnippet(id);
      if (activeId === id) setActiveId(null);
    }
  };

  return (
    <div className="snippets-panel">
      <div className="snippets-header">
        <h2>Snippets</h2>
        <div className="snippets-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            placeholder="Search snippets..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <button className="snippets-add-btn" onClick={() => openForm()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New Snippet
        </button>
      </div>

      <div className="snippets-list">
        {filtered.length === 0 ? (
          <div className="snippets-empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="16 18 22 12 16 6" />
              <polyline points="8 6 2 12 8 18" />
            </svg>
            <p>
              {search ? 'No snippets match your search.' : 'No snippets yet.\nSave reusable commands for quick access.'}
            </p>
          </div>
        ) : (
          filtered.map(snippet => (
            <div
              key={snippet.id}
              className={`snippet-item ${activeId === snippet.id ? 'active' : ''}`}
              onClick={() => setActiveId(activeId === snippet.id ? null : snippet.id)}
            >
              <div className="snippet-item-name">{snippet.name}</div>
              <div className="snippet-item-command">{snippet.command}</div>
              {snippet.description && (
                <div className="snippet-item-desc">{snippet.description}</div>
              )}
              {activeId === snippet.id && (
                <div className="snippet-item-actions">
                  <button className="snippet-action-btn copy" onClick={(e) => { e.stopPropagation(); handleCopy(snippet.command); }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="9" y="9" width="13" height="13" rx="2" />
                      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                    </svg>
                    {copied === snippet.command ? 'Copied!' : 'Copy'}
                  </button>
                  <button className="snippet-action-btn run" onClick={(e) => { e.stopPropagation(); handleRun(snippet.command); }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                    Run
                  </button>
                  <button className="snippet-action-btn copy" onClick={(e) => { e.stopPropagation(); openForm(snippet); }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                    Edit
                  </button>
                  <button className="snippet-action-btn delete" onClick={(e) => { e.stopPropagation(); handleDelete(snippet.id); }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                    </svg>
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Snippet Form Modal */}
      {formOpen && (
        <div className="snippet-form-overlay" onClick={(e) => e.target === e.currentTarget && closeForm()}>
          <div className="snippet-form">
            <div className="snippet-form-header">
              <h3>{editingSnippet ? 'Edit Snippet' : 'New Snippet'}</h3>
              <button className="snippet-form-close" onClick={closeForm}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="6" y1="6" x2="18" y2="18" />
                  <line x1="6" y1="18" x2="18" y2="6" />
                </svg>
              </button>
            </div>
            <div className="snippet-form-body">
              <div className="snippet-form-group">
                <label>Name</label>
                <input
                  type="text"
                  placeholder="System Update"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  autoFocus
                />
              </div>
              <div className="snippet-form-group">
                <label>Command</label>
                <textarea
                  placeholder="sudo apt update && sudo apt upgrade -y"
                  value={form.command}
                  onChange={e => setForm(f => ({ ...f, command: e.target.value }))}
                />
              </div>
              <div className="snippet-form-group">
                <label>Description</label>
                <input
                  type="text"
                  placeholder="Optional description..."
                  value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                />
              </div>
            </div>
            <div className="snippet-form-footer">
              <button className="snippet-form-cancel" onClick={closeForm}>Cancel</button>
              <button className="snippet-form-save" onClick={handleSave} disabled={!form.name.trim() || !form.command.trim()}>
                {editingSnippet ? 'Save' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
