import React, { useState } from 'react';
import { hasCredential, mergeInto, sealedMembers } from './duplicates';
import { MACHINE, MACHINES } from '../../platform';

/**
 * Review and merge hosts that point at the same `user@host:port`. One card per
 * endpoint: pick the host to keep, see what the merge produces, merge. A merge
 * deletes the others on every synced computer, so it asks first and refuses a
 * group whose readable copy lives only on another computer (see
 * `sealedMembers`).
 */
export default function DuplicateReview({ duplicateGroups, groupsById, undecryptableIds, mergeBlockedReason, onMerge, onClose }) {
  return (
    <div className="dup-review" role="region" aria-label="Duplicate hosts">
      <div className="dup-review-head">
        <strong>Same server, saved more than once</strong>
        <button className="dup-btn dup-btn-ghost" onClick={onClose}>Close</button>
      </div>
      <p className="dup-review-intro">
        Usually a host created on two {MACHINES} before they synced. Keep one — it takes the group,
        tags and credential the others add — and the rest are removed from all your {MACHINES}.
      </p>
      {mergeBlockedReason && <div className="dup-note dup-note-warn">{mergeBlockedReason}</div>}
      {duplicateGroups.map(group => (
        <DuplicateGroup
          key={group.key}
          group={group}
          groupsById={groupsById}
          sealed={sealedMembers(group, undecryptableIds)}
          mergeBlocked={!!mergeBlockedReason}
          onMerge={onMerge}
        />
      ))}
    </div>
  );
}

function DuplicateGroup({ group, groupsById, sealed, mergeBlocked, onMerge }) {
  const [keepId, setKeepId] = useState(group.hosts[0].id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const survivor = group.hosts.find(h => h.id === keepId) || group.hosts[0];
  const others = group.hosts.filter(h => h.id !== survivor.id);
  const merged = mergeInto(survivor, others);
  const groupLabel = (id) => (id && groupsById[id]) || 'Ungrouped';
  const blocked = sealed.length > 0;

  const merge = async () => {
    const names = others.map(h => `“${h.label || h.hostname}”`).join(', ');
    const ok = window.confirm(
      `Keep “${survivor.label || survivor.hostname}” and delete ${names} from every ${MACHINE} you sync?`
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await onMerge(merged, others.map(h => h.id));
    } catch (err) {
      setError(err?.message || 'Could not merge these hosts.');
      setBusy(false);
    }
  };

  return (
    <div className="dup-group">
      <div className="dup-group-key">{group.key}</div>

      <div className="dup-members" role="radiogroup" aria-label={`Host to keep for ${group.key}`}>
        {group.hosts.map(h => {
          const isSealed = sealed.some(s => s.id === h.id);
          return (
            <label key={h.id} className={`dup-member ${h.id === survivor.id ? 'keep' : ''}`}>
              <input
                type="radio"
                name={`keep-${group.key}`}
                checked={h.id === survivor.id}
                onChange={() => setKeepId(h.id)}
                disabled={busy}
              />
              <span className="dup-member-body">
                <span className="dup-member-label">{h.label || h.hostname}</span>
                <span className="dup-member-meta">
                  {groupLabel(h.groupId)}
                  {' · '}
                  {isSealed ? `password sealed by another ${MACHINE}` : hasCredential(h) ? (h.authType === 'key' ? 'key' : 'password') : 'no credential'}
                  {h.createdAt ? ` · added ${new Date(h.createdAt).toLocaleDateString()}` : ''}
                </span>
              </span>
            </label>
          );
        })}
      </div>

      {blocked ? (
        <div className="dup-note dup-note-warn">
          Can’t merge yet: {sealed.map(h => `“${h.label || h.hostname}”`).join(', ')} still{' '}
          {sealed.length === 1 ? 'has its password' : 'have their passwords'} sealed by another
          {' '}{MACHINE}, which holds the only readable copy. Merging now would delete it there too.
          Update that {MACHINE} and unlock it with the account passphrase, then come back.
        </div>
      ) : (
        <>
          <div className="dup-note">
            Result: <strong>{merged.label || merged.hostname}</strong> in {groupLabel(merged.groupId)},{' '}
            {hasCredential(merged) ? (merged.authType === 'key' ? 'with its key' : 'with a password') : 'no credential'}
            {merged.tags.length ? `, tags: ${merged.tags.join(', ')}` : ''}.
          </div>
          <div className="dup-actions">
            <button className="dup-btn dup-btn-primary" onClick={merge} disabled={busy || mergeBlocked}>
              {busy ? 'Merging…' : `Merge — remove ${others.length} duplicate${others.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </>
      )}
      {error && <div className="dup-note dup-note-error">{error}</div>}
    </div>
  );
}
