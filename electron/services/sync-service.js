const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { app, shell } = require('electron');

const storeService = require('./store-service');
const cryptoService = require('./crypto-service');
const pairingCrypto = require('./pairing-crypto');

/**
 * The sync engine. Talks to the sync API on the user's own server, applies the
 * delta it gets back to the JSON store, and pushes local changes up.
 *
 * Shape of the thing:
 * - Auth is device-code style: POST /auth/start, open a browser, poll
 *   /auth/poll until the server hands over a device token. The app never sees
 *   a Google token.
 * - Pull is delta-based on a server cursor and deletes are TOMBSTONES: a record
 *   with `deleted: true` must remove the local object, or objects the user
 *   deleted on another device come back from the dead.
 * - `keys` is end-to-end encrypted at ROW level (enc: true). Everything else
 *   travels as plaintext JSON on purpose, EXCEPT the fields listed in
 *   SECRET_FIELDS (host passwords and passphrases), which are sealed one by one
 *   inside their own payload. Without a master key we refuse to upload `keys`
 *   at all and we strip those fields, and say so in the status, rather than
 *   leaking a single secret to the server.
 *
 * Change detection is a shadow copy: a hash per item as of the last successful
 * sync, kept in sync-state.json. An item whose hash moved is dirty; an item in
 * the shadow that is no longer on disk was deleted locally and becomes a
 * tombstone.
 */

const DEFAULT_SYNC_URL = 'https://termilab.rhinlab.com';
const STATE_FILE = 'sync-state.json';
const POLL_INTERVAL_MS = 2000;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const PAIR_POLL_INTERVAL_MS = 2000;
const PAIR_TIMEOUT_MS = 10 * 60 * 1000;
const AUTO_SYNC_INTERVAL_MS = 10 * 60 * 1000;
const AUTO_SYNC_DELAY_MS = 8000;
const PUSH_BATCH = 200;
const HTTP_TIMEOUT_MS = 30000;

// server collection name -> local store file name
const COLLECTIONS = {
  hosts: 'hosts',
  groups: 'groups',
  snippets: 'snippets',
  port_forwards: 'port-forwards',
  keys: 'keys',
};
const ENCRYPTED_COLLECTIONS = new Set(['keys']);

/**
 * ####################################################################
 * #  SECRETOS POR CAMPO — AMPLIA ESTA TABLA                          #
 * ####################################################################
 *
 * Campos que NO pueden salir de esta maquina en claro, por coleccion. El resto
 * del objeto viaja como JSON legible a proposito: un equipo recien logueado y
 * todavia sin clave maestra tiene que poder VER la lista de servidores
 * (etiqueta, host, usuario, grupo, tags) aunque no pueda conectarse a ellos.
 *
 * **Si añades un campo sensible al formulario de host (o a cualquier otra
 * coleccion), su nombre va aqui en el mismo commit.** Lo que no este en esta
 * tabla se sube en claro al servidor.
 *
 * Cada campo listado se sustituye, dentro del propio payload, por un sobre
 * { enc, ciphertext, nonce } (AES-256-GCM, nonce nuevo por campo). El registro
 * sigue siendo `enc: false` a nivel de fila con `ciphertext`/`nonce` nulos: el
 * servidor rechaza payload y ciphertext a la vez, por eso el sobre va DENTRO
 * del JSON y no hace falta migrar el esquema.
 */
const SECRET_FIELDS = {
  hosts: ['password', 'passphrase'],
};

/** Marca del sobre por campo. Versionada: si cambia el formato, cambia esto. */
const SECRET_ENVELOPE_MARK = 'aes-256-gcm/v1';

/**
 * Version del cifrado por campo grabada en sync-state.json. Si sube, la sombra
 * de las colecciones con secretos se marca entera como pendiente y todo se
 * vuelve a subir sellado. La 0 es la epoca en la que las contrasenas de host
 * viajaban en claro: en esas instalaciones el hash local no se ha movido, asi
 * que sin esto la fila en claro del servidor no se reemplazaria nunca.
 */
const SECRETS_VERSION = 1;

const SETTINGS_ITEM_ID = 'settings';

function secretFieldsOf(collection) {
  return SECRET_FIELDS[collection] || [];
}

function isSecretEnvelope(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && value.enc === SECRET_ENVELOPE_MARK
    && typeof value.ciphertext === 'string' && typeof value.nonce === 'string';
}

