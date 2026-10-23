/*
 * Settings → Remote access: settings.remoteAccess {enabled, port, hostName}
 * plus the live `tailscale serve` child (electron/web/tailscale.js).
 *
 * State for the renderer (web:status / enable / disable / set-name):
 *   { tailscale: {installed, running, login, dnsName, httpsEnabled, tagged, reason},
 *     remoteAccess: {enabled, port, hostName},
 *     serving,            // the serve child is up right now
 *     url,                // https://<dnsName>:<port>/ while enabled, else null
 *     error: null | {code, message, command?} }   // last failure, kept visible
 *
 * Expected failures (Tailscale not ready, Funnel on, port busy,
 * operator-required) come back in `error`, not as a rejection: wrapHandler
 * only carries a message across IPC and the UI needs the code.
 *
 * The serve child dying unexpectedly is retried with backoff while enabled;
 * every failed attempt shows in `error`. On boot (resume()) a stored
 * enabled:true is revalidated: Tailscale no longer ready → enabled:false and
 * nothing is started.
 *
 * Linux only, for now. There the server listens on a unix socket 0600 in a
 * 0700 directory, so only this uid can reach it besides tailscaled. On macOS
 * and Windows `tailscale serve` can only proxy to loopback TCP, where any
 * local process could forge the Tailscale headers (see server.js): status()
 * reports tailscale.reason 'unsupported-platform', enable() refuses, resume()
 * switches a stored enabled:true off, and the server is never started.
 *
 * The web server itself (electron/web/server.js, behind main.js
 * syncWebServer) follows the same switch: `configure({syncServer})` hands it
 * in, and enable / disable / resume call it with this PC's identity — the
 * owner's Tailscale login, the tailnet DNS name and the serve port, kept
 * here and read synchronously by auth.js on every request.
 */
const os = require('os');
const storeService = require('../services/store-service');
const tailscale = require('./tailscale');

const NAME_MAX = 63;

/** Remote access runs only where the server can sit behind a unix socket. */
const supported = () => process.platform === 'linux';
const UNSUPPORTED = Object.freeze({
  code: 'unsupported-platform',
  message: 'Remote access is available on Linux for now',
});

class RemoteAccess {
  constructor() {
    this.handle = null;        // the running serve (tailscale.enable)
    this.error = null;
    this.retryTimer = null;
    this.attempt = 0;
    this.backoffMs = [1000, 2000, 5000, 10000, 30000, 60000];
    this.userData = null;
    /* (identity | null) => Promise: main.js syncWebServer */
    this.syncServer = null;
    this.identity = { login: null, dnsName: null, port: null, name: null };
  }

  configure({ userData, backoffMs, syncServer } = {}) {
    if (userData) this.userData = userData;
    if (Array.isArray(backoffMs) && backoffMs.length) this.backoffMs = backoffMs;
    if (typeof syncServer === 'function') this.syncServer = syncServer;
  }

  /* What auth.js checks every request against; getters, so a later change
     (another login, a renamed tailnet) applies without a restart */
  _serverIdentity(ra) {
    const id = this.identity;
    return {
      getAllowedLogin: () => id.login,
      getDnsName: () => id.dnsName,
      getPort: () => id.port,
      name: ra.hostName,
    };
  }

  /* Web server on/off per settings (syncWebServer reads `enabled` itself).
     A failure is shown like any other remote-access error. */
  async _syncServer(ts) {
    if (!this.syncServer) return;
    let ra;
    try { ra = await this._settings(); } catch (_) { return; }
    if (ts) Object.assign(this.identity, { login: ts.login || null, dnsName: ts.dnsName || null });
    Object.assign(this.identity, { port: ra.port, name: ra.hostName });
    const ready = supported() && ra.enabled && this.identity.login && this.identity.dnsName;
    try {
      await this.syncServer(ready ? this._serverIdentity(ra) : null);
    } catch (err) {
      this.error = { code: 'server-failed', message: `The web server did not start: ${(err && err.message) || err}` };
    }
  }

  _userData() {
    if (this.userData) return this.userData;
    return require('electron').app.getPath('userData');
  }

  /* A unix socket in a 0700 dir (server.js listens on it). Linux only: see the header. */
  _target() {
    if (!supported()) throw new tailscale.TailscaleError(UNSUPPORTED.code, UNSUPPORTED.message);
    tailscale.ensureSocketDir(this._userData());
    return `unix:${tailscale.socketPath(this._userData())}`;
  }

  async _settings() {
    const s = await storeService.getSettings();
    const ra = s.remoteAccess || {};
    return {
      enabled: !!ra.enabled,
      port: Number.isInteger(ra.port) ? ra.port : tailscale.DEFAULT_PORT,
      hostName: (typeof ra.hostName === 'string' && ra.hostName.trim()) || os.hostname(),
    };
  }

