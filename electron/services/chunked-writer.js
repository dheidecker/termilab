/**
 * Ordered, chunked writer for terminal input (pty / ssh channel).
 *
 * A paste arrives as ONE string (xterm's onData), possibly hundreds of KB.
 * Writing it in a single burst is where pastes lose or mangle bytes:
 *  - node-pty writes as fast as the kernel takes it; readline in old bash
 *    (macOS 3.2) corrupts input that arrives too fast (node-pty #833), and a
 *    macOS pty in canonical mode drops what overflows its input queue;
 *  - an ssh2 channel buffers without limit (write() returns false, nothing
 *    lost), but the remote pty has the same limits as a local one.
 * So big writes go out in slices with a short pause between them, and every
 * later write (keys typed during the paste) queues BEHIND it: order is kept.
 * Small writes with nothing queued go out at once — typing has no latency.
 *
 * write(chunk) may return false (stream backpressure): then the next slice
 * waits for `waitDrain(cb)` instead of the timer.
 */
const CHUNK = 1024;        // chars per slice (macOS MAX_CANON is 1024)
const INTERVAL_MS = 4;     // pause between slices of one big write
const DRAIN_FALLBACK_MS = 1000;

/* Split at most `size` UTF-16 units without cutting a surrogate pair: a lone
   half becomes U+FFFD when encoded and the character is lost. */
function slice(str, size) {
  if (str.length <= size) return [str, ''];
  let n = size;
  const c = str.charCodeAt(n - 1);
  if (c >= 0xd800 && c <= 0xdbff) n -= 1;
  return [str.slice(0, n), str.slice(n)];
}

function createChunkedWriter(write, { chunk = CHUNK, interval = INTERVAL_MS, waitDrain = null } = {}) {
  const queue = [];
  let busy = false;
  let timer = null;
  let disposed = false;

  const pump = () => {
    timer = null;
    if (disposed) return;
    if (!queue.length) { busy = false; return; }
    const [head, rest] = slice(queue[0], chunk);
    if (rest) queue[0] = rest; else queue.shift();
    let ok = true;
    try { ok = write(head) !== false; } catch (_) { /* the caller logs */ }
    if (!queue.length) { busy = false; return; }
    if (!ok && waitDrain) {
      /* 'drain', or a fallback in case it never comes (the stream was
         replaced by a reconnect): the queue must not stall forever */
      let done = false;
      const go = () => {
        if (done || disposed) return;
        done = true;
        clearTimeout(timer);
        timer = setTimeout(pump, 0);
      };
      timer = setTimeout(go, DRAIN_FALLBACK_MS);
      waitDrain(go);
    } else timer = setTimeout(pump, interval);
  };

  return {
    write(data) {
      if (disposed || typeof data !== 'string' || !data.length) return;
      if (!busy && data.length <= chunk) {
        try { write(data); } catch (_) { /* the caller logs */ }
        return;
      }
      queue.push(data);
      if (!busy) { busy = true; pump(); }
    },
    /** Bytes still waiting (for tests and diagnostics) */
    pending() { return queue.reduce((n, s) => n + s.length, 0); },
    dispose() {
      disposed = true;
      queue.length = 0;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

module.exports = { createChunkedWriter, slice, CHUNK, INTERVAL_MS };
