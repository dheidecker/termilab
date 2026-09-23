/**
 * Remote OS detection for the host cards' distro logo.
 *
 * One extra `exec` on an already-open ssh2 client, after the interactive shell
 * is up. It must never cost the session anything: fire-and-forget, a hard
 * timeout, an output cap, and every failure is silent (MaxSessions=1, restricted
 * shells, Windows OpenSSH, network gear that rejects exec, a dropped link).
 *
 * The ids below are duplicated in src/components/Icons/distros.jsx (main is
 * CommonJS, the renderer ESM; neither can import the other). Add an id in both.
 */

const OS_COMMAND = 'cat /etc/os-release 2>/dev/null; uname -s';
const OS_TIMEOUT_MS = 5000;
const OS_MAX_OUTPUT = 8 * 1024;

/* os-release ID (or one ID_LIKE word) -> normalized id */
const ID_MAP = {
  ubuntu: 'ubuntu',
  debian: 'debian',
  raspbian: 'raspbian',
  centos: 'centos',
  rhel: 'rhel',
  redhat: 'rhel',
  fedora: 'fedora',
  almalinux: 'almalinux',
  rocky: 'rocky',
  alpine: 'alpine',
  arch: 'arch',
  archarm: 'arch',
  opensuse: 'opensuse',
  'opensuse-leap': 'opensuse',
  'opensuse-tumbleweed': 'opensuse',
  'opensuse-microos': 'opensuse',
  suse: 'opensuse',
  sles: 'opensuse',
  amzn: 'amazon',
  ol: 'oracle',
  freebsd: 'freebsd',
};

const UNAME_MAP = { darwin: 'macos', freebsd: 'freebsd', linux: 'linux' };

function unquote(value) {
  const v = value.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Parse the combined output of OS_COMMAND into one normalized id, or null.
 * Order: os-release ID, then each ID_LIKE word, then `uname -s`.
 */
function parseOsInfo(output) {
  if (typeof output !== 'string' || !output) return null;
  const lines = output.slice(0, OS_MAX_OUTPUT).split(/\r?\n/);

  let id = null;
  let idLike = [];
  let uname = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq > 0) {
      const key = line.slice(0, eq);
      const value = unquote(line.slice(eq + 1)).toLowerCase();
      if (key === 'ID') id = value;
      else if (key === 'ID_LIKE') idLike = value.split(/\s+/).filter(Boolean);
    } else if (/^[A-Za-z]+$/.test(line)) {
      uname = line.toLowerCase();
    }
  }

  if (id && ID_MAP[id]) return ID_MAP[id];
  for (const like of idLike) {
    if (ID_MAP[like]) return ID_MAP[like];
  }
  if (uname && UNAME_MAP[uname]) return UNAME_MAP[uname];
  return null;
}

/**
 * Run OS_COMMAND on `client` and call `onResult(id)` once, only with a
 * non-null id. Never throws, never logs the remote output.
 */
function detectOs(client, onResult) {
  let done = false;
  let channel = null;
  let output = '';

  const finish = (ok) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (channel) {
      try { channel.close(); } catch (_) { /* already gone */ }
    }
    if (!ok) return;
    let os = null;
    try { os = parseOsInfo(output); } catch (_) { os = null; }
    if (os) {
      try { onResult(os); } catch (_) { /* caller's problem, not the session's */ }
    }
  };

  const timer = setTimeout(() => finish(true), OS_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();

  try {
    client.exec(OS_COMMAND, (err, stream) => {
      if (err) return finish(false);
      if (done) {
        try { stream.close(); } catch (_) { /* ignore */ }
        return;
      }
      channel = stream;
      stream.on('data', (chunk) => {
        if (done) return;
        output += chunk.toString('utf-8');
        if (output.length >= OS_MAX_OUTPUT) {
          output = output.slice(0, OS_MAX_OUTPUT);
          finish(true);
        }
      });
      // Drain stderr so a chatty server cannot stall the channel's window.
      if (stream.stderr) stream.stderr.on('data', () => {});
      stream.on('error', () => finish(false));
      stream.on('close', () => finish(true));
    });
  } catch (_) {
    finish(false);
  }
}

module.exports = { parseOsInfo, detectOs, OS_COMMAND };
