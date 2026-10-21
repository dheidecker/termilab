/**
 * A minimal server-side WebSocket (RFC 6455), no dependencies.
 *
 * Only what the web mirror needs: the handshake on an http 'upgrade', text and
 * binary messages (masked or not, fragmented or not), ping/pong/close, a cap
 * on the size of one message (close 1009 above it) and a cap on what may sit
 * unsent in the socket (a browser that stops reading is dropped, not buffered
 * without end). No extensions (permessage-deflate is never negotiated), no
 * subprotocols.
 *
 *   const ws = accept(req, socket, head, { maxMessage });   // null if not a valid upgrade (400 sent)
 *   ws.on('message', (data, isBinary) => …)   // string for text, Buffer for binary
 *   ws.on('close', (code, reason) => …)       // once, whatever ended it
 *   ws.send(stringOrBuffer); ws.close(1000, 'bye'); ws.terminate();
 */
const crypto = require('crypto');
const { EventEmitter } = require('events');
const bufferMod = require('buffer');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_MAX_MESSAGE = 32 * 1024 * 1024;
const DEFAULT_MAX_BUFFERED = 64 * 1024 * 1024;
const DEFAULT_PING_MS = 30000;

const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xA };

const isUtf8 = typeof bufferMod.isUtf8 === 'function'
  ? bufferMod.isUtf8
  : (buf) => Buffer.from(buf.toString('utf-8'), 'utf-8').equals(buf);

/** Sec-WebSocket-Accept for a client key. */
function acceptKey(key) {
  return crypto.createHash('sha1').update(String(key) + GUID).digest('base64');
}

/** One frame, server to client (never masked). */
function encodeFrame(opcode, payload, fin = true) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = (fin ? 0x80 : 0) | opcode;
  return Buffer.concat([header, payload]);
}

/** Close codes a peer may send (RFC 6455 7.4). */
function validCloseCode(code) {
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1011) || (code >= 3000 && code <= 4999);
}

class WebSocketLite extends EventEmitter {
  constructor(socket, { maxMessage = DEFAULT_MAX_MESSAGE, maxBuffered = DEFAULT_MAX_BUFFERED, pingMs = DEFAULT_PING_MS } = {}) {
    super();
    this.socket = socket;
    this.maxMessage = maxMessage;
    this.maxBuffered = maxBuffered;
    this.readyState = 'open';     // open | closing | closed
    this._chunks = [];            // unparsed input, as it came (concatenated only once a frame is whole)
    this._chunksLen = 0;
    this._need = 2;               // bytes the next frame needs before parsing is worth a concat
    this._frag = null;            // { opcode, parts: [], size } while a fragmented message arrives
    this._closeSent = false;
    this._closedEmitted = false;
    this._closeCode = 1006;
    this._closeReason = '';
    this._alive = true;

    socket.setNoDelay(true);
    socket.on('data', (d) => this._onData(d));
    socket.on('error', (err) => { this.emit('socket-error', err); this._finish(); });
    socket.on('close', () => this._finish());
    socket.on('end', () => this._finish());

    if (pingMs > 0) {
      this._pinger = setInterval(() => {
        if (!this._alive) { this.terminate(); return; }
        this._alive = false;
        this.ping();
      }, pingMs);
      if (this._pinger.unref) this._pinger.unref();
    }
  }

  // ─── Output ────────────────────────────────────────────

  _write(buf) {
    if (this.readyState === 'closed' || this.socket.destroyed) return false;
    if (this.socket.writableLength + buf.length > this.maxBuffered) {
      // The other end stopped reading: dropping it beats holding the PC's memory hostage.
      this._closeCode = 1008;
      this.terminate();
      return false;
    }
    this.socket.write(buf);
    return true;
  }

  /** A text (string) or binary (Buffer / Uint8Array) message, unfragmented. */
  send(data) {
    if (this.readyState !== 'open') return false;
    if (typeof data === 'string') return this._write(encodeFrame(OP.TEXT, Buffer.from(data, 'utf-8')));
    const buf = Buffer.isBuffer(data) ? data
      : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
        : Buffer.from(data);
    return this._write(encodeFrame(OP.BINARY, buf));
  }

