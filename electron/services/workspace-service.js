/**
 * Restore the workspace on launch (desktop): which windows were open, where,
 * and in each its terminal tabs and split layouts.
 *
 *  - Every window's renderer reports its tabs (window:workspace-report) when
 *    they change; main adds the window's bounds and display and writes
 *    `<userData>/data/workspace.json` debounced (WRITE_DELAY_MS), under the
 *    store lock, and once more on quit. Local only: a workspace belongs to one
 *    computer (store-service never notifies sync about it).
 *  - On launch `begin()` decides: restore (setting `general.restoreTabs`,
 *    default on) or start clean. Restored windows get their saved tabs from
 *    window:workspace-take; the renderer recreates them and reconnects each
 *    saved host through the normal connect path (host-key prompts and all),
 *    150 ms apart.
 *  - Restore-loop guard: `launch.state` is 'restoring' on disk from the moment
 *    a restore starts until every restored window says window:workspace-restored
 *    (or the app quits in an orderly way). A launch that finds 'restoring'
 *    means the previous one died mid-restore: it starts clean ONCE.
 *  - What is saved per tab: kind (host | local | quick), host id, label,
 *    alias, colour, mute, hidden, the stable sessionKey. Never scrollback,
 *    never credentials. Quick connects are saved only to say, on restore,
 *    that they were not reconnected.
 *
 * No `electron` require at load: the harness drives it with fake windows.
 */

const WRITE_DELAY_MS = 1000;
const VERSION = 1;
const MAX_WINDOWS = 16;
const MAX_TABS = 100;
const MAX_DEPTH = 16;
const KINDS = new Set(['host', 'local', 'quick']);
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const str = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);

/* ─── Sanitizing what a renderer reports (and what is read back) ─── */

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

/** {tabs, layouts, activeTabId, focusedPane} with only known fields and sane values */
function sanitizeWindow(raw) {
  const out = { tabs: [], layouts: {}, activeTabId: null, focusedPane: {} };
  if (!raw || typeof raw !== 'object') return out;
  const ids = new Set();
  for (const t of Array.isArray(raw.tabs) ? raw.tabs.slice(0, MAX_TABS) : []) {
    if (!t || typeof t !== 'object') continue;
    const id = str(t.id, 80);
    if (!id || ids.has(id) || !KINDS.has(t.kind)) continue;
    const tab = { id, kind: t.kind, label: str(t.label, 120) || (t.kind === 'local' ? 'Local Terminal' : 'Terminal') };
    if (t.kind === 'host') {
      tab.hostId = str(t.hostId, 80);
      if (!tab.hostId) continue;
    }
    if (t.kind === 'quick') { const target = str(t.target, 200); if (target) tab.target = target; }
    const alias = str(t.alias, 40);
    if (alias) tab.alias = alias;
    if (typeof t.color === 'string' && (t.color === 'none' || COLOR_RE.test(t.color))) tab.color = t.color;
    if (t.muted === true) tab.muted = true;
    if (t.hidden === true) tab.hidden = true;
    tab.sessionKey = str(t.sessionKey, 80) || id;
    ids.add(id);
    out.tabs.push(tab);
  }
  const seen = new Set();
  const layouts = raw.layouts && typeof raw.layouts === 'object' ? raw.layouts : {};
  for (const [gid, tree] of Object.entries(layouts)) {
    if (!ids.has(gid)) continue;
    const clean = cleanTree(tree, ids, seen);
    /* A group's tree must hold the group itself, and be more than one leaf */
    if (clean && clean.type === 'split' && JSON.stringify(clean).includes(`"tabId":${JSON.stringify(gid)}`)) out.layouts[gid] = clean;
  }
  if (typeof raw.activeTabId === 'string' && ids.has(raw.activeTabId)) out.activeTabId = raw.activeTabId;
  const fp = raw.focusedPane && typeof raw.focusedPane === 'object' ? raw.focusedPane : {};
  for (const [g, p] of Object.entries(fp)) {
    if (out.layouts[g] && typeof p === 'string' && ids.has(p)) out.focusedPane[g] = p;
  }
  return out;
}

function cleanBounds(b) {
  if (!b || typeof b !== 'object') return null;
  const n = (v) => (Number.isFinite(v) ? Math.round(v) : null);
  const x = n(b.x); const y = n(b.y); const width = n(b.width); const height = n(b.height);
  if (x === null || y === null || !(width > 0) || !(height > 0)) return null;
  return { x, y, width, height };
}

/* ─── Displays ─── */

const area = (a, b) => {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};

/**
 * Put saved bounds on a display that exists now. `displays` = [{id, workArea}],
 * `primaryId` the primary's id. The saved display if it is still there and the
 * window overlaps it; else the display it overlaps most; else the primary,
 * centred. Then shrunk to fit and moved fully inside that work area.
 */
