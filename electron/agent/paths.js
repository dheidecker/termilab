/**
 * Where the local agent API lives. Pure Node (no `electron`): main uses it
 * with app.getPath('userData'), and the `termilab-mcp` stdio server
 * (electron/agent/mcp.js) uses it to find a running Termilab.
 *
 *   socket: <userData>/agent.sock          (Windows: \\.\pipe\termilab-agent-<user>)
 *   token:  <userData>/agent-token         (0600, read by the CLI: same user only)
 *
 * TERMILAB_USER_DATA overrides the folder (tests, `--user-data-dir` runs).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const SOCKET_NAME = 'agent.sock';
const TOKEN_NAME = 'agent-token';

function pipeName() {
  let user = 'user';
  try { user = os.userInfo().username || user; } catch (_) { /* keep default */ }
  return `\\\\.\\pipe\\termilab-agent-${String(user).replace(/[^A-Za-z0-9_.-]/g, '_')}`;
}

/** { dir, socket, token } for a userData folder. */
function agentPaths(userDataDir, platform = process.platform) {
  return {
    dir: userDataDir,
    socket: platform === 'win32' ? pipeName() : path.join(userDataDir, SOCKET_NAME),
    token: path.join(userDataDir, TOKEN_NAME),
  };
}

/* Electron's appData per OS (what app.getPath('appData') returns). */
function appDataDir(platform = process.platform, env = process.env) {
  const home = os.homedir();
  if (platform === 'win32') return env.APPDATA || path.join(home, 'AppData', 'Roaming');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support');
  return env.XDG_CONFIG_HOME || path.join(home, '.config');
}

/**
 * userData folders a Termilab of this user may be using, best first. The
 * folder is named after package.json `name` ("termilab"); "Termilab"
 * (productName) is tried too in case a platform build uses that.
 */
function candidateUserDataDirs(env = process.env, platform = process.platform) {
  if (env.TERMILAB_USER_DATA) return [env.TERMILAB_USER_DATA];
  const base = appDataDir(platform, env);
  return [path.join(base, 'termilab'), path.join(base, 'Termilab')];
}

/** The first candidate that has a token file, or the first candidate. */
function findUserDataDir(env = process.env, platform = process.platform) {
  const dirs = candidateUserDataDirs(env, platform);
  for (const d of dirs) {
    try { if (fs.statSync(path.join(d, TOKEN_NAME)).isFile()) return d; } catch (_) { /* next */ }
  }
  return dirs[0];
}

module.exports = { agentPaths, candidateUserDataDirs, findUserDataDir, appDataDir, SOCKET_NAME, TOKEN_NAME };
