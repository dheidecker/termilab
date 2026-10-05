const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/*
 * Sessions THIS device sent to the background: a kept session (session
 * keeper, remote or local) whose tab went away while the session lives on —
 * a tab closed with "Keep running", a window closed with "Keep running", a
 * renderer that reloaded, or a quit with "Restore tabs on startup" off (with
 * it on, they come back as tabs and are not listed here). The Sessions dock
 * lists them under "Background" so they can be reopened instead of being
 * lost on a server nobody remembers.
 *
 *   <userData>/data/background-sessions.json   (next to keeper-state.json)
 *   { v: 1, sessions: [{ keeperId, sessionKey, kind: 'local'|'ssh', hostId,
 *                        label, alias, color, agent: {id, name}|null, detachedAt }] }
 *
 * Local to this device: never synced, never sent anywhere but this app's own
 * windows. No secrets: the connection config (password, key) is never read
 * into a record; only the fields above, each cleaned and capped.
 *
 * A record goes when its session ends (End, `exit`, killed, the keeper says
 * it is gone: keeper-service.forget / local exits) or when it is attached
 * into a tab again (ssh-service _wireStream, local-shell-service _launch).
 * Background lists (`keeper list`) reconcile: an id the keeper no longer has
 * is dropped.
 */

const ID_RE = /^[a-z0-9]{8,40}$/;
const CAP = 200;          // records kept (oldest dropped)
const META_CAP = 500;     // sessionId -> what the dock last showed for it

const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
const hexColor = (v) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null);

/** One record, as it may live on disk / travel to a renderer (null = invalid) */
function cleanRecord(r) {
  if (!r || typeof r !== 'object' || !ID_RE.test(String(r.keeperId || ''))) return null;
  const kind = r.kind === 'local' ? 'local' : 'ssh';
  const agent = r.agent && typeof r.agent === 'object' && (text(r.agent.id, 32) || text(r.agent.name, 40))
    ? { id: text(r.agent.id, 32) || null, name: text(r.agent.name, 40) || 'Agent' }
    : null;
  return {
    keeperId: r.keeperId,
    sessionKey: text(r.sessionKey, 120) || null,
    kind,
    hostId: kind === 'ssh' ? (text(r.hostId, 80) || null) : null,
    label: text(r.label, 80) || (kind === 'local' ? 'Local Terminal' : 'SSH'),
    alias: text(r.alias, 40) || null,
    color: hexColor(r.color),
    agent,
    detachedAt: Number.isFinite(r.detachedAt) ? r.detachedAt : Date.now(),
  };
}

class BackgroundSessions {
  constructor() {
    this._state = null;
    /* The harness points this somewhere else */
    this.file = null;
    /** sessionId -> {alias, color, agent, label} from the windows' session rows */
    this._meta = new Map();
    /** () => void, set by ipc-handlers: tell every window */
    this.onChange = null;
    /* Android has no Sessions dock: nothing is recorded there */
    this.enabled = process.platform !== 'android';
  }

  _path() {
    if (this.file) return this.file;
    const storeService = require('./store-service');
    return path.join(storeService.dataDir, 'background-sessions.json');
  }

  _load() {
    if (this._state) return this._state;
    let s = null;
    try { s = JSON.parse(fs.readFileSync(this._path(), 'utf-8')); } catch (_) { s = null; }
    const list = s && Array.isArray(s.sessions) ? s.sessions.map(cleanRecord).filter(Boolean) : [];
    this._state = { v: 1, sessions: list };
    return this._state;
  }

  /* Synchronous and atomic (tmp + rename, unique tmp name): a few hundred
     bytes, and it must land even from before-quit / a window's 'closed'. */
  _save() {
    const file = this._path();
    const body = JSON.stringify(this._load(), null, 2);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, body, { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      console.error('[Background] Could not save background-sessions.json:', err.message);
    }
    try { if (this.onChange) this.onChange(); } catch (_) { /* a window went away */ }
  }

  /** Every record, newest first (copies) */
  list() {
    return [...this._load().sessions].sort((a, b) => b.detachedAt - a.detachedAt).map(r => ({ ...r, agent: r.agent ? { ...r.agent } : null }));
  }

  has(keeperId) { return this._load().sessions.some(r => r.keeperId === keeperId); }

  /** What the Sessions dock shows for each live terminal (window:agents-report rows) */
  noteRows(rows) {
    if (!Array.isArray(rows)) return;
    for (const r of rows) {
      const sid = r && text(r.sessionId, 120);
      if (!sid) continue;
      this._meta.delete(sid);
      this._meta.set(sid, {
        alias: r.alias || null,
        color: r.color || null,
        label: r.host || null,
        agent: r.agentId || r.name ? { id: r.agentId || null, name: r.name || null } : null,
      });
    }
    while (this._meta.size > META_CAP) this._meta.delete(this._meta.keys().next().value);
  }

  /**
   * Kept session `sessionId` is being detached and nothing will show it:
   * info = {kind, keeperId, sessionKey, hostId, label} from the service that
   * holds it (never the config itself). → the record, or null.
   */
  noteDetach(sessionId, info) {
    if (!this.enabled || !info) return null;
    const meta = this._meta.get(sessionId) || {};
    this._meta.delete(sessionId);
    const rec = cleanRecord({
      keeperId: info.keeperId,
      sessionKey: info.sessionKey,
      kind: info.kind,
      hostId: info.hostId,
      label: meta.label || info.label,
      alias: meta.alias,
      color: meta.color,
      agent: meta.agent,
      detachedAt: Date.now(),
    });
    if (!rec) return null;
    const s = this._load();
    s.sessions = s.sessions.filter(r => r.keeperId !== rec.keeperId);
    s.sessions.push(rec);
    if (s.sessions.length > CAP) {
      s.sessions.sort((a, b) => a.detachedAt - b.detachedAt);
      s.sessions.splice(0, s.sessions.length - CAP);
    }
    this._save();
    return rec;
  }

  /** Session `keeperId` ended, or is in a tab again: off the list. → removed? */
  remove(keeperId) {
    const s = this._load();
    const n = s.sessions.length;
    s.sessions = s.sessions.filter(r => r.keeperId !== keeperId);
    if (s.sessions.length === n) return false;
    this._save();
    return true;
  }

  /** The dock's Rename… ('' = no alias) */
  rename(keeperId, alias) {
    const r = this._load().sessions.find(x => x.keeperId === keeperId);
    if (!r) return false;
    r.alias = text(alias, 40) || null;
    this._save();
    return true;
  }

  /**
   * A keeper `list` answered for local sessions (hostId null) or for host
   * `hostId`: records of that place whose id it no longer has are gone.
   * → the ids dropped.
   */
  reconcile(kind, hostId, liveIds) {
    const live = new Set(liveIds || []);
    const s = this._load();
    const gone = s.sessions.filter(r => r.kind === kind && (kind === 'local' || r.hostId === hostId) && !live.has(r.keeperId));
    if (!gone.length) return [];
    s.sessions = s.sessions.filter(r => !gone.includes(r));
    this._save();
    return gone.map(r => r.keeperId);
  }

  /* The harness: forget what is in memory (a restart reads the file again) */
  _reset() { this._state = null; this._meta.clear(); }
}

const service = new BackgroundSessions();
module.exports = service;
module.exports.BackgroundSessions = BackgroundSessions;
module.exports.cleanRecord = cleanRecord;