function clampBounds(bounds, displays, { displayId = null, primaryId = null } = {}) {
  const b = cleanBounds(bounds);
  if (!b || !Array.isArray(displays) || !displays.length) return b;
  const list = displays.filter(d => d && d.workArea && d.workArea.width > 0 && d.workArea.height > 0);
  if (!list.length) return b;
  let target = list.find(d => d.id === displayId && area(b, d.workArea) > 0) || null;
  let centre = false;
  if (!target) {
    let best = 0;
    for (const d of list) { const a = area(b, d.workArea); if (a > best) { best = a; target = d; } }
  }
  if (!target) {
    target = list.find(d => d.id === primaryId) || list[0];
    centre = true;
  }
  const wa = target.workArea;
  const width = Math.min(b.width, wa.width);
  const height = Math.min(b.height, wa.height);
  let x = centre ? wa.x + Math.round((wa.width - width) / 2) : b.x;
  let y = centre ? wa.y + Math.round((wa.height - height) / 2) : b.y;
  x = Math.min(Math.max(x, wa.x), wa.x + wa.width - width);
  y = Math.min(Math.max(y, wa.y), wa.y + wa.height - height);
  return { x, y, width, height };
}

/**
 * What this launch does with the saved workspace (pure).
 * → { windows: [{bounds, maximized, payload}], launch, crashed, reason }
 */
function planLaunch(saved, { restoreEnabled = true, displays = [], primaryId = null, now = Date.now() } = {}) {
  const clean = (reason, crashed = false) => ({ windows: [], launch: { state: 'ok', at: now }, crashed, reason });
  if (!saved || typeof saved !== 'object' || !Array.isArray(saved.windows)) return clean('none');
  if (saved.launch && saved.launch.state === 'restoring') return clean('crashed', true);
  if (!restoreEnabled) return clean('disabled');
  const windows = [];
  for (const w of saved.windows.slice(0, MAX_WINDOWS)) {
    if (!w || typeof w !== 'object') continue;
    const payload = sanitizeWindow(w);
    windows.push({
      bounds: clampBounds(w.bounds, displays, { displayId: w.displayId, primaryId }),
      maximized: w.maximized === true,
      payload,
    });
  }
  if (!windows.length) return clean('empty');
  return { windows, launch: { state: 'restoring', at: now }, crashed: false, reason: 'restore' };
}

/* ─── The service ─── */

class WorkspaceService {
  constructor() {
    /** webContents -> { win, snap, payload (until taken), order } */
    this._windows = new Map();
    this._awaitingOk = new Set();
    this._launch = { state: 'ok', at: Date.now() };
    this._timer = null;
    this._frozen = false;
    this._seq = 0;
    this._writing = Promise.resolve();
    this.writeDelayMs = WRITE_DELAY_MS;
    /** Injected (harness): () => ({ displays, primaryId }) */
    this.screenInfo = null;
    /** The last plan begin() made (for the harness and logs) */
    this.lastPlan = null;
  }

  _store() { return require('./store-service'); }

  _screen() {
    if (this.screenInfo) return this.screenInfo();
    try {
      const { screen } = require('electron');
      if (!screen || typeof screen.getAllDisplays !== 'function') return { displays: [], primaryId: null };
      return {
        displays: screen.getAllDisplays().map(d => ({ id: d.id, workArea: d.workArea })),
        primaryId: screen.getPrimaryDisplay().id,
      };
    } catch (_) {
      return { displays: [], primaryId: null };
    }
  }

  /**
   * At launch, before any window: read settings + the saved workspace and
   * decide. Writes the launch state right away (the restore-loop guard must be
   * on disk before anything that could crash runs).
   */
  async begin() {
    const store = this._store();
    let restoreEnabled = true;
    try {
      const settings = await store.getSettings();
      restoreEnabled = settings?.general?.restoreTabs !== false;
    } catch (_) { /* defaults: on */ }
    const saved = await store.getWorkspace();
    const plan = planLaunch(saved, { restoreEnabled, ...this._screen() });
    this.lastPlan = plan;
    this._launch = plan.launch;
    if (plan.crashed) console.warn('[Workspace] The last launch did not finish restoring its tabs: starting clean this time.');
    /* Restoring: say so on disk first. Not restoring: leave the file alone
       until the first report (a crash guard that found 'restoring' clears it). */
    if (plan.windows.length || plan.crashed) {
      await this._write({ v: VERSION, launch: this._launch, windows: plan.crashed ? [] : (saved?.windows || []) });
    }
    return plan;
  }

  /** A window exists (every window, via attachWindow) */
  attach(win) {
    const wc = win && win.webContents ? win.webContents : win;
    if (!wc || this._windows.has(wc)) return;
    const e = { win, snap: null, payload: null, order: ++this._seq, lastBounds: null, lastMaximized: false };
    this._windows.set(wc, e);
    if (win && typeof win.on === 'function') {
      for (const ev of ['move', 'resize', 'maximize', 'unmaximize']) win.on(ev, () => this.schedule());
      /* Last look before it is destroyed: the close that quits the app is
         written after the window is gone */
      win.on('close', () => { if (!this._frozen) this._geometry(e); });
    }
  }

