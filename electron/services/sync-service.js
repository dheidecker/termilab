const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { app, shell } = require('electron');

const storeService = require('./store-service');
const cryptoService = require('./crypto-service');
const pairingCrypto = require('./pairing-crypto');
const { dedupeEntries } = require('./known-hosts');

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
const AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000;
/* A local edit is pushed this long after the last write: a burst of saves
   (a merge, an import) becomes one sync. */
const CHANGE_SYNC_DELAY_MS = 3000;
/* Coming back to the window pulls what other devices changed, at most this often. */
const FOCUS_SYNC_MIN_GAP_MS = 60 * 1000;
const AUTO_SYNC_DELAY_MS = 8000;
const PUSH_BATCH = 200;
const HTTP_TIMEOUT_MS = 30000;

/**
 * ####################################################################
 * #  ESTADOS DEL EMPAREJAMIENTO — LA INTERFAZ LOS LEE POR NOMBRE     #
 * ####################################################################
 *
 * `status().pairing.state` (el emparejamiento que PIDE este dispositivo).
 * `src/components/Sync/` esta construido contra estas cadenas: si cambias una,
 * hay que cambiarla tambien alli, y no lo detecta ningun build.
 *
 *   'pendiente'  nadie ha aceptado todavia. No hay digitos que ensenar:
 *                salen de LAS DOS publicas y aun falta la del otro.
 *   'verificar'  el otro dispositivo hizo el PASO 1 (`/accept`) y mando su
 *                publica. Ya hay seis digitos y el usuario tiene que
 *                compararlos. En el servidor NO hay todavia ninguna clave
 *                maestra: ese es justo el punto de este estado.
 *   'listo'      el otro hizo el PASO 2 (`/complete`) tras confirmar el
 *                usuario: la clave maestra sellada espera y `pairingClaim()`
 *                puede descifrarla e instalarla.
 *   'rejected'   el otro dispositivo rechazo la peticion, o su publica cambio
 *                a mitad del emparejamiento (alguien en medio).
 *   'expired'    caducado, consumido (410/404) o agotado PAIR_TIMEOUT_MS.
 *   'done'       clave maestra instalada; la entrada se borra acto seguido y
 *                deja de aparecer en el estado.
 *
 * Y en el lado que APRUEBA, cada entrada de `pairingPending()` lleva `state`:
 *
 *   'pendiente'  alguien pide entrar y aun no hemos aceptado.
 *   'aceptado'   hicimos el PASO 1; falta que el usuario compare los digitos
 *                y llame a `pairingConfirm()`. Mientras tanto no ha salido de
 *                aqui ni un byte de la clave maestra.
 */
const CLAIM_ACTIVE_STATES = new Set(['pendiente', 'verificar']);

// server collection name -> local store file name
const COLLECTIONS = {
  hosts: 'hosts',
  groups: 'groups',
  snippets: 'snippets',
  port_forwards: 'port-forwards',
  keys: 'keys',
  known_hosts: 'known-hosts',
  connection_logs: 'connection-logs',
};
/**
 * Row-encrypted collections: never uploaded without the unlocked key, and what
 * no key here opens is counted in `undecryptable` and never applied.
 *
 * `known_hosts` is here for AUTHENTICITY, not secrecy: a plaintext row would
 * let a compromised server plant a host key and make every device trust an
 * impostor. AES-GCM with the account key means only a device that knows the
 * passphrase can write a row the others accept.
 */
const ENCRYPTED_COLLECTIONS = new Set(['keys', 'known_hosts']);

/**
 * Collections whose TOMBSTONES are sealed too. A plaintext tombstone is
 * something the server can forge: for `known_hosts` that deletes a trusted key
 * on every device, and the next MITM gets an "unknown host" prompt instead of
 * a "key changed" one. So a `known_hosts` deletion travels as
 * `enc: true, deleted: true` with `{id, deleted: true}` sealed inside, and a
 * remote tombstone that is not sealed, or does not open, deletes nothing.
 * (`keys` keeps plaintext tombstones: forging one only loses data, which the
 * other devices still hold, and old clients send them that way.)
 */
const SEALED_TOMBSTONES = new Set(['known_hosts']);

/**
 * Sealed rows whose plaintext must carry `id === item_id`. Stops the server
 * from replaying one entry's ciphertext under another entry's id. Only for
 * collections born with this rule: `keys` rows from older versions are not
 * guaranteed to satisfy it byte for byte.
 */
const BOUND_ITEM_IDS = new Set(['known_hosts']);

/**
 * Bump when COLLECTIONS grows. A client older than the collection ignored its
 * rows while its cursor moved past them (v1.10.0: `_applyRecords` skips unknown
 * collections), so after an upgrade the cursor no longer covers them: a state
 * written with a lower version is pulled again from 0 once.
 *   1: hosts, groups, snippets, port_forwards, keys, settings (<= v1.10.0)
 *   2: + known_hosts, connection_logs
 */
const COLLECTIONS_VERSION = 2;

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

/**
 * ####################################################################
 * #  BOVEDA — LA CLAVE MAESTRA SALE DEL PASSPHRASE DE LA CUENTA      #
 * ####################################################################
 *
 * El registro `{ v, salt, kdf, verifier }` viaja como un item de la coleccion
 * `settings` con este item_id reservado (el servidor tiene lista blanca de
 * colecciones y no se toca). NO es un ajuste de la app: se intercepta al bajar
 * y vive en sync-state.json (`state.vault`), jamas en settings.json, y al subir
 * solo sale por `_pushVault()`.
 *
 * "Desbloqueado" = hay clave instalada, se derivo para ESTA sal y abre ESTE
 * verificador. Solo entonces se sella y se sube un secreto. Cualquier otra
 * clave (la aleatoria de versiones antiguas, una recibida sin boveda, la de una
 * boveda que perdio una carrera) sirve para LEER y para re-sellar, nunca para
 * sellar.
 */
const VAULT_ITEM_ID = '__vault__';

// Textos de error que la interfaz puede ensenar tal cual. NUNCA llevan el
// passphrase ni la clave.
const ERR_VAULT_EXISTS = 'Esta cuenta ya tiene passphrase: usa unlock para desbloquear este dispositivo';
const ERR_NO_VAULT = 'Esta cuenta todavia no tiene passphrase: crea uno con setupPassphrase';
const ERR_WRONG_PASSPHRASE = 'Passphrase incorrecto';
const ERR_VAULT_RACE = 'Otro dispositivo ha creado el passphrase de esta cuenta a la vez: desbloquea este con unlock y el passphrase de aquel';
const ERR_PAIR_KEY_MISMATCH = 'La clave recibida por emparejamiento no corresponde al passphrase de esta cuenta; no se ha instalado';
const ERR_NOT_SIGNED_IN = 'No has iniciado sesion en la sincronizacion';
const ERR_NO_KEYCHAIN = 'El almacen de claves del sistema no esta disponible: no se puede guardar la clave maestra';
const ERR_PAIR_NEEDS_NETWORK = 'No se pudo comprobar la clave recibida contra la boveda de la cuenta: hace falta conexion con el servidor de sincronizacion para emparejar';

