/**
 * A real OpenSSH sshd, as the CURRENT user (no root), on 127.0.0.1 and a free
 * port, with its own host key, authorized_keys and pid file in a temp folder.
 * It has the SFTP subsystem, which the ssh2 test server does not.
 *
 *   const sshd = await startRealSshd();
 *   ... connect to 127.0.0.1:sshd.port as sshd.user with sshd.privateKey ...
 *   await sshd.stop();          // kills it and deletes the temp folder
 *
 * Returns null (with .reason on the thrown error) when /usr/sbin/sshd or
 * ssh-keygen is missing. Never bind this to anything but 127.0.0.1: the user
 * that logs in is you, into your real home.
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const SSHD = '/usr/sbin/sshd';
const SFTP_SERVERS = ['/usr/lib/openssh/sftp-server', '/usr/libexec/openssh/sftp-server', '/usr/lib/ssh/sftp-server', '/usr/libexec/sftp-server'];

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitForPort(port, timeoutMs, child) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      if (child.exitCode !== null) return reject(new Error(`sshd exited with ${child.exitCode}`));
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() - t0 > timeoutMs) return reject(new Error(`sshd did not listen on ${port}`));
        setTimeout(tryOnce, 50);
      });
    };
    tryOnce();
  });
}

async function startRealSshd() {
  if (!fs.existsSync(SSHD)) throw new Error(`${SSHD} not found`);
  const sftpServer = SFTP_SERVERS.find(p => fs.existsSync(p)) || 'internal-sftp';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termilab-realsshd-'));
  const hostKey = path.join(dir, 'host_ed25519');
  const userKey = path.join(dir, 'user_ed25519');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'termilab-harness-host', '-f', hostKey], { stdio: 'pipe' });
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'termilab-harness-user', '-f', userKey], { stdio: 'pipe' });
  fs.copyFileSync(`${userKey}.pub`, path.join(dir, 'authorized_keys'));
  const port = await freePort();
  const config = [
    `Port ${port}`,
    'ListenAddress 127.0.0.1',
    `HostKey ${hostKey}`,
    `PidFile ${path.join(dir, 'sshd.pid')}`,
    `AuthorizedKeysFile ${path.join(dir, 'authorized_keys')}`,
    'UsePAM no',
    'StrictModes no',
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'PubkeyAuthentication yes',
    `Subsystem sftp ${sftpServer}`,
    'LogLevel ERROR',
  ].join('\n');
  const configFile = path.join(dir, 'sshd_config');
  fs.writeFileSync(configFile, `${config}\n`);
  // -D: stay in the foreground, so killing the child kills the server.
  const child = spawn(SSHD, ['-D', '-e', '-f', configFile], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  try {
    await waitForPort(port, 5000, child);
  } catch (err) {
    try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`${err.message}: ${stderr.trim().slice(0, 300)}`);
  }
  return {
    port,
    user: os.userInfo().username,
    privateKey: fs.readFileSync(userKey, 'utf-8'),
    pid: child.pid,
    stop: () => new Promise((resolve) => {
      const done = () => { fs.rmSync(dir, { recursive: true, force: true }); resolve(); };
      if (child.exitCode !== null) return done();
      child.once('exit', done);
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* gone */ } }, 2000).unref();
    }),
  };
}

module.exports = { startRealSshd };