/** Solo se cifra lo que hay: un campo ausente o vacio no gana un sobre. */
function isSealable(value) {
  return typeof value === 'string' && value.length > 0;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function hashItem(item) {
  return crypto.createHash('sha256').update(stableStringify(item)).digest('hex').slice(0, 32);
}

function isNewer(a, b) {
  // ISO-8601 strings compare correctly lexicographically only if both are ISO;
  // fall back to Date so a legacy value cannot silently win.
  const ta = Date.parse(a || '');
  const tb = Date.parse(b || '');
  if (Number.isNaN(ta)) return false;
  if (Number.isNaN(tb)) return true;
  return ta > tb;
}

class SyncService {
  constructor() {
    this.mainWindow = null;
    this.state = {
      cursor: 0,
      lastSyncAt: null,
      email: null,
      deviceName: null,
      secretsVersion: SECRETS_VERSION,
      shadow: {},
    };
    this._loaded = false;
    this._syncing = false;
    this._error = null;
    this._pendingPairings = 0;
    this._secretsWithheld = 0;
    this._secretsBlocked = 0;
    this._loginPromise = null;
    this._loginAborted = false;
    this._autoTimer = null;
    this._initialTimer = null;
    // pairing_id -> { kp, digits, peerPub, ciphertext, nonce, state, timer }
    this._saveSeq = 0;
    this._claims = new Map();   // this device asked to join
    this._approvals = new Map(); // this device can approve someone else
  }

  setMainWindow(win) {
    this.mainWindow = win;
  }

  // ─── State file ─────────────────────────────────────────

  _statePath() {
    return path.join(app.getPath('userData'), 'data', STATE_FILE);
  }

  async _load() {
    if (this._loaded) return this.state;
    try {
      const raw = JSON.parse(await fsp.readFile(this._statePath(), 'utf-8'));
      this.state = {
        cursor: Number(raw.cursor) || 0,
        lastSyncAt: raw.lastSyncAt || null,
        email: raw.email || null,
        deviceName: raw.deviceName || null,
        secretsVersion: Number(raw.secretsVersion) || 0,
        shadow: raw.shadow && typeof raw.shadow === 'object' ? raw.shadow : {},
      };
      this._migrateSecrets();
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('[SyncService] sync-state.json ilegible, se empieza de cero:', err.message);
      }
    }
    this._loaded = true;
    return this.state;
  }

  /**
   * Marca como pendientes los secretos de una sombra escrita por una version
   * anterior. No borra la sombra: perder sus entradas resucitaria los objetos
   * que el usuario borro aqui y aun no se han subido como lapida.
   */
  _migrateSecrets() {
    if (this.state.secretsVersion >= SECRETS_VERSION) return;
    for (const collection of Object.keys(SECRET_FIELDS)) {
      const shadow = this.state.shadow[collection];
      if (!shadow) continue;
      for (const entry of Object.values(shadow)) {
        if (entry && typeof entry === 'object') entry.secretsPending = true;
      }
    }
    this.state.secretsVersion = SECRETS_VERSION;
  }

  async _save() {
    const file = this._statePath();
    await fsp.mkdir(path.dirname(file), { recursive: true });
    // Unique temp name: two _save() calls can overlap (a running sync and a
    // finishing pairing, say) and a shared `.tmp` makes the second rename fail
    // with ENOENT because the first already moved it.
    const tmp = `${file}.${process.pid}.${++this._saveSeq}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf-8');
      await fsp.rename(tmp, file);
    } catch (err) {
      try { await fsp.unlink(tmp); } catch (_) { /* ignore */ }
      throw err;
    }
  }

  // ─── HTTP ───────────────────────────────────────────────

  /** Override with TERMILAB_SYNC_URL to point at a local server while testing. */
  _baseUrl() {
    return (process.env.TERMILAB_SYNC_URL || DEFAULT_SYNC_URL).replace(/\/+$/, '');
  }

  async _request(method, endpoint, { body, auth = true, timeout = HTTP_TIMEOUT_MS } = {}) {
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth) {
      const token = await cryptoService.getToken();
      if (!token) throw new Error('No has iniciado sesion en la sincronizacion');
      headers.authorization = `Bearer ${token}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let res;
    try {
      res = await fetch(`${this._baseUrl()}${endpoint}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('El servidor de sincronizacion no responde');
      throw new Error(`No se pudo contactar con el servidor de sincronizacion: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
    }

    if (auth && res.status === 401) {
      // Token revoked from another device, or expired. Stop pretending.
      await this._handleUnauthorized();
      throw new Error('La sesion de este dispositivo ya no es valida, vuelve a iniciar sesion');
    }
    return { status: res.status, ok: res.ok, data };
  }

  _httpError(result, fallback) {
    const msg = result && result.data && (result.data.error || result.data.message);
    return new Error(msg || `${fallback} (HTTP ${result ? result.status : '?'})`);
  }

  async _handleUnauthorized() {
    try { await cryptoService.clearToken(); } catch (_) { /* ignore */ }
    await this._load();
    this.state.email = null;
    this.state.cursor = 0;
    this.state.shadow = {};
    try { await this._save(); } catch (_) { /* ignore */ }
    this._error = 'Sesion caducada o dispositivo revocado';
    this._emitStatus();
  }

  // ─── Status ─────────────────────────────────────────────

  async status() {
    await this._load();
    const token = await cryptoService.getToken().catch(() => null);
    const hasMasterKey = await cryptoService.hasMasterKey().catch(() => false);
    const pairing = this._currentClaimSummary();
    return {
      signedIn: !!token,
      email: this.state.email,
      deviceName: this.state.deviceName || os.hostname(),
      lastSyncAt: this.state.lastSyncAt,
      cursor: this.state.cursor,
      hasMasterKey,
      pendingPairings: this._pendingPairings,
      syncing: this._syncing,
      error: this._error,
      // Secretos por campo del ultimo sync: cuantos no se subieron por falta de
      // clave maestra, y cuantos bajaron cifrados y no se pudieron abrir.
      secretsWithheld: this._secretsWithheld,
      secretsBlocked: this._secretsBlocked,
      // Extra, not in the base contract: the pairing this device started, so the
      // UI can show the six digits as soon as the other side answers.
      pairing,
    };
  }

  _currentClaimSummary() {
    for (const [id, claim] of this._claims) {
      if (claim.state === 'done' || claim.state === 'expired') continue;
      return { id, digits: claim.digits, state: claim.state };
    }
    return null;
  }

  _emitStatus() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.status()
      .then(s => {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('sync:status', s);
        }
      })
      .catch(() => { /* status must never throw at a listener */ });
  }

  // ─── Auth ───────────────────────────────────────────────

  async login() {
    if (this._loginPromise) return this._loginPromise;
    this._loginAborted = false;
    this._loginPromise = this._doLogin().finally(() => { this._loginPromise = null; });
    return this._loginPromise;
  }

  async _doLogin() {
    await this._load();
    // Fail early and clearly if there is no keychain: a token we cannot store
    // would make login look like it worked and break on the next launch.
    if (!cryptoService.isEncryptionAvailable()) {
      this._error = 'El almacen de claves del sistema no esta disponible';
      this._emitStatus();
      throw new Error(
        'No se puede guardar el token de forma segura: el almacen de claves del ' +
        'sistema no esta disponible. En Linux hace falta gnome-keyring o kwallet.'
      );
    }

    const deviceName = os.hostname();
    const start = await this._request('POST', '/auth/start', {
      auth: false,
      body: { device_name: deviceName, platform: process.platform },
    });
    if (!start.ok || !start.data || !start.data.code) {
      throw this._httpError(start, 'No se pudo iniciar la autenticacion');
    }

    const { code, authorize_url: authorizeUrl } = start.data;
    if (authorizeUrl) {
      try {
        await shell.openExternal(authorizeUrl);
      } catch (err) {
        console.error('[SyncService] No se pudo abrir el navegador:', err.message);
      }
    }

    this._error = null;
    this._emitStatus();

    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this._loginAborted) throw new Error('Inicio de sesion cancelado');
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      if (this._loginAborted) throw new Error('Inicio de sesion cancelado');

      const poll = await this._request('GET', `/auth/poll?code=${encodeURIComponent(code)}`, { auth: false });
      if (poll.status === 202) continue;
      if (poll.status === 200 && poll.data && poll.data.status === 'listo') {
        await cryptoService.setToken(poll.data.token);
        this.state.email = poll.data.email || null;
        this.state.deviceName = deviceName;
        await this._save();
        // A device with no master key yet generates one now, so a single-device
        // user just works. Pairing later replaces it.
        try {
          await cryptoService.ensureMasterKey();
        } catch (err) {
          console.error('[SyncService] No se pudo crear la clave maestra:', err.message);
        }
        this._error = null;
        this._emitStatus();
        this.syncNow().catch(err => console.error('[SyncService] Sync inicial fallido:', err.message));
        return { ok: true, email: this.state.email };
      }
      // 400 / 404 / 410: the code is dead, no point in polling on.
      throw this._httpError(poll, 'La autenticacion no se completo');
    }
    throw new Error('Se agoto el tiempo para autorizar el dispositivo (10 minutos)');
  }

  async logout() {
    this._loginAborted = true;
    // Wait out any sync in flight, or its final _save() lands after we cleared
    // the state and resurrects the cursor of a session that no longer exists.
    if (this._chain) { try { await this._chain; } catch (_) { /* ignore */ } }
    await this._load();
    try { await cryptoService.clearToken(); } catch (err) {
      console.error('[SyncService] No se pudo borrar el token:', err.message);
    }
    // The master key survives a logout on purpose: it is the user's key, not the
    // session's, and losing it would make the encrypted `keys` unreadable.
    this.state.email = null;
    this.state.cursor = 0;
    this.state.shadow = {};
    this.state.lastSyncAt = null;
    await this._save();
    this._pendingPairings = 0;
    this._secretsWithheld = 0;
    this._secretsBlocked = 0;
    this._error = null;
    for (const claim of this._claims.values()) {
      if (claim.timer) clearTimeout(claim.timer);
    }
    this._claims.clear();
    this._approvals.clear();
    this._emitStatus();
  }

  async isSignedIn() {
    const token = await cryptoService.getToken().catch(() => null);
    return !!token;
  }

  // ─── Local <-> record translation ───────────────────────

  async _readLocal(serverCollection) {
    if (serverCollection === 'settings') {
      const settings = await storeService.getSettings();
      return [{ id: SETTINGS_ITEM_ID, ...settings }];
    }
    const items = await storeService.readRaw(COLLECTIONS[serverCollection]);
    return Array.isArray(items) ? items : [];
  }

  async _writeLocal(serverCollection, items) {
    if (serverCollection === 'settings') {
      const settings = items.find(i => i.id === SETTINGS_ITEM_ID);
      if (settings) {
        const { id, ...rest } = settings;
        await storeService.saveSettings(rest);
      }
      return;
    }
    await storeService.writeRaw(COLLECTIONS[serverCollection], items);
  }

  /**
   * @returns {Promise<{record: object, withheld: number}>} `withheld` cuenta los
   * campos secretos que se han dejado FUERA del registro por no haber clave
   * maestra. Nunca salen en claro: o van en un sobre, o no van.
   */
  async _buildRecord(serverCollection, item, updatedAt) {
    const base = {
      collection: serverCollection,
      item_id: item.id,
      deleted: false,
      updated_at: updatedAt,
    };
    if (ENCRYPTED_COLLECTIONS.has(serverCollection)) {
      const { ciphertext, nonce } = await cryptoService.encryptRecord(item);
      return { record: { ...base, enc: true, payload: null, ciphertext, nonce }, withheld: 0 };
    }
    const { payload, withheld } = await this._sealSecretFields(serverCollection, item);
    return {
      record: { ...base, enc: false, payload, ciphertext: null, nonce: null },
      withheld,
    };
  }

  /**
   * Sustituye cada campo secreto por su sobre cifrado. Sin clave maestra el
   * campo se OMITE del payload: subirlo en claro no es una opcion, y fallar
   * entero dejaria de sincronizar el resto del host (que si es publico).
   */
  async _sealSecretFields(serverCollection, item) {
    const fields = secretFieldsOf(serverCollection);
    if (!fields.length) return { payload: item, withheld: 0 };

    const hasKey = await cryptoService.hasMasterKey();
    let payload = item;
    let withheld = 0;
    const mutable = () => {
      if (payload === item) payload = { ...item };
      return payload;
    };

    for (const field of fields) {
      const value = item[field];
      if (isSecretEnvelope(value)) continue; // ya sellado (no deberia pasar en local)
      if (!isSealable(value)) continue;      // ausente, vacio o no-texto: nada que ocultar
      if (!hasKey) {
        delete mutable()[field];
        withheld++;
        continue;
      }
      const { ciphertext, nonce } = await cryptoService.encryptRecord(value);
      mutable()[field] = { enc: SECRET_ENVELOPE_MARK, ciphertext, nonce };
    }

    // Ultimo cortafuegos antes del cable: si algun camino futuro se salta lo de
    // arriba, la sincronizacion revienta en vez de filtrar la contrasena.
    this._assertNoPlaintextSecrets(serverCollection, payload);
    return { payload, withheld };
  }

  _assertNoPlaintextSecrets(serverCollection, payload) {
    for (const field of secretFieldsOf(serverCollection)) {
      const value = payload ? payload[field] : undefined;
      if (isSealable(value)) {
        throw new Error(
          `Se ha intentado subir ${serverCollection}.${field} en claro; sincronizacion abortada`
        );
      }
    }
  }

  /**
   * El camino inverso. `local` es el objeto que ya teniamos en disco, si habia:
   * un equipo sin emparejar recibe el host sin sus secretos y NO debe machacar
   * la contrasena que el usuario tenga guardada aqui.
   *
   * @returns {Promise<{item: object, blocked: number, kept: number}>}
   *   `blocked` = sobres que no se pudieron abrir; `kept` = secretos locales
   *   conservados porque el servidor no los trae (el servidor va por detras).
   */
  async _openSecretFields(serverCollection, incoming, local) {
    const fields = secretFieldsOf(serverCollection);
    if (!fields.length) return { item: incoming, blocked: 0, kept: 0 };

    const hasKey = await cryptoService.hasMasterKey();
    const item = { ...incoming };
    let blocked = 0;
    let kept = 0;

    for (const field of fields) {
      const value = item[field];
      if (isSecretEnvelope(value)) {
        if (hasKey) {
          try {
            item[field] = await cryptoService.decryptRecord(value.ciphertext, value.nonce);
            continue;
          } catch (err) {
            console.error(
              `[SyncService] No se pudo descifrar ${serverCollection}.${field} de ${incoming.id}:`,
              err.message
            );
          }
        }
        delete item[field];
        blocked++;
      }
      // Campo en claro que venga del servidor (cliente antiguo, o fila anterior
      // a este cifrado) se acepta tal cual: ya estaba filtrado, y borrarlo solo
      // rompe la conexion del usuario.
      if (item[field] === undefined && local && isSealable(local[field])) {
        item[field] = local[field];
        kept++;
      }
    }
    return { item, blocked, kept };
  }

  _buildTombstone(serverCollection, itemId, updatedAt) {
    // Neither payload nor ciphertext: there is nothing left to carry, and a
    // deleted `keys` row must not need the master key to be expressible.
    return {
      collection: serverCollection,
      item_id: itemId,
      enc: false,
      payload: null,
      ciphertext: null,
      nonce: null,
      deleted: true,
      updated_at: updatedAt,
    };
  }

  async _decodeRecord(record) {
    if (record.enc) {
      const hasKey = await cryptoService.hasMasterKey();
      if (!hasKey) return { blocked: true, item: null };
      try {
        const item = await cryptoService.decryptJson(record.ciphertext, record.nonce);
        return { blocked: false, item };
      } catch (err) {
        // Wrong master key (paired with a different one, most likely). Do not
        // touch the local copy; say it loudly instead.
        console.error(`[SyncService] No se pudo descifrar ${record.collection}/${record.item_id}:`, err.message);
        return { blocked: true, item: null, undecryptable: true };
      }
    }
    return { blocked: false, item: record.payload };
  }

  // ─── Pull ───────────────────────────────────────────────

  async _pull() {
    let applied = 0;
    let blockedKeys = 0;
    let blockedSecrets = 0;
    let guard = 0;
    for (;;) {
      const res = await this._request('GET', `/v1/sync?since=${encodeURIComponent(this.state.cursor || 0)}`);
      if (!res.ok) throw this._httpError(res, 'No se pudieron bajar los cambios');
      const records = (res.data && res.data.records) || [];
      if (records.length) {
        const outcome = await this._applyRecords(records);
        applied += outcome.applied;
        blockedKeys += outcome.blocked;
        blockedSecrets += outcome.blockedSecrets;
      }
      if (res.data && res.data.cursor !== undefined && res.data.cursor !== null) {
        this.state.cursor = res.data.cursor;
      }
      await this._save();
      if (!res.data || !res.data.has_more) break;
      if (++guard > 500) throw new Error('Demasiadas paginas al bajar cambios, se corta el bucle');
    }
    return { applied, blockedKeys, blockedSecrets };
  }

  async _applyRecords(records) {
    const byCollection = new Map();
    for (const record of records) {
      if (!record || !COLLECTIONS[record.collection] && record.collection !== 'settings') {
        continue; // unknown collection from a newer server: ignore, do not crash
      }
      if (!byCollection.has(record.collection)) byCollection.set(record.collection, []);
      byCollection.get(record.collection).push(record);
    }

    let applied = 0;
    let blocked = 0;
    let blockedSecrets = 0;

    for (const [collection, collectionRecords] of byCollection) {
      const items = await this._readLocal(collection);
      const shadow = this.state.shadow[collection] || (this.state.shadow[collection] = {});
      let dirty = false;

      for (const record of collectionRecords) {
        const itemId = record.item_id;
        const index = items.findIndex(i => i && i.id === itemId);

        if (record.deleted) {
          // Tombstone. Honour it or objects deleted elsewhere come back.
          if (collection === 'settings') continue;
          if (index !== -1) {
            items.splice(index, 1);
            dirty = true;
            applied++;
          }
          delete shadow[itemId];
          continue;
        }

        const decoded = await this._decodeRecord(record);
        if (decoded.blocked) {
          blocked++;
          continue;
        }
        if (!decoded.item || typeof decoded.item !== 'object') continue;

        const local = index !== -1 ? items[index] : null;
        if (local) {
          const shadowEntry = shadow[itemId];
          const locallyDirty = !shadowEntry || shadowEntry.hash !== hashItem(local);
          if (locallyDirty && isNewer(local.updatedAt, record.updated_at)) {
            // Local edit is newer than what the server has: keep it, the push
            // phase will send it up.
            continue;
          }
        }

        // Los campos secretos se abren aqui, y lo que el servidor no traiga se
        // rellena con lo que ya teniamos: sin clave maestra el host baja sin
        // contrasena y no debe borrar la que este equipo tiene guardada.
        const opened = await this._openSecretFields(
          collection,
          { ...decoded.item, id: itemId },
          local
        );
        const incoming = opened.item;
        blockedSecrets += opened.blocked;

        if (index !== -1) items[index] = incoming;
        else items.push(incoming);
        dirty = true;
        applied++;
        shadow[itemId] = { hash: hashItem(incoming), updated_at: record.updated_at };
        // Guardamos un secreto que el servidor no tiene: la fila remota esta
        // incompleta y hay que volver a subirla en cuanto haya clave maestra,
        // aunque el hash local no se mueva.
        if (opened.kept) shadow[itemId].secretsPending = true;
      }

      if (dirty) await this._writeLocal(collection, items);
    }
    return { applied, blocked, blockedSecrets };
  }

  // ─── Push ───────────────────────────────────────────────

  async _push() {
    const hasMasterKey = await cryptoService.hasMasterKey();
    const now = new Date().toISOString();
    const records = [];
    const commit = []; // applied to the shadow only once the server accepts
    let withheldSecrets = 0; // campos secretos omitidos por no haber clave maestra

    for (const collection of [...Object.keys(COLLECTIONS), 'settings']) {
      if (ENCRYPTED_COLLECTIONS.has(collection) && !hasMasterKey) {
        // Never upload private keys in the clear. Skipping is the safe failure.
        continue;
      }
      const items = await this._readLocal(collection);
      const shadow = this.state.shadow[collection] || (this.state.shadow[collection] = {});
      const seen = new Set();

      for (const item of items) {
        if (!item || !item.id) continue;
        seen.add(item.id);
        const hash = hashItem(item);
        const previous = shadow[item.id];
        // `secretsPending` = la fila del servidor va sin secretos porque
        // entonces no habia clave maestra. El hash local no se mueve, asi que
        // sin esta condicion la contrasena no subiria NUNCA tras emparejar.
        const resend = !!(previous && previous.secretsPending && hasMasterKey);
        if (previous && previous.hash === hash && !resend) continue;
        const updatedAt = item.updatedAt || item.updated_at || now;
        const built = await this._buildRecord(collection, item, updatedAt);
        withheldSecrets += built.withheld;
        records.push(built.record);
        commit.push({
          collection,
          itemId: item.id,
          hash,
          updatedAt,
          secretsPending: built.withheld > 0,
        });
      }

      for (const itemId of Object.keys(shadow)) {
        if (seen.has(itemId)) continue;
        if (collection === 'settings') continue;
        records.push(this._buildTombstone(collection, itemId, now));
        commit.push({ collection, itemId, deleted: true });
      }
    }

    if (!records.length) return { pushed: 0, withheldSecrets };

    let pushed = 0;
    for (let offset = 0; offset < records.length; offset += PUSH_BATCH) {
      const batch = records.slice(offset, offset + PUSH_BATCH);
      const res = await this._request('POST', '/v1/sync', { body: { records: batch } });
      if (!res.ok) throw this._httpError(res, 'No se pudieron subir los cambios');
      pushed += (res.data && typeof res.data.applied === 'number') ? res.data.applied : batch.length;
      if (res.data && res.data.cursor !== undefined && res.data.cursor !== null) {
        this.state.cursor = res.data.cursor;
      }
      for (const entry of commit.slice(offset, offset + PUSH_BATCH)) {
        const shadow = this.state.shadow[entry.collection] || (this.state.shadow[entry.collection] = {});
        if (entry.deleted) {
          delete shadow[entry.itemId];
        } else {
          shadow[entry.itemId] = { hash: entry.hash, updated_at: entry.updatedAt };
          if (entry.secretsPending) shadow[entry.itemId].secretsPending = true;
        }
      }
      await this._save();
    }
    return { pushed, withheldSecrets };
  }

  // ─── The loop ───────────────────────────────────────────

  /**
   * Serialised: a second call while one is running queues behind it instead of
   * failing. Login kicks off a sync in the background, and the user pressing
   * "sync now" right after must not get "already syncing" thrown at them — nor
   * two loops writing the same collection file at once.
   */
  async syncNow() {
    const run = () => this._runSync();
    this._chain = (this._chain || Promise.resolve()).then(run, run);
    return this._chain;
  }

  async _runSync() {
    await this._load();
    if (!(await this.isSignedIn())) throw new Error('No has iniciado sesion en la sincronizacion');

    this._syncing = true;
    this._error = null;
    this._emitStatus();
    try {
      const pull = await this._pull();
      const push = await this._push();
      // Whatever the push created is already ours; pull again so the cursor
      // covers it and any record another device wrote meanwhile.
      const secondPull = push.pushed
        ? await this._pull()
        : { applied: 0, blockedKeys: 0, blockedSecrets: 0 };

      this.state.lastSyncAt = new Date().toISOString();
      await this._save();

      const hasMasterKey = await cryptoService.hasMasterKey();
      this._secretsWithheld = push.withheldSecrets || 0;
      this._secretsBlocked = (pull.blockedSecrets || 0) + (secondPull.blockedSecrets || 0);
      if (!hasMasterKey) {
        this._error = this._secretsWithheld
          ? 'Sin clave maestra: ni las claves SSH ni las contrasenas de los hosts salen de este equipo. Empareja este dispositivo.'
          : 'Sin clave maestra: las claves SSH no se sincronizan. Empareja este dispositivo.';
      } else if (pull.blockedKeys || secondPull.blockedKeys || this._secretsBlocked) {
        this._error = 'Hay datos cifrados que no se pudieron descifrar con la clave maestra de este dispositivo.';
      }

      this._refreshPendingPairings().catch(() => { /* best effort */ });
      return {
        pushed: push.pushed,
        pulled: pull.applied + secondPull.applied,
        cursor: this.state.cursor,
      };
    } catch (err) {
      this._error = err.message;
      throw err;
    } finally {
      this._syncing = false;
      this._emitStatus();
    }
  }

  /** Kicks off a first sync after boot and keeps a slow timer going. */
  start() {
    if (this._initialTimer || this._autoTimer) return;
    const run = () => {
      this.isSignedIn()
        .then(signedIn => (signedIn ? this.syncNow() : null))
        .catch(err => console.error('[SyncService] Sync automatico fallido:', err.message));
    };
    this._initialTimer = setTimeout(() => {
      this._initialTimer = null;
      run();
    }, AUTO_SYNC_DELAY_MS);
    if (this._initialTimer.unref) this._initialTimer.unref();
    this._autoTimer = setInterval(run, AUTO_SYNC_INTERVAL_MS);
    if (this._autoTimer.unref) this._autoTimer.unref();
  }

  stop() {
    if (this._initialTimer) clearTimeout(this._initialTimer);
    if (this._autoTimer) clearInterval(this._autoTimer);
    this._initialTimer = null;
    this._autoTimer = null;
    this._loginAborted = true;
    for (const claim of this._claims.values()) {
      if (claim.timer) clearTimeout(claim.timer);
    }
    this._claims.clear();
  }

  // ─── Devices ────────────────────────────────────────────

  async devices() {
    const res = await this._request('GET', '/v1/devices');
    if (!res.ok) throw this._httpError(res, 'No se pudo listar los dispositivos');
    return { devices: (res.data && res.data.devices) || [] };
  }

  async revokeDevice(id) {
    if (!id) throw new Error('Falta el id del dispositivo');
    const res = await this._request('DELETE', `/v1/devices/${encodeURIComponent(id)}`);
    if (!res.ok) throw this._httpError(res, 'No se pudo revocar el dispositivo');
    this._emitStatus();
  }

  // ─── Pairing ────────────────────────────────────────────

  /**
   * This device has no master key and asks to join. The six digits are unknown
   * until the other device answers with its public key, so they arrive later
   * through the `sync:status` event (field `pairing.digits`).
   */
  async pairingRequest() {
    const kp = pairingCrypto.generateEphemeralKeyPair();
    const res = await this._request('POST', '/v1/pair/request', { body: { pub: kp.pub } });
    if (!res.ok || !res.data || !res.data.pairing_id) {
      throw this._httpError(res, 'No se pudo pedir el emparejamiento');
    }
    const pairingId = res.data.pairing_id;
    const claim = { kp, digits: null, state: 'pendiente', peerPub: null, ciphertext: null, nonce: null, timer: null };
    this._claims.set(pairingId, claim);
    this._pollClaim(pairingId, Date.now() + PAIR_TIMEOUT_MS);
    this._emitStatus();
    return { pairingId, digits: null };
  }

  _pollClaim(pairingId, deadline) {
    const claim = this._claims.get(pairingId);
    if (!claim || claim.state !== 'pendiente') return;
    if (Date.now() > deadline) {
      claim.state = 'expired';
      this._emitStatus();
      return;
    }
    claim.timer = setTimeout(() => {
      this._fetchClaim(pairingId)
        .catch(err => console.error('[SyncService] Sondeo de emparejamiento fallido:', err.message))
        .finally(() => this._pollClaim(pairingId, deadline));
    }, PAIR_POLL_INTERVAL_MS);
    if (claim.timer.unref) claim.timer.unref();
  }

  async _fetchClaim(pairingId) {
    const claim = this._claims.get(pairingId);
    if (!claim || claim.state !== 'pendiente') return claim;
    const res = await this._request('GET', `/v1/pair/${encodeURIComponent(pairingId)}`);
    if (res.status === 202) return claim;
    if (res.status === 403) {
      claim.state = 'rejected';
      this._emitStatus();
      return claim;
    }
    if (res.status === 410) {
      claim.state = 'expired';
      this._emitStatus();
      return claim;
    }
    if (!res.ok || !res.data) throw this._httpError(res, 'No se pudo consultar el emparejamiento');

    const peerPub = res.data.pub_existing;
    if (!peerPub) return claim;
    claim.peerPub = peerPub;
    claim.ciphertext = res.data.ciphertext;
    claim.nonce = res.data.nonce;
    claim.digits = pairingCrypto.deriveDigits(claim.kp.pub, peerPub);
    claim.state = 'listo';
    this._emitStatus();
    return claim;
  }

  /**
   * The user compared the digits and they match: decrypt the master key and
   * install it. Waits a little if the other side has not answered yet.
   */
  async pairingClaim(pairingId) {
    let claim = this._claims.get(pairingId);
    if (!claim) throw new Error('Ese emparejamiento no lo pidio este dispositivo');

    const deadline = Date.now() + 30000;
    while (claim.state === 'pendiente' && Date.now() < deadline) {
      claim = await this._fetchClaim(pairingId);
      if (claim.state === 'pendiente') await new Promise(r => setTimeout(r, PAIR_POLL_INTERVAL_MS));
    }
    if (claim.state === 'rejected') throw new Error('El otro dispositivo rechazo el emparejamiento');
    if (claim.state === 'expired') throw new Error('El emparejamiento caduco');
    if (claim.state !== 'listo' || !claim.ciphertext) {
      throw new Error('El otro dispositivo todavia no ha aprobado el emparejamiento');
    }

    const sessionKey = pairingCrypto.deriveSessionKey(claim.kp.privateKey, claim.peerPub, claim.kp.pub);
    const masterKey = pairingCrypto.openMasterKey(sessionKey, claim.ciphertext, claim.nonce);
    await cryptoService.setMasterKey(masterKey);

    claim.state = 'done';
    if (claim.timer) clearTimeout(claim.timer);
    this._claims.delete(pairingId);
    // The encrypted keys we could not read before are readable now: resync from
    // scratch so they land locally.
    this.state.cursor = 0;
    if (this.state.shadow.keys) delete this.state.shadow.keys;
    await this._save();
    this._error = null;
    this._emitStatus();
    this.syncNow().catch(err => console.error('[SyncService] Sync tras emparejar fallido:', err.message));
    return { ok: true };
  }

  /**
   * Devices waiting for this one to approve them. The digits are computed here,
   * from the requester's public key and the ephemeral key this device will use
   * to answer — cached per pairing so the digits shown now are the digits the
   * approval actually uses.
   */
  async pairingPending() {
    const res = await this._request('GET', '/v1/pair/pending');
    if (!res.ok) throw this._httpError(res, 'No se pudieron listar los emparejamientos pendientes');
    const pending = (res.data && res.data.pending) || [];
    const alive = new Set();

    const out = pending.map(entry => {
      alive.add(entry.id);
      let approval = this._approvals.get(entry.id);
      if (!approval) {
        approval = { kp: pairingCrypto.generateEphemeralKeyPair(), peerPub: entry.pub_new };
        this._approvals.set(entry.id, approval);
      }
      approval.peerPub = entry.pub_new || approval.peerPub;
      return {
        id: entry.id,
        deviceName: entry.device_name || null,
        platform: entry.platform || null,
        createdAt: entry.created_at || null,
        expiresAt: entry.expires_at || null,
        digits: approval.peerPub ? pairingCrypto.deriveDigits(approval.peerPub, approval.kp.pub) : null,
      };
    });

    for (const id of [...this._approvals.keys()]) {
      if (!alive.has(id)) this._approvals.delete(id);
    }
    this._pendingPairings = out.length;
    this._emitStatus();
    return { pending: out };
  }

  async pairingApprove(pairingId) {
    if (!this._approvals.has(pairingId)) {
      // Approving without having listed first: refresh so we get pub_new and a
      // cached ephemeral key for this pairing.
      await this.pairingPending();
    }
    const approval = this._approvals.get(pairingId);
    if (!approval || !approval.peerPub) throw new Error('Ese emparejamiento ya no esta pendiente');

    const masterKey = await cryptoService.getMasterKey();
    if (!masterKey) throw new Error('Este dispositivo no tiene clave maestra que compartir');

    const sessionKey = pairingCrypto.deriveSessionKey(approval.kp.privateKey, approval.peerPub, approval.kp.pub);
    const sealed = pairingCrypto.sealMasterKey(sessionKey, masterKey);
    const res = await this._request('POST', `/v1/pair/${encodeURIComponent(pairingId)}/complete`, {
      body: { pub: approval.kp.pub, ciphertext: sealed.ciphertext, nonce: sealed.nonce },
    });
    if (!res.ok) throw this._httpError(res, 'No se pudo completar el emparejamiento');
    this._approvals.delete(pairingId);
    this._pendingPairings = Math.max(0, this._pendingPairings - 1);
    this._emitStatus();
  }

  async pairingReject(pairingId) {
    const res = await this._request('POST', `/v1/pair/${encodeURIComponent(pairingId)}/reject`);
    if (!res.ok) throw this._httpError(res, 'No se pudo rechazar el emparejamiento');
    this._approvals.delete(pairingId);
    this._pendingPairings = Math.max(0, this._pendingPairings - 1);
    this._emitStatus();
  }

  async _refreshPendingPairings() {
    const res = await this._request('GET', '/v1/pair/pending');
    if (!res.ok) return;
    const pending = (res.data && res.data.pending) || [];
    if (pending.length !== this._pendingPairings) {
      this._pendingPairings = pending.length;
      this._emitStatus();
    }
  }
}

module.exports = new SyncService();
