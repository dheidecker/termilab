import React, { useState } from 'react';
import { useApp } from '../../contexts/AppContext';
import './PortForwarding.css';

export default function PortForwarding() {
  const { state, actions } = useApp();
  const { portForwards } = state;
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState({
    label: '',
    type: 'local',
    sourcePort: '',
    destHost: '',
    destPort: '',
  });

  const openForm = () => {
    setForm({ label: '', type: 'local', sourcePort: '', destHost: '', destPort: '' });
    setFormOpen(true);
  };

  const closeForm = () => setFormOpen(false);

  const handleSave = async () => {
    if (!form.sourcePort || !form.destPort) return;
    await actions.savePortForward({
      label: form.label.trim() || `${form.type} forward`,
      type: form.type,
      sourcePort: parseInt(form.sourcePort, 10),
      destHost: form.destHost.trim() || 'localhost',
      destPort: parseInt(form.destPort, 10),
      active: false,
    });
    closeForm();
  };

  const handleToggle = async (pf) => {
    if (pf.active) {
      await actions.stopPortForward(pf.id);
      await actions.savePortForward({ ...pf, active: false });
    } else {
      await actions.startPortForward({
        sessionId: pf.sessionId,
        type: pf.type,
        sourcePort: pf.sourcePort,
        destHost: pf.destHost,
        destPort: pf.destPort,
      });
      await actions.savePortForward({ ...pf, active: true });
    }
  };

  const handleDelete = async (id) => {
    if (confirm('Delete this port forward rule?')) {
      await actions.deletePortForward(id);
    }
  };

  const typeLabel = (type) => {
    switch (type) {
      case 'local': return 'Local';
      case 'remote': return 'Remote';
      case 'dynamic': return 'Dynamic';
      default: return type;
    }
  };

  return (
    <div className="port-forwarding">
      <div className="port-forwarding-header">
        <h2>Port Forwarding</h2>
        <button className="port-forwarding-add-btn" onClick={openForm}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New Rule
        </button>
      </div>

      <div className="port-forwarding-list">
        {portForwards.length === 0 ? (
          <div className="pf-empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="16 3 21 3 21 8" />
              <line x1="4" y1="20" x2="21" y2="3" />
              <polyline points="21 16 21 21 16 21" />
              <line x1="15" y1="15" x2="21" y2="21" />
              <line x1="4" y1="4" x2="9" y2="9" />
            </svg>
            <p>No port forwarding rules.<br />Create a rule to tunnel network traffic.</p>
          </div>
        ) : (
          portForwards.map(pf => (
            <div key={pf.id} className="pf-item">
              <div className="pf-item-top">
                <div className={`pf-item-status ${pf.active ? 'active' : ''}`} />
                <div className="pf-item-info">
                  <span className="pf-item-label">{pf.label}</span>
                  <span className="pf-item-type">{typeLabel(pf.type)}</span>
                </div>
              </div>
              <div className="pf-item-route">
                localhost:{pf.sourcePort}
                <span className="arrow">→</span>
                {pf.destHost}:{pf.destPort}
              </div>
              <div className="pf-item-actions">
                <button
                  className={`pf-toggle-btn ${pf.active ? 'stop' : 'start'}`}
                  onClick={() => handleToggle(pf)}
                >
                  {pf.active ? (
                    <>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="6" y="4" width="4" height="16" />
                        <rect x="14" y="4" width="4" height="16" />
                      </svg>
                      Stop
                    </>
                  ) : (
                    <>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polygon points="5 3 19 12 5 21 5 3" />
                      </svg>
                      Start
                    </>
                  )}
                </button>
                <button className="pf-delete-btn" onClick={() => handleDelete(pf.id)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                  </svg>
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Add form */}
      {formOpen && (
        <div className="pf-form-overlay" onClick={(e) => e.target === e.currentTarget && closeForm()}>
          <div className="pf-form">
            <div className="pf-form-header">
              <h3>New Port Forward</h3>
              <button className="pf-form-close" onClick={closeForm}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="6" y1="6" x2="18" y2="18" />
                  <line x1="6" y1="18" x2="18" y2="6" />
                </svg>
              </button>
            </div>
            <div className="pf-form-body">
              <div className="pf-form-group">
                <label>Label</label>
                <input
                  type="text"
                  placeholder="Database tunnel"
                  value={form.label}
                  onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
                  autoFocus
                />
              </div>
              <div className="pf-form-group">
                <label>Type</label>
                <div className="pf-type-tabs">
                  {['local', 'remote', 'dynamic'].map(t => (
                    <button
                      key={t}
                      className={`pf-type-tab ${form.type === t ? 'active' : ''}`}
                      onClick={() => setForm(f => ({ ...f, type: t }))}
                    >
                      {t.charAt(0).toUpperCase() + t.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="pf-form-group">
                <label>Source Port</label>
                <input
                  type="number"
                  placeholder="8080"
                  value={form.sourcePort}
                  onChange={e => setForm(f => ({ ...f, sourcePort: e.target.value }))}
                />
              </div>
              {form.type !== 'dynamic' && (
                <div className="pf-form-row">
                  <div className="pf-form-group" style={{ flex: 2 }}>
                    <label>Destination Host</label>
                    <input
                      type="text"
                      placeholder="localhost"
                      value={form.destHost}
                      onChange={e => setForm(f => ({ ...f, destHost: e.target.value }))}
                    />
                  </div>
                  <div className="pf-form-group" style={{ flex: 1 }}>
                    <label>Destination Port</label>
                    <input
                      type="number"
                      placeholder="3306"
                      value={form.destPort}
                      onChange={e => setForm(f => ({ ...f, destPort: e.target.value }))}
                    />
                  </div>
                </div>
              )}
            </div>
            <div className="pf-form-footer">
              <button className="snippet-form-cancel" onClick={closeForm}>Cancel</button>
              <button
                className="snippet-form-save"
                onClick={handleSave}
                disabled={!form.sourcePort || (form.type !== 'dynamic' && !form.destPort)}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
