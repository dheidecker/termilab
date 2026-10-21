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
 */
const os = require('os');
const storeService = require('../services/store-service');
const tailscale = require('./tailscale');

const NAME_MAX = 63;

class RemoteAccess {
  constructor() {
    this.handle = null;        // the running serve (tailscale.enable)
    this.error = null;
    this.retryTimer = null;
    this.attempt = 0;
    this.backoffMs = [1000, 2000, 5000, 10000, 30000, 60000];
    this.userData = null;
  }

  configure({ userData, backoffMs } = {}) {
    if (userData) this.userData = userData;
    if (Array.isArray(backoffMs) && backoffMs.length) this.backoffMs = backoffMs;
  }

  _userData() {
    if (this.userData) return this.userData;
    return require('electron').app.getPath('userData');
  }

  /* Linux: a unix socket in a 0700 dir (F1 listens on it). Elsewhere
     tailscale serve cannot proxy to a socket: loopback, port + 1. */
  _target(port) {
    if (process.platform === 'linux') {
      tailscale.ensureSocketDir(this._userData());
      return `unix:${tailscale.socketPath(this._userData())}`;
    }
    return `http://127.0.0.1:${port + 1}`;
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
    const handle = await tailscale.enable({ port, target: this._target(port) });
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
    try {
      await tailscale.disable({ port: ra.port, target: this._target(ra.port) });
    } catch (err) {
      // Not fatal: the foreground config died with the child anyway
      if (err.code === 'operator-required') this.error = this._errorOf(err);
    }
    return this.status();
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
    const ts = await tailscale.status();
    if (ts.reason) {
      this.error = { code: ts.reason, message: `Remote access was turned off: Tailscale is not ready (${ts.reason})` };
      await storeService.saveRemoteAccess({ enabled: false });
      return this.status();
    }
    try {
      await this._start(ra);
    } catch (err) {
      this.error = this._errorOf(err);
      await storeService.saveRemoteAccess({ enabled: false });
    }
    return this.status();
  }
}

module.exports = new RemoteAccess();
module.exports.RemoteAccess = RemoteAccess;