  ping(data = Buffer.alloc(0)) {
    if (this.readyState !== 'open') return false;
    return this._write(encodeFrame(OP.PING, Buffer.from(data).subarray(0, 125)));
  }

  /** Starts the closing handshake; the socket ends once the peer answers (or 5 s pass). */
  close(code = 1000, reason = '') {
    if (this.readyState === 'closed') return;
    if (!this._closeSent) {
      this._closeSent = true;
      const r = Buffer.from(String(reason), 'utf-8').subarray(0, 123);
      const payload = Buffer.alloc(2 + r.length);
      payload.writeUInt16BE(code, 0);
      r.copy(payload, 2);
      this._closeCode = code;
      this._closeReason = String(reason);
      this._write(encodeFrame(OP.CLOSE, payload));
    }
    this.readyState = 'closing';
    if (!this._closeTimer) {
      this._closeTimer = setTimeout(() => this.terminate(), 5000);
      if (this._closeTimer.unref) this._closeTimer.unref();
    }
  }

  terminate() {
    try { this.socket.destroy(); } catch (_) { /* gone */ }
    this._finish();
  }

  /** Close after a violation: the close frame, then the socket ends (no waiting for an answer). */
  fail(code, reason) { this._fail(code, reason); }

  _fail(code, reason) {
    this.close(code, reason);
    // After a protocol error nothing more is read: end the TCP side once the close frame is out.
    try { this.socket.end(); } catch (_) { /* gone */ }
  }

  _finish() {
    if (this._closedEmitted) return;
    this._closedEmitted = true;
    this.readyState = 'closed';
    clearInterval(this._pinger);
    clearTimeout(this._closeTimer);
    this._chunks = [];
    this._chunksLen = 0;
    this._frag = null;
    try { this.socket.destroy(); } catch (_) { /* gone */ }
    this.emit('close', this._closeCode, this._closeReason);
  }

  // ─── Input ─────────────────────────────────────────────

  _onData(d) {
    if (this.readyState === 'closed') return;
    this._alive = true;
    this._chunks.push(d);
    this._chunksLen += d.length;
    /* A big message arrives in many chunks: they wait in the list until the
       frame is whole, and only then are joined, once. Concatenating on every
       chunk was quadratic (a 20 MB image in 64 KB chunks: ~3 GB copied). */
    if (this._chunksLen < this._need) return;
    let buf = this._chunks.length === 1 ? this._chunks[0] : Buffer.concat(this._chunks, this._chunksLen);
    let off = 0;
    while (this.readyState !== 'closed') {
      const used = this._parseFrame(buf, off);
      if (used <= 0) break;
      off += used;
    }
    buf = off >= buf.length ? null : buf.subarray(off);
    this._chunks = buf ? [buf] : [];
    this._chunksLen = buf ? buf.length : 0;
    this._need = buf ? this._frameNeed(buf) : 2;
  }

  /** Bytes the frame starting at buf[0] needs: its header, then header + payload once the length is known. */
  _frameNeed(buf) {
    if (buf.length < 2) return 2;
    const b1 = buf[1];
    const code = b1 & 0x7F;
    const head = 2 + (code === 126 ? 2 : code === 127 ? 8 : 0) + ((b1 & 0x80) ? 4 : 0);
    if (buf.length < head) return head;
    let len = code;
    if (code === 126) len = buf.readUInt16BE(2);
    else if (code === 127) {
      const big = buf.readBigUInt64BE(2);
      /* Over the cap _parseFrame already closed with 1009; never wait for it */
      if (big > BigInt(this.maxMessage)) return head;
      len = Number(big);
    }
    return head + len;
  }

