/*
 * Runs `tailscale serve ...` in the foreground and ties its life to
 * Termilab's: spawned by electron/web/tailscale.js (Electron in node mode,
 * ELECTRON_RUN_AS_NODE) with a pipe on stdin. When Termilab's end closes —
 * disable, quit, crash, kill -9 — stdin ends and this kills serve, so the
 * serve config never outlives the app. No shell: argv goes straight to spawn.
 *
 *   serve-guard.js <tailscale binary> <args...>
 */
const { spawn } = require('child_process');

const [bin, ...args] = process.argv.slice(2);
if (!bin) process.exit(2);

const child = spawn(bin, args, { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  try { child.kill('SIGTERM'); } catch (_) { /* gone */ }
  const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* gone */ } }, 2000);
  t.unref();
};

child.on('error', (err) => { process.stderr.write(`${err.message}\n`); process.exit(127); });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

process.stdin.on('end', stop);
process.stdin.on('close', stop);
process.stdin.on('error', stop);
process.stdin.resume();
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, stop);
