/**
 * The web mirror's tabs (F3): the browser shows the tabs of ONE PC window,
 * live, and asks that window to change them. Pure: no `electron` require (the
 * harness drives it with fake windows, scripts/check-web.js).
 *
 *   PC renderer  mirror:report {tabs, layouts, focusedPane}   (every change)
 *   main         keeps the last report per PC window and pushes
 *                'mirror:state' to every browser watching that window
 *   browser      mirror:state (pull), mirror:select(windowId) (which window;
 *                default the primary), mirror:command {type, ...}
 *   main         validates the command and pushes 'mirror:command' to the
 *                PC window's renderer, which runs it the normal way
 *                (connectTab, the local pty spawn, endSessions…) and reports
 *                again. The browser never opens or ends anything itself.
 *
 * The active tab and the focused pane are each client's own: the report
 * carries the PC's focusedPane only as the browser's default, and opening a
 * tab from the browser does not switch the PC's tab bar.
 *
 * Browsers (one per socket, gateway.js) are listed for the PC (web:clients,
 * web:kick): login, user agent, when. Every change pushes 'web:clients' to
 * the PC windows, with `connected` set when one has just arrived (the PC
 * shows a notice).
 */

const TAB_TYPES = new Set(['terminal', 'local-terminal']);
const MAX_TABS = 100;
const MAX_DEPTH = 16;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const KEEPER_RE = /^[a-z0-9]{8,40}$/;
const COMMANDS = new Set(['open-host', 'open-local', 'close', 'rename', 'color', 'mute', 'split', 'reopen', 'background-end']);

const str = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);
const id = (v) => (typeof v === 'string' && ID_RE.test(v) ? v : null);
const size = (v) => (Number.isInteger(v) && v > 0 && v < 10000 ? v : null);

function cleanTree(node, ids, seen, depth = 0) {
  if (!node || typeof node !== 'object' || depth > MAX_DEPTH) return null;
  if (node.type === 'terminal') {
    if (typeof node.tabId !== 'string' || !ids.has(node.tabId) || seen.has(node.tabId)) return null;
    seen.add(node.tabId);
    return { type: 'terminal', tabId: node.tabId };
  }
  if (node.type !== 'split' || !Array.isArray(node.children) || node.children.length !== 2) return null;
  const a = cleanTree(node.children[0], ids, seen, depth + 1);
  const b = cleanTree(node.children[1], ids, seen, depth + 1);
  if (!a || !b) return null;
  const ratio = Number.isFinite(node.ratio) ? Math.min(0.95, Math.max(0.05, node.ratio)) : 0.5;
  return { type: 'split', direction: node.direction === 'vertical' ? 'vertical' : 'horizontal', ratio, children: [a, b] };
}

/** A PC window's report, with only known fields (it comes from a renderer). */
function cleanReport(raw) {
  const out = { tabs: [], layouts: {}, focusedPane: {} };
  if (!raw || typeof raw !== 'object') return out;
  const ids = new Set();
  for (const t of Array.isArray(raw.tabs) ? raw.tabs.slice(0, MAX_TABS) : []) {
    if (!t || typeof t !== 'object' || !TAB_TYPES.has(t.type)) continue;
    const tid = id(t.id);
    if (!tid || ids.has(tid)) continue;
    ids.add(tid);
    const tab = {
      id: tid,
      type: t.type,
      label: str(t.label, 120) || (t.type === 'local-terminal' ? 'Local Terminal' : 'Terminal'),
      alias: str(t.alias, 40),
      color: typeof t.color === 'string' && (t.color === 'none' || COLOR_RE.test(t.color)) ? t.color : null,
      muted: t.muted === true,
      hidden: t.hidden === true,
      hostId: str(t.hostId, 80),
      /* The live session: ssh session id, or the local pty's id */
      sessionId: str(t.sessionId, 120),
      connecting: t.connecting === true,
      error: str(t.error, 300),
      elsewhere: t.elsewhere === true,
      kept: t.kept === true,
      sessionKey: str(t.sessionKey, 80),
    };
    out.tabs.push(tab);
  }
  const seen = new Set();
  const layouts = raw.layouts && typeof raw.layouts === 'object' ? raw.layouts : {};
  for (const [gid, tree] of Object.entries(layouts)) {
    if (!ids.has(gid)) continue;
    const clean = cleanTree(tree, ids, seen);
    if (clean && clean.type === 'split') out.layouts[gid] = clean;
  }
  const fp = raw.focusedPane && typeof raw.focusedPane === 'object' ? raw.focusedPane : {};
  for (const [g, p] of Object.entries(fp)) {
    if (out.layouts[g] && typeof p === 'string' && ids.has(p)) out.focusedPane[g] = p;
  }
  return out;
}

