/**
 * What AI agents did through Termilab, shown in Logs.
 *
 *   <userData>/data/agent-logs.json   (0600, this computer only, never synced)
 *
 * Entry: { id, type: 'agent', tool, host, hostId, hostname?, port?, username?,
 *          command?, exitCode?, category?, ok, error?, durationMs, startedAt, endedAt }
 *
 * A destructive command adds one more entry with the user's decision:
 * tool "run_command (approved)" / "send_input (blocked)", plus `category`.
 *
 * Never the output, never file contents. A deliberate separate file, not the
 * `connection-logs` collection: that one syncs as plaintext to the server,
 * and a command line an agent typed can hold anything.
 */
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const MAX_ENTRIES = 1000;
const MAX_COMMAND = 1000;
const FILE = 'agent-logs.json';

let seq = 0;

class AgentLog {
  /** @param {() => string} dataDir  resolved lazily (userData can change in the harness) */
  constructor(dataDir) {
    this._dataDir = dataDir;
    this._chain = Promise.resolve();
  }

  _file() { return path.join(this._dataDir(), FILE); }

  async _read() {
    try {
      const list = JSON.parse(await fsp.readFile(this._file(), 'utf-8'));
      return Array.isArray(list) ? list : [];
    } catch (_) {
      return [];
    }
  }

  async _write(list) {
    const file = this._file();
    await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${++seq}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(list), { mode: 0o600 });
    await fsp.rename(tmp, file);
  }

  /* One writer at a time: read-modify-write is not atomic otherwise. */
  _serial(fn) {
    const run = this._chain.then(fn, fn);
    this._chain = run.catch(() => {});
    return run;
  }

  add(info) {
    const entry = {
      id: crypto.randomUUID(),
      type: 'agent',
      tool: String(info.tool || ''),
      host: String(info.host || '').slice(0, 200),
      hostId: info.hostId || null,
      ok: !!info.ok,
      durationMs: Math.max(0, Math.round(Number(info.durationMs) || 0)),
      startedAt: info.startedAt || new Date().toISOString(),
      endedAt: info.endedAt || new Date().toISOString(),
    };
    if (info.hostname) entry.hostname = String(info.hostname);
    if (info.port) entry.port = Number(info.port) || 22;
    if (info.username) entry.username = String(info.username);
    if (info.command != null) {
      const c = String(info.command);
      entry.command = c.length > MAX_COMMAND ? `${c.slice(0, MAX_COMMAND)}…` : c;
    }
    if (info.exitCode !== undefined) entry.exitCode = info.exitCode;
    /* destructive.js category of a command that needed the user's approval */
    if (info.category) entry.category = String(info.category).slice(0, 40);
    if (info.error) entry.error = String(info.error).slice(0, 300);
    return this._serial(async () => {
      const list = await this._read();
      list.push(entry);
      list.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
      await this._write(list.slice(-MAX_ENTRIES));
      return entry;
    }).catch((err) => {
      console.error('[AgentLog] Could not record:', err.message);
      return null;
    });
  }

  list() { return this._serial(() => this._read()); }

  clear() { return this._serial(() => this._write([])).then(() => true); }

  /** Waits for writes in flight (quit, tests). */
  flush() { return this._chain; }
}

module.exports = { AgentLog, MAX_ENTRIES, MAX_COMMAND, FILE };
