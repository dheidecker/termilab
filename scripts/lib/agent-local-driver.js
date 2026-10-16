/**
 * AG17 (scripts/lib/check-agent.js): run under `setpriv --no-new-privs`, so
 * this process has NoNewPrivs 1 like a Termilab relaunched by the updater.
 * The agent's "local" run_command must come out of the user's systemd
 * manager with NoNewPrivs 0. Prints one JSON line.
 */
const fs = require('fs');
const path = require('path');
const { runLocal } = require(path.join(__dirname, '..', '..', 'electron', 'agent', 'local-exec.js'));

const nnp = (text) => (/^NoNewPrivs:\s*(\d+)/m.exec(text) || [])[1];

(async () => {
  const self = nnp(fs.readFileSync('/proc/self/status', 'utf-8'));
  const r = await runLocal({ command: 'cat /proc/self/status', timeoutMs: 20000 });
  console.log(JSON.stringify({ self, command: nnp(r.stdout), exit: r.exit_code, stderr: r.stderr.slice(0, 300) }));
})().catch((err) => { console.log(JSON.stringify({ error: err.message })); process.exit(1); });