/** A browser's order, cleaned; throws on anything else. */
function cleanCommand(raw) {
  if (!raw || typeof raw !== 'object' || !COMMANDS.has(raw.type)) throw new Error('Unknown command');
  const c = { type: raw.type };
  const need = (k, v) => { if (v === null || v === undefined) throw new Error(`Invalid ${k}`); c[k] = v; };
  const cols = size(raw.cols); const rows = size(raw.rows);
  const withSize = () => { if (cols && rows) { c.cols = cols; c.rows = rows; } };
  switch (raw.type) {
    case 'open-host': need('hostId', str(raw.hostId, 80)); need('tabId', id(raw.tabId)); withSize(); break;
    case 'open-local': need('tabId', id(raw.tabId)); withSize(); break;
    case 'close': {
      const ids = Array.isArray(raw.tabIds) ? raw.tabIds.slice(0, MAX_TABS).map(id).filter(Boolean) : [];
      if (!ids.length) throw new Error('Invalid tabIds');
      c.tabIds = [...new Set(ids)];
      const end = Array.isArray(raw.end) ? raw.end.map(id).filter(x => x && c.tabIds.includes(x)) : [];
      c.end = [...new Set(end)];
      break;
    }
    case 'rename': need('tabId', id(raw.tabId)); c.alias = typeof raw.alias === 'string' ? raw.alias.slice(0, 200) : ''; break;
    case 'color': need('tabId', id(raw.tabId)); c.color = typeof raw.color === 'string' && COLOR_RE.test(raw.color) ? raw.color : null; break;
    case 'mute': need('tabId', id(raw.tabId)); c.muted = raw.muted === true; break;
    case 'split':
      need('groupId', id(raw.groupId)); need('paneId', id(raw.paneId)); need('tabId', id(raw.tabId));
      c.direction = raw.direction === 'vertical' ? 'vertical' : 'horizontal';
      withSize();
      break;
    case 'reopen': need('keeperId', typeof raw.keeperId === 'string' && KEEPER_RE.test(raw.keeperId) ? raw.keeperId : null); need('tabId', id(raw.tabId)); withSize(); break;
    case 'background-end': need('keeperId', typeof raw.keeperId === 'string' && KEEPER_RE.test(raw.keeperId) ? raw.keeperId : null); break;
    default: throw new Error('Unknown command');
  }
  return c;
}

class Mirror {
  constructor(registry) {
    this._registry = registry || null;
    /** PC webContents -> cleaned report */
    this._reports = new Map();
    /** browser webContents -> { login, userAgent, connectedAt, source: windowId | null } */
    this._clients = new Map();
  }

  setRegistry(registry) { this._registry = registry; }

  get registry() {
    if (!this._registry) this._registry = require('../window-registry');
    return this._registry;
  }

  // ─── PC windows ─────────────────────────────────────────

  /** A PC window's tabs now. Browsers reporting are ignored. */
  report(wc, raw) {
    const reg = this.registry;
    const entry = reg.entryOf(wc);
    if (!entry || entry.virtual) return false;
    this._reports.set(entry.wc, cleanReport(raw));
    for (const client of this._clients.keys()) {
      const src = this._sourceOf(client);
      if (src && src.wc === entry.wc) reg.sendTo(client, 'mirror:state', this.stateFor(client));
    }
    return true;
  }