  /** A window created to restore `planned` ({payload, ...}) */
  assign(win, planned) {
    const wc = win && win.webContents ? win.webContents : win;
    this.attach(win);
    const e = this._windows.get(wc);
    if (!e) return;
    e.payload = planned.payload;
    e.snap = planned.payload;        // its saved entry stands until it reports
    this._awaitingOk.add(wc);
  }

  /** The renderer asks once what to restore; null afterwards (a reload starts empty) */
  take(wc) {
    const e = this._windows.get(wc);
    if (!e || !e.payload) return null;
    const p = e.payload;
    e.payload = null;
    return p;
  }

  report(wc, raw) {
    if (this._frozen) return false;
    const e = this._windows.get(wc);
    if (!e) return false;
    e.snap = sanitizeWindow(raw);
    this.schedule();
    return true;
  }

  /** The renderer recreated its tabs and started its reconnects */
  restored(wc) {
    this._awaitingOk.delete(wc);
    if (this._launch.state === 'restoring' && this._awaitingOk.size === 0) {
      this._launch = { state: 'ok', at: Date.now() };
      this.schedule(0);
    }
    return this._launch.state;
  }

  /**
   * A window closed. While the app keeps running (another window open, or
   * macOS) closing it ends its tabs, so it leaves the workspace; when it is the
   * close that quits the app (`keep`) the workspace stays as it was.
   */
  windowClosed(wc, { keep = false } = {}) {
    if (this._frozen) return;
    this._awaitingOk.delete(wc);
    if (keep) { this.freeze(); return; }
    this._windows.delete(wc);
    if (this._launch.state === 'restoring' && this._awaitingOk.size === 0) this._launch = { state: 'ok', at: Date.now() };
    this.schedule();
  }

  /** Quitting: later reports (tabs closing as sessions end) are not the user's */
  freeze() { this._frozen = true; }

  /* A write within `delay` of the FIRST change pending, not of the last: a
     steady stream of reports (tabs connecting one by one) must not keep
     postponing it, nor the 'ok' that clears the restore-loop guard. */
  schedule(delay = this.writeDelayMs) {
    const due = Date.now() + delay;
    if (this._timer && this._due <= due) return;
    clearTimeout(this._timer);
    this._due = due;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush().catch(err => console.error('[Workspace] Could not save:', err.message));
    }, delay);
    if (this._timer.unref) this._timer.unref();
  }

  _bounds(win) {
    try {
      if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return null;
      /* A maximized window keeps the size it will un-maximize to */
      const b = typeof win.getNormalBounds === 'function' ? win.getNormalBounds() : win.getBounds();
      return cleanBounds(b);
    } catch (_) { return null; }
  }

  /* Bounds and maximized now, or as last seen if the window is gone */
  _geometry(e) {
    const bounds = this._bounds(e.win);
    if (bounds) {
      e.lastBounds = bounds;
      try { e.lastMaximized = !!(typeof e.win.isMaximized === 'function' && e.win.isMaximized()); } catch (_) { /* gone */ }
    }
    return { bounds: e.lastBounds, maximized: e.lastMaximized };
  }

  _displayOf(bounds) {
    if (!bounds) return null;
    const { displays } = this._screen();
    let best = null; let max = 0;
    for (const d of displays || []) { const a = area(bounds, d.workArea || {}); if (a > max) { max = a; best = d.id; } }
    return best;
  }

  serialize() {
    const windows = [];
    for (const e of [...this._windows.values()].sort((a, b) => a.order - b.order)) {
      const snap = e.snap || { tabs: [], layouts: {}, activeTabId: null, focusedPane: {} };
      const { bounds, maximized } = this._geometry(e);
      windows.push({ bounds, displayId: this._displayOf(bounds), maximized, ...snap });
    }
    return { v: VERSION, launch: this._launch, windows };
  }

  _write(data) {
    const store = this._store();
    this._writing = this._writing.catch(() => {}).then(() => store.saveWorkspace(data));
    return this._writing;
  }

  async flush() {
    clearTimeout(this._timer);
    this._timer = null;
    return this._write(this.serialize());
  }

  /** before-quit: an orderly quit is not a crash, even mid-restore */
  async quitFlush() {
    const data = this._quitData();
    clearTimeout(this._timer);
    this._timer = null;
    return this._write(data);
  }

  quitFlushSync() {
    const data = this._quitData();
    clearTimeout(this._timer);
    this._timer = null;
    this._store().saveWorkspaceSync(data);
  }

  _quitData() {
    this.freeze();
    if (this._launch.state === 'restoring') this._launch = { state: 'ok', at: Date.now() };
    return this.serialize();
  }

  /** Harness: back to a fresh process */
  _reset() {
    clearTimeout(this._timer);
    this._timer = null;
    this._windows.clear();
    this._awaitingOk.clear();
    this._launch = { state: 'ok', at: Date.now() };
    this._frozen = false;
    this.lastPlan = null;
  }
}

module.exports = new WorkspaceService();
module.exports.WorkspaceService = WorkspaceService;
module.exports.sanitizeWindow = sanitizeWindow;
module.exports.clampBounds = clampBounds;
module.exports.planLaunch = planLaunch;
module.exports.WRITE_DELAY_MS = WRITE_DELAY_MS;
