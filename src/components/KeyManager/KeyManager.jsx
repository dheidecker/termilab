import React, { useState } from 'react';
import { useApp } from '../../contexts/AppContext';
import './KeyManager.css';

export default function KeyManager() {
  const { state, actions } = useApp();
  const { keys } = state;
  const [activeId, setActiveId] = useState(null);
  const [showGenerate, setShowGenerate] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [genForm, setGenForm] = useState({ label: '', type: 'ED25519', bits: '4096' });
  const [pasteForm, setPasteForm] = useState({ name: '', content: '' });
  const [copied, setCopied] = useState(false);
  const [pasteError, setPasteError] = useState('');

  const handleImport = async () => {
    try {
      await actions.importKey();
    } catch (e) {
      console.error('Import key failed:', e);
    }
  };

  const handleGenerate = async () => {
    if (!genForm.label.trim()) return;
    try {
      await actions.generateKey({
        name: genForm.label.trim(),
        type: genForm.type.toLowerCase(),
        bits: parseInt(genForm.bits, 10),
      });
      setShowGenerate(false);
      setGenForm({ label: '', type: 'ED25519', bits: '4096' });
    } catch (e) {
      console.error('Generate key failed:', e);
    }
  };

  const handlePaste = async () => {
    if (!pasteForm.content.trim()) return;
    setPasteError('');
    try {
      await actions.pasteKey({
        name: pasteForm.name.trim() || 'Pasted Key',
        privateKeyContent: pasteForm.content,
      });
      setShowPaste(false);
      setPasteForm({ name: '', content: '' });
    } catch (e) {
      setPasteError(e.message || 'Invalid key');
    }
  };

  const handleCopyPublicKey = async (publicKey) => {
    try {
      await navigator.clipboard.writeText(publicKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) { /* ignore */ }
  };

  const handleDelete = async (id) => {
    if (confirm('Delete this SSH key?')) {
      await actions.deleteKey(id);
      if (activeId === id) setActiveId(null);
    }
  };

  const KeyIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
    </svg>
  );

  return (
    <div className="key-manager">
      <div className="key-manager-header">
        <h2>Keychain</h2>
        <div className="key-manager-actions">
          <button className="key-import-btn" onClick={handleImport}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Import
          </button>
          <button className="key-generate-btn" onClick={() => setShowGenerate(true)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Generate
          </button>
          <button className="key-generate-btn" onClick={() => setShowPaste(true)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/>
              <rect x="8" y="2" width="8" height="4" rx="1"/>
            </svg>
            Paste
          </button>
        </div>
      </div>

      <div className="key-list">
        {keys.length === 0 ? (
          <div className="key-empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
            </svg>
            <p>No SSH keys yet.<br />Import or generate a key pair.</p>
          </div>
        ) : (
          keys.map(key => (
            <div
              key={key.id}
              className={`key-item ${activeId === key.id ? 'active' : ''}`}
              onClick={() => setActiveId(activeId === key.id ? null : key.id)}
            >
              <div className="key-item-top">
                <div className="key-item-icon">
                  <KeyIcon />
                </div>
                <div className="key-item-info">
                  <div className="key-item-label">{key.name || key.label}</div>
                  <div className="key-item-type">{key.type} • {key.createdAt || 'Unknown date'}</div>
                </div>
              </div>
              <div className="key-item-fingerprint">{key.fingerprint}</div>

              {activeId === key.id && (
                <div className="key-item-detail">
                  {key.publicKey && (
                    <div className="key-public-key">
                      <label>Public Key</label>
                      <div className="key-public-key-text">{key.publicKey}</div>
                    </div>
                  )}
                  <div className="key-detail-actions">
                    {key.publicKey && (
                      <button className="key-copy-btn" onClick={(e) => { e.stopPropagation(); handleCopyPublicKey(key.publicKey); }}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="9" y="9" width="13" height="13" rx="2" />
                          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                        </svg>
                        {copied ? 'Copied!' : 'Copy Public Key'}
                      </button>
                    )}
                    <button className="key-delete-btn" onClick={(e) => { e.stopPropagation(); handleDelete(key.id); }}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                      </svg>
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Generate Key Modal */}
      {showGenerate && (
        <div className="key-generate-overlay" onClick={(e) => e.target === e.currentTarget && setShowGenerate(false)}>
          <div className="key-generate-modal">
            <div className="key-generate-modal-header">
              <h3>Generate SSH Key</h3>
              <button className="key-generate-modal-close" onClick={() => setShowGenerate(false)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="6" y1="6" x2="18" y2="18" />
                  <line x1="6" y1="18" x2="18" y2="6" />
                </svg>
              </button>
            </div>
            <div className="key-generate-modal-body">
              <div className="key-generate-group">
                <label>Label</label>
                <input
                  type="text"
                  placeholder="My SSH Key"
                  value={genForm.label}
                  onChange={e => setGenForm(f => ({ ...f, label: e.target.value }))}
                  autoFocus
                />
              </div>
              <div className="key-generate-group">
                <label>Key Type</label>
                <select value={genForm.type} onChange={e => setGenForm(f => ({ ...f, type: e.target.value }))}>
                  <option value="ED25519">ED25519 (Recommended)</option>
                  <option value="RSA">RSA</option>
                  <option value="ECDSA">ECDSA</option>
                </select>
              </div>
              {genForm.type === 'RSA' && (
                <div className="key-generate-group">
                  <label>Key Size (bits)</label>
                  <select value={genForm.bits} onChange={e => setGenForm(f => ({ ...f, bits: e.target.value }))}>
                    <option value="2048">2048</option>
                    <option value="4096">4096</option>
                  </select>
                </div>
              )}
            </div>
            <div className="key-generate-modal-footer">
              <button className="snippet-form-cancel" onClick={() => setShowGenerate(false)}>Cancel</button>
              <button className="snippet-form-save" onClick={handleGenerate} disabled={!genForm.label.trim()}>Generate</button>
            </div>
          </div>
        </div>
      )}

      {/* Paste Key Modal */}
      {showPaste && (
        <div className="key-generate-overlay" onClick={(e) => e.target === e.currentTarget && setShowPaste(false)}>
          <div className="key-generate-modal">
            <div className="key-generate-modal-header">
              <h3>Paste SSH Private Key</h3>
              <button className="key-generate-modal-close" onClick={() => { setShowPaste(false); setPasteError(''); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="6" y1="6" x2="18" y2="18" />
                  <line x1="6" y1="18" x2="18" y2="6" />
                </svg>
              </button>
            </div>
            <div className="key-generate-modal-body">
              <div className="key-generate-group">
                <label>Name</label>
                <input
                  type="text"
                  placeholder="My Server Key"
                  value={pasteForm.name}
                  onChange={e => setPasteForm(f => ({ ...f, name: e.target.value }))}
                  autoFocus
                />
              </div>
              <div className="key-generate-group">
                <label>Private Key Content</label>
                <textarea
                  className="key-paste-textarea"
                  placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n...paste your key here...\n-----END OPENSSH PRIVATE KEY-----"}
                  value={pasteForm.content}
                  onChange={e => { setPasteForm(f => ({ ...f, content: e.target.value })); setPasteError(''); }}
                  rows={10}
                  spellCheck={false}
                />
              </div>
              {pasteError && <div className="key-paste-error">{pasteError}</div>}
            </div>
            <div className="key-generate-modal-footer">
              <button className="snippet-form-cancel" onClick={() => { setShowPaste(false); setPasteError(''); }}>Cancel</button>
              <button className="snippet-form-save" onClick={handlePaste} disabled={!pasteForm.content.trim()}>Save Key</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