/**
 * Huella del conjunto de claves legacy, para `state.resealBaseline`. Es un hash
 * de claves aleatorias de 256 bits: no permite recuperarlas.
 */
function legacyDigest(keys) {
  const h = crypto.createHash('sha256');
  for (const b64 of keys.map(k => k.toString('base64')).sort()) h.update(b64);
  return h.digest('hex').slice(0, 32);
}

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

function sealEnvelope(key, plaintext) {
  const { ciphertext, nonce } = cryptoService.encryptWith(key, plaintext);
  return { enc: SECRET_ENVELOPE_MARK, ciphertext, nonce };
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
      vault: null,         // registro de boveda de la cuenta (nunca en settings.json)
      undecryptable: {},   // 'coleccion/id' -> true: bajo cifrado y no se pudo abrir
      // { salt, legacy }: se completo un pull desde el cursor 0 con la clave
      // desbloqueada de esa sal mientras existian ESAS legacy. Sin esto, las
      // legacy no se descartan (ver _prepareLegacyMigration).
      resealBaseline: null,
      collectionsVersion: COLLECTIONS_VERSION,
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
    // pairing_id -> claims: { kp, digits, peerPub, ciphertext, nonce, state, timer }
    //               approvals: { kp, peerPub, state, acceptedAt, info }
    // Los estados posibles estan documentados arriba, junto a CLAIM_ACTIVE_STATES.
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
        vault: cryptoService.parseVault(raw.vault),
        undecryptable: raw.undecryptable && typeof raw.undecryptable === 'object' ? raw.undecryptable : {},
        resealBaseline: raw.resealBaseline && typeof raw.resealBaseline === 'object' ? raw.resealBaseline : null,
        collectionsVersion: COLLECTIONS_VERSION,
      };
      // Written by a version that did not know every collection: its cursor
      // skipped their rows. Pull everything again once (same as a key install).
      if ((Number(raw.collectionsVersion) || 1) < COLLECTIONS_VERSION) this.state.cursor = 0;
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
      // collectionsVersion always current: a cursor this build moved covers
      // every collection it knows (see COLLECTIONS_VERSION).
      const state = { ...this.state, collectionsVersion: COLLECTIONS_VERSION };
      await fsp.writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
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
    this.state.vault = null;
    this.state.undecryptable = {};
    this.state.resealBaseline = null;
    try { await this._save(); } catch (_) { /* ignore */ }
    this._error = 'Sesion caducada o dispositivo revocado';
    this._emitStatus();
  }

  // ─── Status ─────────────────────────────────────────────

  async status() {
    await this._load();
    const token = await cryptoService.getToken().catch(() => null);
    const hasMasterKey = await cryptoService.hasMasterKey().catch(() => false);
    const unlocked = !!(await this._verifiedKey().catch(() => null));
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
      // Boveda. `hasMasterKey` solo dice que hay ALGUNA clave instalada; la que
      // manda es `unlocked`: solo con ella salen secretos de este equipo.
      vaultExists: !!this.state.vault,
      unlocked,
      // Objetos (no campos) que bajaron cifrados y ninguna clave de aqui abre.
      undecryptableCount: Object.keys(this.state.undecryptable || {}).length,
      // Cuales, como "coleccion/id". La interfaz los necesita para no ofrecer
      // borrar un duplicado cuya unica copia legible la tiene otro equipo.
      undecryptableIds: Object.keys(this.state.undecryptable || {}),
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
        // NO se crea ninguna clave maestra aqui. Crearla al azar en cada equipo
        // era el fallo: el segundo dispositivo sincronizaba al instante con
        // otra clave. La clave sale del passphrase (setupPassphrase / unlock)
        // o del emparejamiento; hasta entonces no sale ningun secreto.
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
    // La boveda es de la cuenta: otra cuenta en este equipo tendra la suya. La
    // clave instalada se queda; si la cuenta es la misma, vuelve a verificar.
    this.state.vault = null;
    this.state.undecryptable = {};
    this.state.resealBaseline = null;
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
      const { [VAULT_ITEM_ID]: _vault, ...clean } = settings || {};
      return [{ id: SETTINGS_ITEM_ID, ...clean }];
    }
    const items = await storeService.readRaw(COLLECTIONS[serverCollection]);
    return Array.isArray(items) ? items : [];
  }

  async _writeLocal(serverCollection, items) {
    if (serverCollection === 'settings') {
      const settings = items.find(i => i.id === SETTINGS_ITEM_ID);
      if (settings) {
        // La boveda nunca es un ajuste: ni por item_id (se intercepta antes) ni
        // colada como propiedad.
        const { id, [VAULT_ITEM_ID]: _vault, ...rest } = settings;
        await storeService.saveSettings(rest);
      }
      return;
    }
    await storeService.writeRaw(COLLECTIONS[serverCollection], items);
  }

  /**
   * @param {Buffer|null} key - la clave DESBLOQUEADA (pasa el verificador) o
   *   null. Nunca una clave sin verificar: sellar con ella es justo el fallo que
   *   deja ciphertext que el resto de dispositivos no puede abrir.
   * @returns {Promise<{record: object, withheld: number}>} `withheld` cuenta los
   * campos secretos que se han dejado FUERA del registro por no haber clave
   * maestra desbloqueada. Nunca salen en claro: o van en un sobre, o no van.
   */
  async _buildRecord(serverCollection, item, updatedAt, key) {
    const base = {
      collection: serverCollection,
      item_id: item.id,
      deleted: false,
      updated_at: updatedAt,
    };
    if (ENCRYPTED_COLLECTIONS.has(serverCollection)) {
      if (!key) throw new Error(`Sin clave maestra desbloqueada no se sube ${serverCollection}`);
      const { ciphertext, nonce } = cryptoService.encryptWith(key, JSON.stringify(item));
      return { record: { ...base, enc: true, payload: null, ciphertext, nonce }, withheld: 0 };
    }
    const { payload, withheld } = await this._sealSecretFields(serverCollection, item, key);
    return {
      record: { ...base, enc: false, payload, ciphertext: null, nonce: null },
      withheld,
    };
  }

  /**
   * Sustituye cada campo secreto por su sobre cifrado. Sin clave desbloqueada el
   * campo se OMITE del payload: subirlo en claro no es una opcion, y fallar
   * entero dejaria de sincronizar el resto del host (que si es publico).
   */
  async _sealSecretFields(serverCollection, item, key) {
    const fields = secretFieldsOf(serverCollection);
    if (!fields.length) return { payload: item, withheld: 0 };

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
      if (!key) {
        delete mutable()[field];
        withheld++;
        continue;
      }
      mutable()[field] = sealEnvelope(key, value);
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

  // ─── Keys ───────────────────────────────────────────────

  /**
   * La clave con la que se puede SELLAR: instalada, derivada para la sal de la
   * boveda vigente y capaz de abrir su verificador. Si la boveda cambio (otro
   * dispositivo la creo a la vez y gano), deja de valer sola: el equipo queda
   * bloqueado hasta `unlock`.
   */
  async _verifiedKey() {
    await this._load();
    const vault = this.state.vault;
    if (!vault) return null;
    const key = await cryptoService.getMasterKey();
    if (!key) return null;
    if ((await cryptoService.getVaultSalt()) !== vault.salt) return null;
    return cryptoService.verifyVaultKey(key, vault) ? key : null;
  }

  /**
   * Claves con las que se intenta ABRIR lo que baja: primero la desbloqueada, y
   * detras la instalada sin verificar y las legacy que esperan a que se re-selle
   * lo suyo. Leer con una clave vieja es inofensivo; sellar con ella, no.
   */
  async _keyContext() {
    const verifiedKey = await this._verifiedKey().catch(() => null);
    const installed = await cryptoService.getMasterKey().catch(() => null);
    const legacy = await cryptoService.getLegacyKeys().catch(() => []);
    const keys = [];
    for (const k of [verifiedKey, installed, ...legacy]) {
      if (k && !keys.some(o => o.equals(k))) keys.push(k);
    }
    return { verifiedKey, keys };
  }

  /**
   * @returns {{plaintext: string, fallback: boolean}|null} `fallback` = se abrio
   *   con una clave que NO es la desbloqueada, asi que la copia del servidor hay
   *   que re-sellarla en cuanto la haya.
   */
  _tryOpen(ctx, ciphertext, nonce) {
    for (const key of ctx.keys) {
      try {
        const plaintext = cryptoService.decryptWith(key, ciphertext, nonce);
        return { plaintext, fallback: !(ctx.verifiedKey && key.equals(ctx.verifiedKey)) };
      } catch (_) { /* la siguiente */ }
    }
    return null;
  }

  /**
   * Marca para re-sellar todo lo que lleva secretos (sombra de keys y hosts),
   * MENOS lo que baja sellado con una clave que aqui nadie tiene: eso lo
   * re-sella el equipo que la tiene, no este (ver `_applyRecords`).
   */
  _markReseal() {
    const undecryptable = this.state.undecryptable || {};
    for (const collection of [...ENCRYPTED_COLLECTIONS, ...Object.keys(SECRET_FIELDS)]) {
      const shadow = this.state.shadow[collection];
      if (!shadow) continue;
      for (const [itemId, entry] of Object.entries(shadow)) {
        if (!entry || typeof entry !== 'object') continue;
        if (undecryptable[`${collection}/${itemId}`]) continue;
        entry.reseal = true;
      }
    }
  }

  _hasPendingReseal() {
    for (const shadow of Object.values(this.state.shadow || {})) {
      for (const entry of Object.values(shadow || {})) {
        if (entry && entry.reseal) return true;
      }
    }
    return false;
  }

  /**
   * Las legacy se guardan en el llavero y la marca de re-sellado en
   * sync-state.json: dos archivos, sin atomicidad entre ellos. Si la app se
   * cerro entre las dos escrituras, el llavero tiene legacy y el estado no
   * tiene ni cursor a 0 ni marcas. Por eso NO se confia en que las marcas
   * existan: mientras haya legacy y no conste un pull completo desde 0 con la
   * clave desbloqueada para ESAS legacy, se fuerza (cursor 0 + marcas).
   *
   * @returns {Promise<string|null>} la huella de las legacy, o null si no hay
   *   migracion pendiente que atender en este sync.
   */
  async _prepareLegacyMigration() {
    const legacy = await cryptoService.getLegacyKeys().catch(() => []);
    if (!legacy.length) return null;
    if (!(await this._verifiedKey())) return null;
    const digest = legacyDigest(legacy);
    const b = this.state.resealBaseline;
    if (b && b.salt === this.state.vault.salt && b.legacy === digest) return digest;
    this.state.resealBaseline = null;
    this.state.cursor = 0;
    this._markReseal();
    await this._save();
    return digest;
  }

  /**
   * El camino inverso. `local` es el objeto que ya teniamos en disco, si habia:
   * un equipo sin emparejar recibe el host sin sus secretos y NO debe machacar
   * la contrasena que el usuario tenga guardada aqui.
   *
   * @returns {Promise<{item: object, blocked: number, kept: number, reseal: boolean}>}
   *   `blocked` = sobres que no se pudieron abrir; `kept` = secretos locales
   *   conservados porque el servidor no los trae (el servidor va por detras);
   *   `reseal` = algun sobre se abrio con una clave que no es la desbloqueada.
   */
  async _openSecretFields(serverCollection, incoming, local, ctx) {
    const fields = secretFieldsOf(serverCollection);
    if (!fields.length) return { item: incoming, blocked: 0, kept: 0, reseal: false };

    const item = { ...incoming };
    let blocked = 0;
    let kept = 0;
    let reseal = false;

    for (const field of fields) {
      const value = item[field];
      if (isSecretEnvelope(value)) {
        const opened = this._tryOpen(ctx, value.ciphertext, value.nonce);
        if (opened) {
          item[field] = opened.plaintext;
          if (opened.fallback) reseal = true;
          continue;
        }
        if (ctx.keys.length) {
          console.error(
            `[SyncService] Ninguna clave de este equipo abre ${serverCollection}.${field} de ${incoming.id}`
          );
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
    return { item, blocked, kept, reseal };
  }

  _buildTombstone(serverCollection, itemId, updatedAt, key) {
    if (SEALED_TOMBSTONES.has(serverCollection)) {
      // Sealed so the server cannot forge it (see SEALED_TOMBSTONES). `_push`
      // skips the whole collection without the unlocked key, so the deletion
      // waits in the shadow until there is one.
      if (!key) throw new Error(`Sin clave maestra desbloqueada no se borra en ${serverCollection}`);
      const { ciphertext, nonce } = cryptoService.encryptWith(
        key, JSON.stringify({ id: itemId, deleted: true })
      );
      return {
        collection: serverCollection,
        item_id: itemId,
        enc: true,
        payload: null,
        ciphertext,
        nonce,
        deleted: true,
        updated_at: updatedAt,
      };
    }
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

  async _decodeRecord(record, ctx) {
    if (record.enc) {
      if (!ctx.keys.length) return { blocked: true, item: null };
      const opened = this._tryOpen(ctx, record.ciphertext, record.nonce);
      if (!opened) {
        // Sellado con una clave que no tenemos. No se toca la copia local; se
        // cuenta en `undecryptableCount` y se dice.
        console.error(`[SyncService] Ninguna clave de este equipo abre ${record.collection}/${record.item_id}`);
        return { blocked: true, item: null, undecryptable: true };
      }
      let item;
      try {
        item = JSON.parse(opened.plaintext);
      } catch (_) {
        return { blocked: true, item: null, undecryptable: true };
      }
      if (BOUND_ITEM_IDS.has(record.collection)
          && (!item || typeof item !== 'object' || String(item.id) !== String(record.item_id))) {
        // Authentic ciphertext, but of ANOTHER entry: replayed under this id.
        console.error(`[SyncService] ${record.collection}/${record.item_id} trae el contenido de otro objeto; se ignora`);
        return { blocked: true, item: null, undecryptable: true };
      }
      return { blocked: false, item, reseal: opened.fallback };
    }
    return { blocked: false, item: record.payload, reseal: false };
  }

  /**
   * A remote tombstone for a SEALED_TOMBSTONES collection.
   * @returns {'apply'|'blocked'|'forged'} 'blocked' = sealed with a key not
   *   here (counts as undecryptable, deletes nothing); 'forged' = not sealed
   *   or not a tombstone of this id (deletes nothing, is not counted).
   */
  _checkSealedTombstone(record, ctx) {
    if (!record.enc || !record.ciphertext || !record.nonce) return 'forged';
    if (!ctx.keys.length) return 'blocked';
    const opened = this._tryOpen(ctx, record.ciphertext, record.nonce);
    if (!opened) return 'blocked';
    try {
      const body = JSON.parse(opened.plaintext);
      if (body && body.deleted === true && String(body.id) === String(record.item_id)) return 'apply';
    } catch (_) { /* fall through */ }
    return 'forged';
  }

  // ─── Vault record ───────────────────────────────────────

  /**
   * Un `settings/__vault__` que baja. Se queda en sync-state.json y en ningun
   * otro sitio. Una lapida NO borra la boveda: sin ella este equipo dejaria de
   * saber que clave es la buena, y lo seguro es seguir exigiendo esa.
   */
  _absorbVault(record) {
    if (!record || record.deleted || record.enc) return;
    const vault = cryptoService.parseVault(record.payload);
    if (!vault) {
      console.error('[SyncService] El servidor trae un registro de boveda invalido; se ignora');
      return;
    }
    this.state.vault = vault;
  }

  async _pushVault(vault) {
    const record = {
      collection: 'settings',
      item_id: VAULT_ITEM_ID,
      enc: false,
      payload: vault,
      ciphertext: null,
      nonce: null,
      deleted: false,
      updated_at: new Date().toISOString(),
    };
    // El cursor NO avanza aqui a proposito: el pull siguiente tiene que volver
    // a ver la boveda que quedo en el servidor, sea la nuestra o la de otro.
    const res = await this._request('POST', '/v1/sync', { body: { records: [record] } });
    if (!res.ok) throw this._httpError(res, 'No se pudo subir la boveda');
  }

  /**
   * Instala una clave que YA paso el verificador de `vault`. La anterior, si
   * era otra, pasa a legacy: lo que sello no se queda huerfano, se abre con
   * ella y se re-sella con la nueva en el sync siguiente (cursor a 0 y sombra
   * marcada). La legacy se descarta solo cuando ese sync termina bien.
   */
  async _installVerifiedKey(key, vault) {
    const previous = await cryptoService.getMasterKey();
    const legacy = await cryptoService.getLegacyKeys();
    if (previous && !previous.equals(key)) legacy.push(previous);
    // Primero el estado y despues el llavero: un cierre entre medias deja un
    // re-pull de mas, no legacy sin marcas. (El caso contrario lo cubre
    // `_prepareLegacyMigration`, que no se fia de este orden.)
    this.state.cursor = 0;
    this.state.undecryptable = {};
    this.state.resealBaseline = null;
    this._markReseal();
    await this._save();
    await cryptoService.setMasterKey(key, { vaultSalt: vault.salt, legacyKeys: legacy });
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
      if (record.collection === 'settings' && record.item_id === VAULT_ITEM_ID) {
        // La boveda no es un ajuste: se aparta aqui y no llega a settings.json.
        this._absorbVault(record);
        continue;
      }
      if (!byCollection.has(record.collection)) byCollection.set(record.collection, []);
      byCollection.get(record.collection).push(record);
    }

    // Despues de absorber la boveda de esta pagina: la clave que vale puede
    // haber cambiado con ella.
    const ctx = await this._keyContext();
    if (!this.state.undecryptable) this.state.undecryptable = {};
    const undecryptable = this.state.undecryptable;

    let applied = 0;
    let blocked = 0;
    let blockedSecrets = 0;

    for (const [collection, collectionRecords] of byCollection) {
      const shadow = this.state.shadow[collection] || (this.state.shadow[collection] = {});
      // Read-modify-write under the store's lock for that file: connection logs
      // and known hosts are written by main on their own (a connection starting,
      // a key accepted) and a plain read ... writeRaw would drop that write.
      const mutate = collection === 'settings'
        ? async fn => {
          const items = await this._readLocal(collection);
          const next = await fn(items);
          if (next) await this._writeLocal(collection, next);
        }
        : fn => storeService.mutateRaw(COLLECTIONS[collection], fn);
      await mutate(async (items) => {
        let dirty = false;

        for (const record of collectionRecords) {
          const itemId = record.item_id;
          const tag = `${collection}/${itemId}`;
          const index = items.findIndex(i => i && i.id === itemId);

          if (record.deleted) {
            if (SEALED_TOMBSTONES.has(collection)) {
              const verdict = this._checkSealedTombstone(record, ctx);
              if (verdict === 'blocked') {
                // Same rule as a live row we cannot open: the local copy stays.
                blocked++;
                undecryptable[tag] = true;
                if (shadow[itemId]) delete shadow[itemId].reseal;
                continue;
              }
              if (verdict === 'forged') {
                console.error(`[SyncService] Lapida sin sellar o ajena para ${tag}; no se borra nada`);
                continue;
              }
            }
            // Tombstone. Honour it or objects deleted elsewhere come back.
            delete undecryptable[tag];
            if (collection === 'settings') continue;
            if (index !== -1) {
              items.splice(index, 1);
              dirty = true;
              applied++;
            }
            delete shadow[itemId];
            continue;
          }

          const decoded = await this._decodeRecord(record, ctx);
          if (decoded.blocked) {
            blocked++;
            undecryptable[tag] = true;
            // Nadie aqui abre la copia remota, que puede ser MAS NUEVA que la
            // local: no se re-sella ni se sube desde este equipo.
            if (shadow[itemId]) {
              delete shadow[itemId].reseal;
              delete shadow[itemId].secretsPending;
            }
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
            local,
            ctx
          );
          const incoming = opened.item;
          blockedSecrets += opened.blocked;
          if (opened.blocked) undecryptable[tag] = true;
          else delete undecryptable[tag];

          if (index !== -1) items[index] = incoming;
          else items.push(incoming);
          dirty = true;
          applied++;
          shadow[itemId] = { hash: hashItem(incoming), updated_at: record.updated_at };
          // Guardamos un secreto que el servidor no tiene: la fila remota esta
          // incompleta y hay que volver a subirla en cuanto haya clave maestra,
          // aunque el hash local no se mueva.
          // Si algun sobre bajo ilegible, NO: la copia remota tiene un secreto que
          // aqui no se puede leer (y quiza es mas nuevo); subir el local lo pisaria.
          if (opened.kept && !opened.blocked) shadow[itemId].secretsPending = true;
          // Abierto con una clave vieja: la copia del servidor sigue sellada con
          // ella y los demas dispositivos no la pueden abrir. Se re-sella al subir.
          if ((decoded.reseal || opened.reseal) && !opened.blocked) shadow[itemId].reseal = true;
        }

        if (collection === 'known_hosts') {
          // Two devices that accepted the SAME key hold two entries (random ids).
          // Every device keeps the smallest id and drops the rest, so they all
          // converge; the dropped ones leave as (sealed) tombstones on push.
          const kept = dedupeEntries(items);
          if (kept.length !== items.length) return kept;
        }
        return dirty ? items : null;
      });
    }
    return { applied, blocked, blockedSecrets };
  }

  // ─── Push ───────────────────────────────────────────────

  async _push() {
    // SOLO la clave desbloqueada sella. Sin ella: ni `keys` ni campos secretos.
    const key = await this._verifiedKey();
    const undecryptable = this.state.undecryptable || {};
    const now = new Date().toISOString();
    const records = [];
    const commit = []; // applied to the shadow only once the server accepts
    let withheldSecrets = 0; // campos secretos omitidos por no haber clave maestra

    for (const collection of [...Object.keys(COLLECTIONS), 'settings']) {
      if (ENCRYPTED_COLLECTIONS.has(collection) && !key) {
        // Never upload private keys in the clear. Skipping is the safe failure.
        continue;
      }
      const items = await this._readLocal(collection);
      const shadow = this.state.shadow[collection] || (this.state.shadow[collection] = {});
      const seen = new Set();

      for (const item of items) {
        if (!item || !item.id) continue;
        if (collection === 'settings' && item.id === VAULT_ITEM_ID) continue;
        seen.add(item.id);
        const hash = hashItem(item);
        const previous = shadow[item.id];
        // `secretsPending` = la fila del servidor va sin secretos porque
        // entonces no habia clave maestra. `reseal` = va sellada con una clave
        // que no es la de la cuenta. En los dos casos el hash local no se
        // mueve, asi que sin esta condicion no se reenviaria NUNCA.
        if (undecryptable[`${collection}/${item.id}`] && !(previous && previous.hash !== hash)) {
          // La copia remota esta sellada con una clave que aqui no hay. Solo
          // una edicion local real (el hash se movio desde el ultimo sync) la
          // sustituye; re-sellar o reenviar, nunca.
          if (previous) { delete previous.reseal; delete previous.secretsPending; }
          continue;
        }
        const resend = !!(previous && (previous.secretsPending || previous.reseal) && key);
        if (previous && previous.hash === hash && !resend) continue;
        const updatedAt = item.updatedAt || item.updated_at || now;
        const built = await this._buildRecord(collection, item, updatedAt, key);
        withheldSecrets += built.withheld;
        records.push(built.record);
        commit.push({
          collection,
          itemId: item.id,
          hash,
          updatedAt,
          secretsPending: built.withheld > 0,
          // Sin clave no se re-sella nada: la marca se conserva para despues.
          reseal: !key && !!(previous && previous.reseal),
        });
      }

      for (const itemId of Object.keys(shadow)) {
        if (seen.has(itemId)) continue;
        if (collection === 'settings') continue;
        records.push(this._buildTombstone(collection, itemId, now, key));
        commit.push({ collection, itemId, deleted: true });
      }
    }

    if (!records.length) return { pushed: 0, withheldSecrets, sealedWith: key };

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
          if (entry.reseal) shadow[entry.itemId].reseal = true;
        }
      }
      await this._save();
    }
    return { pushed, withheldSecrets, sealedWith: key };
  }

  // ─── The loop ───────────────────────────────────────────

  /**
   * Todo lo que toca cursor, sombra o clave va en la MISMA cadena: sync,
   * setupPassphrase, unlock y la instalacion de una clave emparejada. Encolar,
   * no rechazar: el login lanza un sync en segundo plano y el usuario que pulsa
   * algo justo despues no debe comerse un "ya hay uno en curso".
   */
  _enqueue(fn) {
    this._chain = (this._chain || Promise.resolve()).then(fn, fn);
    return this._chain;
  }

  /**
   * Serialised: a second call while one is running queues behind it instead of
   * failing. Login kicks off a sync in the background, and the user pressing
   * "sync now" right after must not get "already syncing" thrown at them — nor
   * two loops writing the same collection file at once.
   */
  async syncNow() {
    return this._enqueue(() => this._runSync());
  }

  async _runSync() {
    await this._load();
    if (!(await this.isSignedIn())) throw new Error(ERR_NOT_SIGNED_IN);

    this._syncing = true;
    this._error = null;
    this._emitStatus();
    try {
      const migration = await this._prepareLegacyMigration();
      const fromZero = !this.state.cursor;
      const pull = await this._pull();
      if (migration && fromZero && (await this._verifiedKey())
          && legacyDigest(await cryptoService.getLegacyKeys()) === migration) {
        this.state.resealBaseline = { salt: this.state.vault.salt, legacy: migration };
        await this._save();
      }
      const push = await this._push();
      // Whatever the push created is already ours; pull again so the cursor
      // covers it and any record another device wrote meanwhile.
      const secondPull = push.pushed
        ? await this._pull()
        : { applied: 0, blockedKeys: 0, blockedSecrets: 0 };

      this.state.lastSyncAt = new Date().toISOString();
      await this._save();

      // Las legacy se olvidan SOLO si consta un pull completo desde 0 con la
      // clave desbloqueada para exactamente estas legacy, y ya no queda nada
      // marcado para re-sellar (todo subio). Que el push haya sellado algo no
      // basta: tras un cierre a medias puede no haber nada marcado.
      const legacyNow = await cryptoService.getLegacyKeys();
      const baseline = this.state.resealBaseline;
      if (legacyNow.length && push.sealedWith && baseline && this.state.vault
          && baseline.salt === this.state.vault.salt && baseline.legacy === legacyDigest(legacyNow)
          && !this._hasPendingReseal()) {
        await cryptoService.clearLegacyKeys();
        this.state.resealBaseline = null;
        await this._save();
      }

      // "Sin desbloquear" y "hay cosas que no se abren" NO van a `_error`: la
      // interfaz los lee de vaultExists / unlocked / undecryptableCount y tiene
      // su propio aviso. `_error` es solo para fallos de verdad.
      this._secretsWithheld = push.withheldSecrets || 0;
      this._secretsBlocked = (pull.blockedSecrets || 0) + (secondPull.blockedSecrets || 0);

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

  // ─── Passphrase ─────────────────────────────────────────

  /**
   * Crea la boveda de la cuenta. Solo si NO existe: se baja primero, y si ya
   * hay una, error y a `unlock`. Tras subirla se vuelve a bajar para ver cual
   * quedo en el servidor: si otro dispositivo la creo a la vez y gano, este no
   * instala nada y queda bloqueado (no divergente).
   *
   * El passphrase no se registra, no va en errores y no sale de este metodo mas
   * que hacia scrypt.
   */
  async setupPassphrase(passphrase) {
    cryptoService.validatePassphrase(passphrase);
    return this._enqueue(() => this._doSetupPassphrase(passphrase));
  }

  async _doSetupPassphrase(passphrase) {
    await this._requireReadyForKey();
    await this._pull();
    if (this.state.vault) throw new Error(ERR_VAULT_EXISTS);

    const { vault, key } = await cryptoService.createVault(passphrase);
    await this._pushVault(vault);
    await this._pull();
    if (!this.state.vault || this.state.vault.salt !== vault.salt) {
      this._emitStatus();
      throw new Error(ERR_VAULT_RACE);
    }
    await this._installVerifiedKey(key, vault);
    return this._syncAfterUnlock();
  }

  /**
   * Desbloquea este equipo con el passphrase de la cuenta. Si no abre el
   * verificador: error y NADA cambia (ni clave, ni subida, ni legacy).
   */
  async unlock(passphrase) {
    cryptoService.validatePassphrase(passphrase);
    return this._enqueue(() => this._doUnlock(passphrase));
  }

  async _doUnlock(passphrase) {
    await this._requireReadyForKey();
    await this._pull();
    const vault = this.state.vault;
    if (!vault) throw new Error(ERR_NO_VAULT);

    const key = await cryptoService.deriveVaultKey(passphrase, vault);
    if (!cryptoService.verifyVaultKey(key, vault)) throw new Error(ERR_WRONG_PASSPHRASE);

    const current = await this._verifiedKey();
    if (!current || !current.equals(key)) await this._installVerifiedKey(key, vault);
    return this._syncAfterUnlock();
  }

  async _requireReadyForKey() {
    await this._load();
    if (!(await this.isSignedIn())) throw new Error(ERR_NOT_SIGNED_IN);
    if (!cryptoService.isEncryptionAvailable()) throw new Error(ERR_NO_KEYCHAIN);
  }

  /**
   * La clave ya esta instalada: un fallo de red aqui no deshace el desbloqueo,
   * se queda en `status.error` y el sync siguiente termina el re-sellado (las
   * legacy siguen guardadas hasta entonces).
   */
  async _syncAfterUnlock() {
    this._error = null;
    let synced = true;
    try {
      await this._runSync();
    } catch (err) {
      synced = false;
      console.error('[SyncService] Sync tras desbloquear fallido:', err.message);
    }
    this._emitStatus();
    return { unlocked: !!(await this._verifiedKey()), synced };
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
    this._autoRun = run;
    this._unwatchStore = storeService.onLocalChange(() => this.scheduleSoon());
  }

  /** Debounced sync after a local change. Only once `start()` has armed auto-sync. */
  scheduleSoon(delay = CHANGE_SYNC_DELAY_MS) {
    if (!this._autoRun) return;
    if (this._changeTimer) clearTimeout(this._changeTimer);
    this._changeTimer = setTimeout(() => {
      this._changeTimer = null;
      this._autoRun();
    }, delay);
    if (this._changeTimer.unref) this._changeTimer.unref();
  }

  /** The window regained focus: pull, unless we did so a moment ago. */
  onFocus() {
    const now = Date.now();
    if (this._lastFocusSync && now - this._lastFocusSync < FOCUS_SYNC_MIN_GAP_MS) return;
    this._lastFocusSync = now;
    this.scheduleSoon(0);
  }

  stop() {
    if (this._initialTimer) clearTimeout(this._initialTimer);
    if (this._autoTimer) clearInterval(this._autoTimer);
    if (this._changeTimer) clearTimeout(this._changeTimer);
    if (this._unwatchStore) this._unwatchStore();
    this._initialTimer = null;
    this._autoTimer = null;
    this._changeTimer = null;
    this._unwatchStore = null;
    this._autoRun = null;
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
   * El emparejamiento va en DOS pasos por seguridad, y el orden es lo unico que
   * lo hace seguro:
   *
   *   1. el que aprueba manda SOLO su publica  -> POST /v1/pair/:id/accept
   *      (el que pide ya puede derivar los seis digitos y ensenarlos)
   *   2. el usuario compara los digitos en los dos aparatos y confirma
   *      -> POST /v1/pair/:id/complete con la clave maestra sellada
   *
   * La version anterior mandaba publica y clave maestra en la MISMA peticion:
   * el que pide solo podia calcular los digitos cuando el secreto ya habia
   * salido, asi que comparar no protegia de nada. El servidor responde 409 a un
   * /complete sin /accept previo justamente para que nadie vuelva a juntarlos.
   */

  /**
   * This device has no master key and asks to join. The six digits are unknown
   * until the other device ACCEPTS (step 1) with its public key, so they arrive
   * later through the `sync:status` event (field `pairing.digits`), with state
   * 'verificar'.
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
    if (!claim || !CLAIM_ACTIVE_STATES.has(claim.state)) return;
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

  /**
   * Un sondeo de GET /v1/pair/:id. Ahora tiene dos saltos, no uno:
   * 202 'verificar' trae la publica del otro y NADA MAS (los digitos ya se
   * pueden ensenar y en el servidor no hay ningun secreto todavia), y 200
   * 'listo' trae la clave maestra sellada.
   */
  async _fetchClaim(pairingId) {
    const claim = this._claims.get(pairingId);
    if (!claim || !CLAIM_ACTIVE_STATES.has(claim.state)) return claim;
    const res = await this._request('GET', `/v1/pair/${encodeURIComponent(pairingId)}`);

    if (res.status === 403) {
      claim.state = 'rejected';
      this._emitStatus();
      return claim;
    }
    if (res.status === 410 || res.status === 404) {
      claim.state = 'expired';
      this._emitStatus();
      return claim;
    }
    if (!res.ok && res.status !== 202) throw this._httpError(res, 'No se pudo consultar el emparejamiento');

    const data = res.data || {};
    const peerPub = data.pub_existing || null;

    if (peerPub && claim.peerPub && peerPub !== claim.peerPub) {
      // La publica del otro lado cambio DESPUES de que el usuario mirara los
      // digitos. Eso solo pasa si alguien esta en medio: se corta, y no se
      // recalculan los digitos (los que se comparan son los primeros).
      console.error('[SyncService] La clave publica del otro dispositivo cambio a mitad del emparejamiento');
      claim.state = 'rejected';
      this._error = 'El emparejamiento se corto: la clave publica del otro dispositivo cambio a mitad';
      this._emitStatus();
      return claim;
    }
    if (peerPub && !claim.peerPub) {
      claim.peerPub = peerPub;
      claim.digits = pairingCrypto.deriveDigits(claim.kp.pub, peerPub);
    }

    if (res.status === 202) {
      // 'verificar' = el otro acepto. Sin pub_existing seguimos en 'pendiente'.
      const wanted = (data.status === 'verificar' || claim.peerPub) ? 'verificar' : 'pendiente';
      if (claim.state !== wanted) {
        claim.state = wanted;
        this._emitStatus();
      }
      return claim;
    }

    if (!data.ciphertext || !data.nonce) return claim;  // 200 sin material: aun no
    claim.ciphertext = data.ciphertext;
    claim.nonce = data.nonce;
    claim.state = 'listo';
    this._emitStatus();
    return claim;
  }

  /**
   * The user compared the digits and they match: decrypt the master key and
   * install it. Waits a little if the other side has not confirmed yet.
   */
  async pairingClaim(pairingId) {
    let claim = this._claims.get(pairingId);
    if (!claim) throw new Error('Ese emparejamiento no lo pidio este dispositivo');

    const deadline = Date.now() + 30000;
    while (CLAIM_ACTIVE_STATES.has(claim.state) && Date.now() < deadline) {
      claim = await this._fetchClaim(pairingId);
      if (CLAIM_ACTIVE_STATES.has(claim.state)) await new Promise(r => setTimeout(r, PAIR_POLL_INTERVAL_MS));
    }
    if (claim.state === 'rejected') throw new Error('El otro dispositivo rechazo el emparejamiento');
    if (claim.state === 'expired') throw new Error('El emparejamiento caduco');
    if (claim.state !== 'listo' || !claim.ciphertext) {
      throw new Error('El otro dispositivo todavia no ha confirmado los seis digitos');
    }

    const sessionKey = pairingCrypto.deriveSessionKey(claim.kp.privateKey, claim.peerPub, claim.kp.pub);
    const masterKey = pairingCrypto.openMasterKey(sessionKey, claim.ciphertext, claim.nonce);
    try {
      await this._enqueue(() => this._installPairedKey(masterKey));
    } catch (err) {
      if (err.message === ERR_PAIR_KEY_MISMATCH) {
        // Reintentar no lo arregla: el otro equipo tiene una clave que no es la
        // de la cuenta. Se corta como un rechazo, que la interfaz ya pinta.
        claim.state = 'rejected';
        if (claim.timer) clearTimeout(claim.timer);
        this._emitStatus();
      }
      throw err;
    }

    claim.state = 'done';
    if (claim.timer) clearTimeout(claim.timer);
    this._claims.delete(pairingId);
    this._error = null;
    this._emitStatus();
    this.syncNow().catch(err => console.error('[SyncService] Sync tras emparejar fallido:', err.message));
    return { ok: true };
  }

  /**
   * Instala la clave que llego por emparejamiento. Con boveda, tiene que abrir
   * su verificador o se rechaza sin tocar nada: una clave que no es la de la
   * cuenta es justo la que deja ciphertext huerfano. Sin boveda se instala
   * como clave SIN verificar (lee, no sella) y la anterior pasa a legacy en vez
   * de perderse. En los dos casos se rebaja todo desde el cursor 0 para abrir
   * lo que antes no se podia.
   */
  async _installPairedKey(masterKey) {
    await this._load();
    let pulled = true;
    try {
      await this._pull();   // la boveda vigente, no la que habia en disco
    } catch (err) {
      pulled = false;
      console.error('[SyncService] No se pudo refrescar la boveda antes de instalar la clave:', err.message);
    }
    const vault = this.state.vault;
    // Sin red y sin boveda en disco no se sabe si la cuenta tiene boveda: no
    // se instala nada sin verificar. El emparejamiento sigue 'listo' y se
    // puede reclamar otra vez con conexion.
    if (!vault && !pulled) throw new Error(ERR_PAIR_NEEDS_NETWORK);
    if (vault) {
      if (!cryptoService.verifyVaultKey(masterKey, vault)) throw new Error(ERR_PAIR_KEY_MISMATCH);
      await this._installVerifiedKey(masterKey, vault);
      return;
    }
    const previous = await cryptoService.getMasterKey();
    const legacy = await cryptoService.getLegacyKeys();
    if (previous && !previous.equals(masterKey)) legacy.push(previous);
    this.state.cursor = 0;
    this.state.undecryptable = {};
    this.state.resealBaseline = null;
    this._markReseal();
    await this._save();
    await cryptoService.setMasterKey(masterKey, { vaultSalt: null, legacyKeys: legacy });
  }

  _approvalDigits(approval) {
    return approval.peerPub ? pairingCrypto.deriveDigits(approval.peerPub, approval.kp.pub) : null;
  }

  _approvalSummary(id, approval) {
    const info = approval.info || {};
    return {
      id,
      deviceName: info.deviceName || null,
      platform: info.platform || null,
      createdAt: info.createdAt || null,
      expiresAt: info.expiresAt || null,
      digits: this._approvalDigits(approval),
      state: approval.state,
    };
  }

  /** Una aprobacion aceptada que nadie confirmo se tira al caducar. */
  _approvalStale(approval) {
    return approval.state === 'aceptado'
      && (!approval.acceptedAt || Date.now() - approval.acceptedAt > PAIR_TIMEOUT_MS);
  }

  /**
   * Devices waiting for this one. The digits are computed here, from the
   * requester's public key and the ephemeral key this device answers with —
   * cached per pairing so the digits shown now are the digits the approval
   * actually uses.
   */
  async pairingPending() {
    const res = await this._request('GET', '/v1/pair/pending');
    if (!res.ok) throw this._httpError(res, 'No se pudieron listar los emparejamientos pendientes');
    const pending = (res.data && res.data.pending) || [];
    const serverIds = new Set();

    const out = pending.map(entry => {
      serverIds.add(entry.id);
      let approval = this._approvals.get(entry.id);
      if (!approval) {
        approval = {
          kp: pairingCrypto.generateEphemeralKeyPair(),
          peerPub: entry.pub_new,
          state: 'pendiente',
          acceptedAt: null,
          info: {},
        };
        this._approvals.set(entry.id, approval);
      }
      approval.peerPub = entry.pub_new || approval.peerPub;
      approval.info = {
        deviceName: entry.device_name || null,
        platform: entry.platform || null,
        createdAt: entry.created_at || null,
        expiresAt: entry.expires_at || null,
      };
      return this._approvalSummary(entry.id, approval);
    });

    // Lo que ya aceptamos (paso 1) sigue aqui aunque el servidor deje de
    // listarlo: la efimera privada solo vive en este Map y sin ella no se puede
    // confirmar. Se conserva hasta que se confirma, se rechaza o caduca.
    for (const [id, approval] of [...this._approvals]) {
      if (serverIds.has(id)) continue;
      if (approval.state === 'aceptado' && !this._approvalStale(approval)) {
        out.push(this._approvalSummary(id, approval));
      } else {
        this._approvals.delete(id);
      }
    }

    this._pendingPairings = out.length;
    this._emitStatus();
    return { pending: out };
  }

  /**
   * PASO 1 y SOLO el paso 1: manda la publica de este dispositivo, nada mas.
   * A partir de aqui el que pide ya puede derivar los seis digitos y
   * compararlos; la clave maestra no ha salido de esta maquina. El paso 2 es
   * `pairingConfirm()`, cuando el usuario diga que los digitos coinciden.
   * NO vuelvas a juntarlos por comodidad: el servidor da 409, y juntarlos es
   * exactamente el fallo que este protocolo arregla.
   */
  async pairingApprove(pairingId) {
    if (!this._approvals.has(pairingId)) {
      // Aprobar sin haber listado antes: refrescamos para tener pub_new y una
      // efimera cacheada para este emparejamiento.
      await this.pairingPending();
    }
    const approval = this._approvals.get(pairingId);
    if (!approval || !approval.peerPub) throw new Error('Ese emparejamiento ya no esta pendiente');
    if (approval.state === 'aceptado') {
      // Idempotente: aceptar dos veces no debe reventar ni cambiar los digitos.
      return { state: approval.state, digits: this._approvalDigits(approval) };
    }

    // Se comprueba la clave maestra ANTES de aceptar: aceptar sin poder
    // completar deja al otro lado mirando unos digitos que no llevan a nada.
    const masterKey = await cryptoService.getMasterKey();
    if (!masterKey) throw new Error('Este dispositivo no tiene clave maestra que compartir');

    const res = await this._request('POST', `/v1/pair/${encodeURIComponent(pairingId)}/accept`, {
      body: { pub: approval.kp.pub },
    });
    if (!res.ok) throw this._httpError(res, 'No se pudo aceptar el emparejamiento');

    approval.state = 'aceptado';
    approval.acceptedAt = Date.now();
    this._emitStatus();
    return { state: approval.state, digits: this._approvalDigits(approval) };
  }

  /**
   * PASO 2: el usuario comparo los seis digitos en los dos aparatos y
   * coinciden. Esta es la UNICA llamada que saca la clave maestra de aqui.
   */
  async pairingConfirm(pairingId) {
    const approval = this._approvals.get(pairingId);
    if (!approval || !approval.peerPub) throw new Error('Ese emparejamiento ya no esta pendiente');
    if (approval.state !== 'aceptado') {
      throw new Error('Antes de confirmar hay que aceptar el emparejamiento y comparar los seis digitos');
    }

    const masterKey = await cryptoService.getMasterKey();
    if (!masterKey) throw new Error('Este dispositivo no tiene clave maestra que compartir');

    const sessionKey = pairingCrypto.deriveSessionKey(approval.kp.privateKey, approval.peerPub, approval.kp.pub);
    const sealed = pairingCrypto.sealMasterKey(sessionKey, masterKey);
    const res = await this._request('POST', `/v1/pair/${encodeURIComponent(pairingId)}/complete`, {
      body: { ciphertext: sealed.ciphertext, nonce: sealed.nonce },
    });
    if (!res.ok) {
      if (res.status === 409) {
        // El servidor no tiene registrado el paso 1 (caduco, se reinicio, o
        // alguien lo consumio). La aprobacion se queda, con su efimera y sus
        // digitos: el usuario vuelve a aceptar y a comparar sin empezar de
        // cero, y nada queda a medias por nuestra parte.
        approval.state = 'pendiente';
        approval.acceptedAt = null;
        this._emitStatus();
        throw this._httpError(res, 'El servidor no tiene registrada la aceptacion de este emparejamiento: acepta otra vez y vuelve a comparar los digitos');
      }
      throw this._httpError(res, 'No se pudo completar el emparejamiento');
    }

    this._approvals.delete(pairingId);
    this._pendingPairings = Math.max(0, this._pendingPairings - 1);
    this._emitStatus();
    return { ok: true };
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
    const serverIds = new Set(pending.map(entry => entry.id));
    // Las aceptadas a la espera de confirmacion ya no las lista el servidor y
    // aun asi cuentan: si no, el contador cae a cero justo cuando el usuario
    // tiene que confirmar.
    let esperandoConfirmacion = 0;
    for (const [id, approval] of this._approvals) {
      if (serverIds.has(id)) continue;
      if (approval.state === 'aceptado' && !this._approvalStale(approval)) esperandoConfirmacion++;
    }
    const total = serverIds.size + esperandoConfirmacion;
    if (total !== this._pendingPairings) {
      this._pendingPairings = total;
      this._emitStatus();
    }
  }
}

module.exports = new SyncService();
