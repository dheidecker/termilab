import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { CloseIcon, TrashIcon, ServerIcon, CheckIcon } from '../Icons/icons';
import { hostColor } from '../HostList/hostColor';
import ForwardDiagram from './ForwardDiagram';
import { TYPES, TYPE_INFO, DEFAULT_BIND, checkRule, toRule, routeSummary } from './rules';

/**
 * Right-hand drawer (same classes as the host editor) for one rule.
 *
 * New rule: a wizard — type (with diagram) → host → ports → label — or the
 * whole form at once with "Skip wizard". Editing: the whole form, with Delete.
 */

const WIZARD = ['type', 'host', 'ports', 'label'];

const emptyForm = (type) => ({
  label: '', type: type || 'local', hostId: '', bindAddress: DEFAULT_BIND, localPort: '', destHost: '', destPort: '',
});

const fromRule = (rule) => ({
  id: rule.id,
  label: rule.label || '',
  type: TYPES.includes(rule.type) ? rule.type : 'local',
  hostId: rule.hostId || '',
  bindAddress: rule.bindAddress || DEFAULT_BIND,
  localPort: rule.localPort ?? '',
  destHost: rule.destHost || '',
  destPort: rule.destPort ?? '',
  createdAt: rule.createdAt,
});

const hostName = (h) => h.label || h.hostname;

function TypeSwitch({ value, onChange }) {
  return (
    <div className="host-form-auth-tabs pf-type-switch" role="radiogroup" aria-label="Port forwarding type">
      {TYPES.map(t => (
        <button
          key={t}
          type="button"
          role="radio"
          aria-checked={value === t}
          className={`host-form-auth-tab ${value === t ? 'active' : ''}`}
          onClick={() => onChange(t)}
        >
          {TYPE_INFO[t].label}
        </button>
      ))}
    </div>
  );
}

function Field({ id, label, error, warning, hint, children, flex }) {
  return (
    <div className="host-form-group" style={flex ? { flex } : undefined}>
      <label htmlFor={id}>{label}</label>
      {children}
      {error ? <span className="host-form-error">{error}</span>
        : warning ? <span className="pf-warning">{warning}</span>
          : hint ? <span className="pf-hint">{hint}</span> : null}
    </div>
  );
}

function HostPicker({ hosts, groupMap, value, onChange, error, idBase }) {
  if (!hosts.length) {
    return <p className="pf-hint">No saved hosts yet. Add one in Hosts first: the tunnel uses its address and credentials.</p>;
  }
  return (
    <>
      <div className="pf-host-list" role="radiogroup" aria-label="Host" id={idBase}>
        {hosts.map(h => (
          <button
            key={h.id}
            type="button"
            role="radio"
            aria-checked={value === h.id}
            className={`pf-host-option ${value === h.id ? 'selected' : ''}`}
            onClick={() => onChange(h.id)}
          >
            <span className="hv-icon pf-host-icon" style={{ background: hostColor(h, groupMap) }}><ServerIcon /></span>
            <span className="pf-host-text">
              <span className="pf-host-name">{hostName(h)}</span>
              <span className="pf-host-addr">{h.username}@{h.hostname}{h.port && Number(h.port) !== 22 ? `:${h.port}` : ''}</span>
            </span>
            {value === h.id && <CheckIcon className="pf-host-check" />}
          </button>
        ))}
      </div>
      {error && <span className="host-form-error">{error}</span>}
    </>
  );
}