  /** Parses one frame at `off`. Returns bytes consumed, 0 if incomplete, -1 after a failure. */
  _parseFrame(buf, off) {
    if (buf.length - off < 2) return 0;
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const fin = (b0 & 0x80) !== 0;
    const rsv = b0 & 0x70;
    const opcode = b0 & 0x0F;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7F;
    let pos = off + 2;
    if (rsv) { this._fail(1002, 'reserved bits'); return -1; }
    const control = opcode >= 0x8;
    if (control && (!fin || len > 125)) { this._fail(1002, 'bad control frame'); return -1; }
    if (![OP.CONT, OP.TEXT, OP.BINARY, OP.CLOSE, OP.PING, OP.PONG].includes(opcode)) { this._fail(1002, 'bad opcode'); return -1; }
    if (len === 126) {
      if (buf.length - pos < 2) return 0;
      len = buf.readUInt16BE(pos);
      pos += 2;
    } else if (len === 127) {
      if (buf.length - pos < 8) return 0;
      const big = buf.readBigUInt64BE(pos);
      pos += 8;
      if (big > BigInt(this.maxMessage)) { this._fail(1009, 'message too big'); return -1; }
      len = Number(big);
    }
    // The cap is checked on the header, before a byte of the payload is held.
    if (!control) {
      const already = opcode === OP.CONT && this._frag ? this._frag.size : 0;
      if (already + len > this.maxMessage) { this._fail(1009, 'message too big'); return -1; }
    }
    let mask = null;
    if (masked) {
      if (buf.length - pos < 4) return 0;
      mask = buf.subarray(pos, pos + 4);
      pos += 4;
    }
    if (buf.length - pos < len) return 0;
    let payload = Buffer.from(buf.subarray(pos, pos + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    const consumed = pos + len - off;

    if (control) {
      this._onControl(opcode, payload);
      return this.readyState === 'closed' ? -1 : consumed;
    }
    if (this.readyState !== 'open') return consumed;   // closing: data is ignored

    if (opcode === OP.CONT) {
      if (!this._frag) { this._fail(1002, 'unexpected continuation'); return -1; }
      this._frag.parts.push(payload);
      this._frag.size += payload.length;
      if (!fin) return consumed;
      const { opcode: first, parts } = this._frag;
      this._frag = null;
      payload = Buffer.concat(parts);
      return this._deliver(first, payload) ? consumed : -1;
    }
    if (this._frag) { this._fail(1002, 'expected continuation'); return -1; }
    if (!fin) {
      this._frag = { opcode, parts: [payload], size: payload.length };
      return consumed;
    }
    return this._deliver(opcode, payload) ? consumed : -1;
  }

  _deliver(opcode, payload) {
    if (opcode === OP.TEXT) {
      if (!isUtf8(payload)) { this._fail(1007, 'invalid utf-8'); return false; }
      this.emit('message', payload.toString('utf-8'), false);
    } else {
      this.emit('message', payload, true);
    }
    return true;
  }

  _onControl(opcode, payload) {
    if (opcode === OP.PING) {
      if (this.readyState === 'open') this._write(encodeFrame(OP.PONG, payload));
      return;
    }
    if (opcode === OP.PONG) { this.emit('pong', payload); return; }
    // CLOSE
    let code = 1005;
    let reason = '';
    if (payload.length === 1) { this._fail(1002, 'bad close'); this.terminate(); return; }
    if (payload.length >= 2) {
      code = payload.readUInt16BE(0);
      reason = payload.subarray(2).toString('utf-8');
      if (!validCloseCode(code)) { this._closeCode = 1002; this.close(1002, 'bad close code'); this.terminate(); return; }
    }
    if (!this._closeSent) this.close(code === 1005 ? 1000 : code, '');
    this._closeCode = code;
    this._closeReason = reason;
    try { this.socket.end(); } catch (_) { /* gone */ }
    this._finish();
  }
}

/**
 * Handshake for an http 'upgrade'. Writes the 101 and returns the socket, or
 * answers 400 and returns null when the request is not a WebSocket upgrade.
 * Authentication is the caller's job, BEFORE calling this.
 */
function accept(req, socket, head, opts = {}) {
  const h = req.headers;
  const key = h['sec-websocket-key'];
  const ok = req.method === 'GET'
    && String(h.upgrade || '').toLowerCase() === 'websocket'
    && /\bupgrade\b/i.test(String(h.connection || ''))
    && String(h['sec-websocket-version'] || '') === '13'
    && typeof key === 'string' && Buffer.from(key, 'base64').length === 16;
  if (!ok) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return null;
  }
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    '', '',
  ].join('\r\n'));
  const ws = new WebSocketLite(socket, opts);
  if (head && head.length) ws._onData(head);
  return ws;
}

module.exports = { accept, acceptKey, encodeFrame, WebSocketLite, OP, DEFAULT_MAX_MESSAGE };
