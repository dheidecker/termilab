#!/usr/bin/env node
/**
 * A tiny SSH server for tests (ssh2.Server): password auth, and a shell with
 * just enough line editing to type into from a terminal. Each line runs with
 * `sh -c` on this machine, so NEVER bind it to a public interface.
 *
 *   node scripts/lib/ssh-test-server.js --host 0.0.0.0 --port 2222 --user termilab --password mobile
 *     (the Android emulator reaches the host as 10.0.2.2)
 *
 * Built-in commands besides sh: `burst N` writes N one-byte packets and then
 * "burst-done" (to measure the bridge's ssh:data batching).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec, execFileSync } = require('child_process');

function hostKey(file) {
  if (file && fs.existsSync(file)) return fs.readFileSync(file);
  const out = file || path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'termilab-sshd-')), 'host_ed25519');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'termilab-test-sshd', '-f', out], { stdio: 'pipe' });
  return fs.readFileSync(out);
}

function runShell(stream) {
  let line = '';
  const prompt = () => stream.write('$ ');
  stream.write('termilab test sshd\r\n');
  prompt();
  stream.on('data', (buf) => {
    for (const ch of buf.toString('utf-8')) {
      if (ch === '\r' || ch === '\n') {
        stream.write('\r\n');
        const cmd = line.trim();
        line = '';
        if (!cmd) { prompt(); continue; }
        if (cmd === 'exit') { stream.exit(0); stream.end(); return; }
        const burst = cmd.match(/^burst (\d+)$/);
        if (burst) {
          for (let i = 0; i < Number(burst[1]); i++) stream.write('.');
          stream.write('\r\nburst-done\r\n');
          prompt();
          continue;
        }
        exec(cmd, { timeout: 10000, shell: '/bin/sh' }, (err, stdout, stderr) => {
          const text = `${stdout || ''}${stderr || ''}`.replace(/\r?\n/g, '\r\n');
          if (text) stream.write(text);
          prompt();
        });
      } else if (ch === '\x7f' || ch === '\b') {
        if (line) { line = line.slice(0, -1); stream.write('\b \b'); }
      } else if (ch === '\x03') {
        line = ''; stream.write('^C\r\n'); prompt();
      } else if (ch >= ' ') {
        line += ch;
        stream.write(ch);
      }
    }
  });
}

/**
 * @returns {Promise<{server, port, close(): Promise<void>}>}
 */
function startSshTestServer({ host = '127.0.0.1', port = 0, user = null, password = null, hostKeyFile = null, log = () => {} } = {}) {
  const { Server } = require('ssh2');
  const server = new Server({ hostKeys: [hostKey(hostKeyFile)] }, (client) => {
    log('client connected');
    client.on('error', () => {});
    client.on('authentication', (ctx) => {
      if (ctx.method !== 'password') return ctx.reject(['password']);
      if ((user && ctx.username !== user) || (password && ctx.password !== password)) return ctx.reject(['password']);
      ctx.accept();
    });
    client.on('ready', () => {
      log('client authenticated');
      client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (ok) => ok && ok());
        session.on('window-change', (ok) => ok && ok());
        session.on('env', (ok) => ok && ok());
        session.on('shell', (ok) => runShell(ok()));
        session.on('exec', (ok, _reject, info) => {
          const stream = ok();
          exec(info.command, { timeout: 10000 }, (err, stdout, stderr) => {
            stream.write(stdout || '');
            stream.stderr.write(stderr || '');
            stream.exit(err ? 1 : 0);
            stream.end();
          });
        });
      });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({
      server,
      port: server.address().port,
      close: () => new Promise(r => server.close(() => r())),
    }));
  });
}

module.exports = { startSshTestServer };

if (require.main === module) {
  const arg = (name, def) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : def;
  };
  startSshTestServer({
    host: arg('host', '127.0.0.1'),
    port: Number(arg('port', 2222)),
    user: arg('user', null),
    password: arg('password', null),
    hostKeyFile: arg('host-key', null),
    log: (m) => console.log(`[sshd] ${new Date().toISOString()} ${m}`),
  }).then(({ port }) => console.log(`[sshd] listening on ${arg('host', '127.0.0.1')}:${port}`))
    .catch(err => { console.error(err.message); process.exit(1); });
}