  /** A PC window closed: its tabs go; browsers watching it fall back to the primary. */
  windowGone(wc) {
    if (!this._reports.delete(wc)) return;
    for (const client of this._clients.keys()) this.registry.sendTo(client, 'mirror:state', this.stateFor(client));
  }

  // ─── Browsers ───────────────────────────────────────────

  _sourceOf(client) {
    const reg = this.registry;
    const c = this._clients.get(client);
    const chosen = c && c.source != null ? reg.byId(c.source) : null;
    if (chosen && reg.pcWindows().includes(chosen)) return chosen;
    return reg.primary();
  }

  /** What browser `client` shows: {windows, windowId, number, tabs, layouts, focusedPane} */
  stateFor(client) {
    const reg = this.registry;
    const src = this._sourceOf(client);
    const report = src ? this._reports.get(src.wc) : null;
    return {
      windows: reg.pcWindows().map(e => ({ id: e.id, number: e.number })),
      windowId: src ? src.id : null,
      number: src ? src.number : null,
      ...(report || { tabs: [], layouts: {}, focusedPane: {} }),
    };
  }

  /** Browser `client` mirrors PC window `windowId` from now on (null: the primary). */
  select(client, windowId) {
    const c = this._clients.get(client);
    if (!c) throw new Error('Unknown client');
    if (windowId == null) c.source = null;
    else {
      const e = this.registry.byId(windowId);
      if (!e || !this.registry.pcWindows().includes(e)) throw new Error('No such window');
      c.source = e.id;
    }
    return this.stateFor(client);
  }

  /** An order from browser `client` to the PC window it mirrors. */
  command(client, raw) {
    if (!this._clients.has(client)) throw new Error('Only a browser sends mirror commands');
    const cmd = cleanCommand(raw);
    const src = this._sourceOf(client);
    if (!src) throw new Error('No Termilab window is open on the PC');
    if (!this.registry.sendTo(src.wc, 'mirror:command', cmd)) throw new Error('The PC window did not take it');
    return { sent: true, windowId: src.id };
  }

  addClient(wc, meta = {}) {
    if (this._clients.has(wc)) return;
    this._clients.set(wc, {
      login: str(meta.login !== undefined ? meta.login : wc.login, 200),
      userAgent: str(meta.userAgent !== undefined ? meta.userAgent : wc.userAgent, 300),
      connectedAt: Number.isFinite(wc.connectedAt) ? wc.connectedAt : Date.now(),
      source: null,
    });
    this._notify(wc);
  }

  removeClient(wc) {
    if (!this._clients.delete(wc)) return;
    this._notify(null);
  }

  hasClient(wc) { return this._clients.has(wc); }

  /** [{id, login, userAgent, connectedAt}] for the PC's Settings → Remote access */
  clients() {
    return [...this._clients].map(([wc, c]) => ({ id: wc.id, login: c.login, userAgent: c.userAgent, connectedAt: c.connectedAt }));
  }

  /** Close browser `clientId`'s socket. */
  kick(clientId) {
    for (const wc of this._clients.keys()) {
      if (wc.id === clientId || String(wc.id) === String(clientId)) {
        if (typeof wc.disconnect === 'function') wc.disconnect();
        return true;
      }
    }
    return false;
  }

  _notify(connectedWc) {
    const reg = this.registry;
    const c = connectedWc ? this._clients.get(connectedWc) : null;
    const payload = { clients: this.clients(), connected: c ? { id: connectedWc.id, login: c.login } : null };
    for (const e of reg.pcWindows()) reg.sendTo(e.wc, 'web:clients', payload);
  }

  /** Harness */
  _reset() { this._reports.clear(); this._clients.clear(); }
}

module.exports = new Mirror();
module.exports.Mirror = Mirror;
module.exports.cleanReport = cleanReport;
module.exports.cleanCommand = cleanCommand;