function PortFields({ form, set, errors, warnings, ids, hostLabel }) {
  const num = (k) => (e) => set(k, e.target.value.replace(/[^\d]/g, '').slice(0, 5));
  const txt = (k) => (e) => set(k, e.target.value);
  const via = hostLabel || 'the server';

  if (form.type === 'dynamic') {
    return (
      <>
        <div className="host-form-row">
          <Field id={ids.bind} label="Local address" error={errors.bindAddress} flex={2}
            hint="127.0.0.1 keeps the proxy to this computer.">
            <input id={ids.bind} type="text" value={form.bindAddress} onChange={txt('bindAddress')} spellCheck={false} />
          </Field>
          <Field id={ids.lport} label="SOCKS5 port" error={errors.localPort} warning={warnings.localPort} flex={1}>
            <input id={ids.lport} type="text" inputMode="numeric" placeholder="1080" value={form.localPort} onChange={num('localPort')} />
          </Field>
        </div>
        <p className="pf-explain-values">
          Point an app’s SOCKS5 proxy at <code>{form.bindAddress || DEFAULT_BIND}:{form.localPort || '1080'}</code> and its
          traffic leaves from {via}.
        </p>
      </>
    );
  }

  const remote = form.type === 'remote';
  return (
    <>
      <div className="host-form-row">
        <Field id={ids.bind} label={remote ? 'Bind address on the server' : 'Local address'} error={errors.bindAddress} flex={2}
          hint={remote ? '127.0.0.1 = only the server itself; 0.0.0.0 = anyone who can reach it.' : '127.0.0.1 keeps the port to this computer.'}>
          <input id={ids.bind} type="text" value={form.bindAddress} onChange={txt('bindAddress')} spellCheck={false} />
        </Field>
        <Field id={ids.lport} label={remote ? 'Port on the server' : 'Local port'} error={errors.localPort} warning={warnings.localPort} flex={1}>
          <input id={ids.lport} type="text" inputMode="numeric" placeholder={remote ? '9000' : '8080'} value={form.localPort} onChange={num('localPort')} />
        </Field>
      </div>
      <div className="host-form-row">
        <Field id={ids.dhost} label={remote ? 'Destination host (from this computer)' : 'Destination host (from the server)'} error={errors.destHost} flex={2}>
          <input id={ids.dhost} type="text" placeholder={remote ? 'localhost' : 'localhost or db.internal'} value={form.destHost} onChange={txt('destHost')} spellCheck={false} />
        </Field>
        <Field id={ids.dport} label="Destination port" error={errors.destPort} flex={1}>
          <input id={ids.dport} type="text" inputMode="numeric" placeholder={remote ? '3000' : '5432'} value={form.destPort} onChange={num('destPort')} />
        </Field>
      </div>
      <p className="pf-explain-values">
        {remote ? (
          <>Connections to port <code>{form.localPort || '9000'}</code> on {via} arrive at{' '}
            <code>{form.destHost || 'localhost'}:{form.destPort || '3000'}</code> as seen from this computer.</>
        ) : (
          <>Connections to <code>{form.bindAddress || DEFAULT_BIND}:{form.localPort || '8080'}</code> on this computer reach{' '}
            <code>{form.destHost || 'localhost'}:{form.destPort || '5432'}</code> as seen from {via}.</>
        )}
      </p>
    </>
  );
}

