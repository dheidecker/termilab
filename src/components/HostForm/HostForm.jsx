import React, { useState, useEffect, useRef } from 'react';
import { useApp } from '../../contexts/AppContext';
import './HostForm.css';

export default function HostForm() {
  const { state, actions } = useApp();
  const { editingHost, groups, keys } = state;

  const [form, setForm] = useState({
    label: '',
    hostname: '',
    port: '22',
    username: '',
    authType: 'password',
    password: '',
    keyId: '',
    groupId: '',
    tags: [],
  });

  const [tagInput, setTagInput] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState({});
  const labelRef = useRef(null);

  /* Populate form when editing */
  useEffect(() => {
    if (editingHost) {
      setForm({
        label: editingHost.label || '',
        hostname: editingHost.hostname || '',
        port: String(editingHost.port || 22),
        username: editingHost.username || '',
        authType: editingHost.authType || 'password',
        password: editingHost.password || '',
        keyId: editingHost.keyId || '',
        groupId: editingHost.groupId || '',
        tags: editingHost.tags || [],
      });
    }
  }, [editingHost]);

  /* Focus label on mount */
  useEffect(() => {
    labelRef.current?.focus();
  }, []);

  /* Close on Escape */
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') actions.closeHostForm();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [actions]);

  const updateField = (field, value) => {
    setForm(prev => ({ ...prev, [field]: value }));
    if (errors[field]) setErrors(prev => ({ ...prev, [field]: null }));
  };

  const handleTagKeyDown = (e) => {
    if ((e.key === 'Enter' || e.key === ',') && tagInput.trim()) {
      e.preventDefault();
      const tag = tagInput.trim().replace(',', '');
      if (tag && !form.tags.includes(tag)) {
        updateField('tags', [...form.tags, tag]);
      }
      setTagInput('');
    } else if (e.key === 'Backspace' && !tagInput && form.tags.length > 0) {
      updateField('tags', form.tags.slice(0, -1));
    }
  };

  const removeTag = (tag) => {
    updateField('tags', form.tags.filter(t => t !== tag));
  };

  const validate = () => {
    const errs = {};
    if (!form.hostname.trim()) errs.hostname = 'Hostname is required';
    if (!form.username.trim()) errs.username = 'Username is required';
    const portNum = parseInt(form.port, 10);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) errs.port = 'Invalid port';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSave = async () => {
    if (!validate()) return;
    const host = {
      ...(editingHost?.id ? { id: editingHost.id } : {}),
      label: form.label.trim() || form.hostname,
      hostname: form.hostname.trim(),
      port: parseInt(form.port, 10),
      username: form.username.trim(),
      authType: form.authType,
      password: form.authType === 'password' ? form.password : undefined,
      keyId: form.authType === 'key' ? form.keyId : undefined,
      groupId: form.groupId || null,
      tags: form.tags,
    };
    await actions.saveHost(host);
    actions.closeHostForm();
  };

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) actions.closeHostForm();
  };

  return (
    <div className="host-form-overlay" onClick={handleOverlayClick}>
      <div className="host-form">
        <div className="host-form-header">
          <h2>{editingHost ? 'Edit Host' : 'New Host'}</h2>
          <button className="host-form-close-btn" onClick={actions.closeHostForm}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="6" y1="18" x2="18" y2="6" />
            </svg>
          </button>
        </div>

        <div className="host-form-body">
          <div className="host-form-group">
            <label>Label</label>
            <input
              ref={labelRef}
              type="text"
              placeholder="My Server"
              value={form.label}
              onChange={e => updateField('label', e.target.value)}
            />
          </div>

          <div className="host-form-row">
            <div className="host-form-group" style={{ flex: 3 }}>
              <label>Hostname</label>
              <input
                type="text"
                placeholder="192.168.1.1 or example.com"
                value={form.hostname}
                onChange={e => updateField('hostname', e.target.value)}
              />
              {errors.hostname && <span className="host-form-error">{errors.hostname}</span>}
            </div>
            <div className="host-form-group" style={{ flex: 1 }}>
              <label>Port</label>
              <input
                type="number"
                placeholder="22"
                value={form.port}
                onChange={e => updateField('port', e.target.value)}
                min="1"
                max="65535"
              />
              {errors.port && <span className="host-form-error">{errors.port}</span>}
            </div>
          </div>

          <div className="host-form-group">
            <label>Username</label>
            <input
              type="text"
              placeholder="root"
              value={form.username}
              onChange={e => updateField('username', e.target.value)}
            />
            {errors.username && <span className="host-form-error">{errors.username}</span>}
          </div>

          <div className="host-form-group">
            <label>Authentication</label>
            <div className="host-form-auth-tabs">
              <button
                className={`host-form-auth-tab ${form.authType === 'password' ? 'active' : ''}`}
                onClick={() => updateField('authType', 'password')}
              >
                Password
              </button>
              <button
                className={`host-form-auth-tab ${form.authType === 'key' ? 'active' : ''}`}
                onClick={() => updateField('authType', 'key')}
              >
                SSH Key
              </button>
            </div>
          </div>

          {form.authType === 'password' && (
            <div className="host-form-group">
              <label>Password</label>
              <div className="host-form-password">
                <input
                  type={showPassword ? 'text' : 'password'}
                  placeholder="Enter password"
                  value={form.password}
                  onChange={e => updateField('password', e.target.value)}
                />
                <button
                  className="host-form-password-toggle"
                  onClick={() => setShowPassword(!showPassword)}
                  type="button"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    {showPassword ? (
                      <>
                        <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94" />
                        <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19" />
                        <line x1="1" y1="1" x2="23" y2="23" />
                      </>
                    ) : (
                      <>
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                        <circle cx="12" cy="12" r="3" />
                      </>
                    )}
                  </svg>
                </button>
              </div>
            </div>
          )}

          {form.authType === 'key' && (
            <div className="host-form-group">
              <label>SSH Key</label>
              <select
                value={form.keyId}
                onChange={e => updateField('keyId', e.target.value)}
              >
                <option value="">Select a key...</option>
                {keys.map(k => (
                  <option key={k.id} value={k.id}>{k.name || k.label} ({k.type})</option>
                ))}
              </select>
            </div>
          )}

          <div className="host-form-group">
            <label>Group</label>
            <select
              value={form.groupId}
              onChange={e => updateField('groupId', e.target.value)}
            >
              <option value="">No group</option>
              {groups.map(g => (
                <option key={g.id} value={g.id}>{g.label}</option>
              ))}
            </select>
          </div>

          <div className="host-form-group">
            <label>Tags</label>
            <div className="host-form-tags" onClick={() => document.getElementById('tag-input')?.focus()}>
              {form.tags.map(tag => (
                <span key={tag} className="host-form-tag">
                  {tag}
                  <button onClick={() => removeTag(tag)} type="button">×</button>
                </span>
              ))}
              <input
                id="tag-input"
                type="text"
                placeholder={form.tags.length === 0 ? 'Add tags...' : ''}
                value={tagInput}
                onChange={e => setTagInput(e.target.value)}
                onKeyDown={handleTagKeyDown}
              />
            </div>
          </div>
        </div>

        <div className="host-form-footer">
          <button className="host-form-cancel" onClick={actions.closeHostForm}>Cancel</button>
          <button className="host-form-save" onClick={handleSave}>
            {editingHost ? 'Save Changes' : 'Create Host'}
          </button>
        </div>
      </div>
    </div>
  );
}