  _errorOf(err) {
    if (err instanceof tailscale.TailscaleError || (err && typeof err.code === 'string')) {
      const e = { code: err.code, message: err.message };
      if (err.command) e.command = err.command;
      return e;
    }
    return { code: 'error', message: (err && err.message) || String(err) };
  }

  async status() {
    if (!supported()) {
      const ra = await this._settings();
      return {
        tailscale: { installed: null, running: false, login: null, dnsName: null, httpsEnabled: false, tagged: false, reason: UNSUPPORTED.code },
        remoteAccess: { ...ra, enabled: false },
        serving: false,
        url: null,
        error: null,
      };
    }
    const [ts, ra] = await Promise.all([tailscale.status(), this._settings()]);
    return {
      tailscale: ts,
      remoteAccess: ra,
      serving: !!this.handle,
      url: ra.enabled && ts.dnsName ? `https://${ts.dnsName}:${ra.port}/` : null,
      error: this.error,
    };
  }

  async _start(ra) {
    const port = ra.port;
    const handle = await tailscale.enable({ port, target: this._target() });
    this.handle = handle;
    this.error = null;
    this.attempt = 0;
    handle.onExit((info) => {
      if (this.handle !== handle) return;   // stopped on purpose
      this.handle = null;
      const out = String((info && info.output) || '').trim();
      this.error = tailscale.isAccessDenied(out)
        ? this._errorOf(new tailscale.TailscaleError('operator-required',
          `Tailscale does not let this user change serve settings. Run once: ${tailscale.OPERATOR_COMMAND}`,
          { command: tailscale.OPERATOR_COMMAND }))
        : { code: 'serve-exited', message: out || 'tailscale serve stopped unexpectedly' };
      this._scheduleRetry();
    });
  }

  _scheduleRetry() {
    clearTimeout(this.retryTimer);
    const delay = this.backoffMs[Math.min(this.attempt, this.backoffMs.length - 1)];
    this.attempt++;
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null;
      let ra;
      try { ra = await this._settings(); } catch (_) { return; }
      if (!ra.enabled || this.handle) return;
      try {
        await this._start(ra);
      } catch (err) {
        this.error = this._errorOf(err);
        this._scheduleRetry();
      }
    }, delay);
    if (this.retryTimer.unref) this.retryTimer.unref();
  }

  async enable() {
    /* Not just the UI: main refuses too, and nothing is stored */
    if (!supported()) {
      this.error = { ...UNSUPPORTED };
      const st = await this.status();
      return { ...st, error: this.error };
    }
    const ra = await this._settings();
    if (!this.handle) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
      try {
        await this._start(ra);
      } catch (err) {
        this.error = this._errorOf(err);
        return this.status();
      }
    }
    await storeService.saveRemoteAccess({ enabled: true });
    await this._syncServer(await tailscale.status());
    return this.status();
  }

  /** Kill the serve child, then `serve --https=<port> off` as cleanup. Never reset. */
  async stop() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const handle = this.handle;
    this.handle = null;
    if (handle) await handle.stop();
    return handle;
  }

  async disable() {
    const ra = await this._settings();
    await this.stop();
    this.error = null;
    await storeService.saveRemoteAccess({ enabled: false });
    await this._syncServer(null);
    if (!supported()) return this.status();
    try {
      await tailscale.disable({ port: ra.port, target: this._target() });
    } catch (err) {
      // Not fatal: the foreground config died with the child anyway
      if (err.code === 'operator-required') this.error = this._errorOf(err);
    }
    return this.status();
  }

  /** Linux: make this user Tailscale's operator (password dialog), then retry. */
  async grantOperator() {
    if (!supported()) return this.enable();
    try {
      await tailscale.grantOperator();
    } catch (err) {
      this.error = this._errorOf(err);
      return this.status();
    }
    this.error = null;
    return this.enable();
  }

  async setName(name) {
    const clean = String(name == null ? '' : name).replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!clean) throw new Error('The name cannot be empty');
    if (clean.length > NAME_MAX) throw new Error(`The name can be at most ${NAME_MAX} characters`);
    await storeService.saveRemoteAccess({ hostName: clean });
    return this.status();
  }

  /** Boot: revalidate a stored enabled:true and serve again, or switch it off. */
  async resume() {
    const ra = await this._settings();
    if (!ra.enabled) return null;
    if (!supported()) {
      await storeService.saveRemoteAccess({ enabled: false });
      return this.status();
    }
    const ts = await tailscale.status();
    if (ts.reason) {
      this.error = { code: ts.reason, message: `Remote access was turned off: Tailscale is not ready (${ts.reason})` };
      await storeService.saveRemoteAccess({ enabled: false });
      return this.status();
    }
    try {
      await this._start(ra);
      await this._syncServer(ts);
    } catch (err) {
      this.error = this._errorOf(err);
      await storeService.saveRemoteAccess({ enabled: false });
    }
    return this.status();
  }
}

module.exports = new RemoteAccess();
module.exports.RemoteAccess = RemoteAccess;
module.exports.UNSUPPORTED = UNSUPPORTED;