export default function PortForwardDrawer({
  rule, initialType, hosts, groupMap, running = false, lastError = null, onClose, onSave, onDelete,
}) {
  const editing = !!rule;
  const [form, setForm] = useState(() => (rule ? fromRule(rule) : emptyForm(initialType)));
  const [step, setStep] = useState(editing ? 'form' : 'type');
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const bodyRef = useRef(null);
  const uid = useId();
  const ids = {
    label: `${uid}-label`, host: `${uid}-host`, bind: `${uid}-bind`, lport: `${uid}-lport`,
    dhost: `${uid}-dhost`, dport: `${uid}-dport`,
  };

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  /* New step: start at the top, focus its first field */
  useEffect(() => {
    bodyRef.current?.scrollTo?.(0, 0);
    const body = bodyRef.current;
    const first = body?.querySelector('input, select') || body?.querySelector('[role="radio"][aria-checked="true"]')
      || body?.querySelector('[role="radio"]');
    first?.focus?.({ preventScroll: true });
  }, [step]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const selectedHost = hosts.find(h => h.id === form.hostId) || null;
  const { errors, warnings } = useMemo(() => checkRule(form), [form]);
  const visibleErrors = showErrors ? errors : {};

  const stepValid = (s) => {
    if (s === 'host') return !errors.hostId;
    if (s === 'ports') return !['bindAddress', 'localPort', 'destHost', 'destPort'].some(k => errors[k]);
    return true;
  };

  const save = async () => {
    setShowErrors(true);
    if (Object.keys(errors).length) {
      if (step !== 'form' && step !== 'label') return;
      if (step === 'label') { setStep(errors.hostId ? 'host' : 'ports'); return; }
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const out = toRule(form);
      if (form.createdAt) out.createdAt = form.createdAt;
      await onSave(out);
      onClose();
    } catch (err) {
      setSaveError(err?.message || 'Could not save it');
      setSaving(false);
    }
  };

  const next = () => {
    const i = WIZARD.indexOf(step);
    if (!stepValid(step)) { setShowErrors(true); return; }
    setShowErrors(false);
    if (i === WIZARD.length - 1) save();
    else setStep(WIZARD[i + 1]);
  };
  const back = () => {
    setShowErrors(false);
    const i = WIZARD.indexOf(step);
    setStep(i > 0 ? WIZARD[i - 1] : 'type');
  };

  const handleDelete = () => {
    const extra = running ? ' It is running and will be stopped.' : '';
    if (window.confirm(`Delete the port forwarding rule “${form.label || routeSummary(toRule(form))}”?${extra}`)) {
      onDelete(rule.id);
      onClose();
    }
  };

  const suggestedLabel = toRule({ ...form, label: '' }).label;
  const labelPlaceholder = selectedHost
    ? `${hostName(selectedHost)} ${form.type === 'dynamic' ? 'SOCKS' : form.localPort || ''}`.trim()
    : suggestedLabel;

  const title = editing ? 'Edit Port Forwarding' : 'New Port Forwarding';
  const wizardIndex = WIZARD.indexOf(step);

  const typeBlock = (big) => (
    <>
      {big && <p className="pf-step-title">Select the port forwarding type:</p>}
      <TypeSwitch value={form.type} onChange={(t) => set('type', t)} />
      {big && <ForwardDiagram type={form.type} />}
      <p className={big ? 'pf-type-explain' : 'pf-hint'}>{TYPE_INFO[form.type].explain}</p>
    </>
  );

  const labelField = (
    <Field id={ids.label} label="Label" hint="Shown on the card.">
      <input
        id={ids.label}
        type="text"
        placeholder={labelPlaceholder}
        value={form.label}
        onChange={e => set('label', e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && step === 'label') save(); }}
      />
    </Field>
  );

  const hostField = (
    <div className="host-form-group">
      <label htmlFor={ids.host}>Host</label>
      <select id={ids.host} value={form.hostId} onChange={e => set('hostId', e.target.value)}>
        <option value="">Choose a host…</option>
        {hosts.map(h => <option key={h.id} value={h.id}>{hostName(h)} ({h.username}@{h.hostname})</option>)}
      </select>
      {visibleErrors.hostId ? <span className="host-form-error">{visibleErrors.hostId}</span>
        : !form.hostId && editing ? <span className="pf-warning">This rule has no host yet: choose one to be able to start it.</span>
          : <span className="pf-hint">The tunnel uses this host’s address and saved credentials.</span>}
    </div>
  );

  let body;
  let footer;
  if (step === 'form') {
    body = (
      <>
        {running && <div className="pf-notice">This rule is running. Stop and start it again to apply changes.</div>}
        {!running && lastError && <div className="pf-notice pf-notice-error">Last start failed: {lastError}</div>}
        <div className="host-form-group">
          <label>Type</label>
          {typeBlock(false)}
        </div>
        {hostField}
        <PortFields form={form} set={set} errors={visibleErrors} warnings={warnings} ids={ids} hostLabel={selectedHost && hostName(selectedHost)} />
        {labelField}
      </>
    );
    footer = editing ? (
      <>
        <button className="pf-delete" onClick={handleDelete}><TrashIcon /> Delete</button>
        <button className="host-form-save" onClick={save} disabled={saving}>Save Changes</button>
      </>
    ) : (
      <>
        <button className="host-form-cancel" onClick={onClose}>Cancel</button>
        <button className="host-form-save" onClick={save} disabled={saving}>Create</button>
      </>
    );
  } else {
    body = (
      <>
        <ol className="pf-steps" aria-label={`Step ${wizardIndex + 1} of ${WIZARD.length}`}>
          {['Type', 'Host', 'Ports', 'Label'].map((name, i) => (
            <li key={name} className={i === wizardIndex ? 'current' : i < wizardIndex ? 'done' : ''}>
              <span className="pf-step-dot">{i < wizardIndex ? <CheckIcon /> : i + 1}</span>
              <span className="pf-step-name">{name}</span>
            </li>
          ))}
        </ol>
        {step === 'type' && typeBlock(true)}
        {step === 'host' && (
          <>
            <p className="pf-step-title">Select the host to tunnel through:</p>
            <HostPicker hosts={hosts} groupMap={groupMap} value={form.hostId} onChange={(id) => set('hostId', id)}
              error={visibleErrors.hostId} idBase={ids.host} />
          </>
        )}
        {step === 'ports' && (
          <>
            <p className="pf-step-title">
              {form.type === 'dynamic' ? 'Where should the SOCKS5 proxy listen?' : form.type === 'remote' ? 'Which port opens on the server, and where does it lead?' : 'Which local port, and where does it lead?'}
            </p>
            <PortFields form={form} set={set} errors={visibleErrors} warnings={warnings} ids={ids} hostLabel={selectedHost && hostName(selectedHost)} />
          </>
        )}
        {step === 'label' && (
          <>
            <p className="pf-step-title">Give it a name:</p>
            {labelField}
            <div className="pf-review">
              <span className={`hv-icon pf-letter pf-letter-${form.type}`} aria-hidden="true">{TYPE_INFO[form.type].letter}</span>
              <span className="pf-review-text">
                <span className="hv-card-label">{form.label || labelPlaceholder}</span>
                <span className="hv-card-sub">{selectedHost ? hostName(selectedHost) : 'No host'} · {routeSummary(toRule(form))}</span>
              </span>
            </div>
          </>
        )}
      </>
    );
    footer = step === 'type' ? (
      <>
        <button className="host-form-cancel" onClick={() => setStep('form')}>Skip wizard</button>
        <button className="host-form-save" onClick={next}>Continue</button>
      </>
    ) : (
      <>
        <button className="host-form-cancel" onClick={back}>Back</button>
        <button className="host-form-save" onClick={next} disabled={saving || (step === 'host' && !hosts.length)}>
          {step === 'label' ? 'Create' : 'Continue'}
        </button>
      </>
    );
  }

  return (
    <div className="host-form-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="host-form pf-drawer" role="dialog" aria-modal="true" aria-label={title}>
        <div className="host-form-header">
          <h2>{title}</h2>
          <button className="host-form-close-btn" onClick={onClose} aria-label="Close"><CloseIcon /></button>
        </div>
        <div className="host-form-body" ref={bodyRef}>
          {body}
          {saveError && <span className="host-form-error">{saveError}</span>}
        </div>
        <div className="host-form-footer">{footer}</div>
      </aside>
    </div>
  );
}
