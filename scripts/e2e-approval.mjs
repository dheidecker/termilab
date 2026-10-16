#!/usr/bin/env node
/**
 * End to end for destructive agent commands (electron/agent/destructive.js +
 * approval.js + AgentApproval.jsx): a real Termilab (Electron under xvfb, CDP
 * on), a real OpenSSH sshd whose sessions get a FAKE `dropdb` first on PATH
 * (it only appends to a log file), and the MCP server as a client starts it.
 *
 *   1. run_command "dropdb ventas" -> the modal shows in the window (screenshot),
 *      Block has the focus; click Block -> the tool returns "Blocked: ...",
 *      and the fake dropdb never ran.
 *   2. same call, click Run once -> it runs, exactly once.
 *   3. the agent log has run_command (blocked) and (approved) with the category.
 *
 *   npm run build && node scripts/e2e-approval.mjs [screenshot-dir]
 *
 * Never touches the owner's userData, Claude config or a real database.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { startRealSshd } = require('./lib/real-sshd.js');
const { parseKnownHosts } = require('../electron/services/known-hosts.js');

const shotDir = process.argv[2] ? path.resolve(process.argv[2]) : os.tmpdir();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fail = (msg) => { throw new Error(msg); };

delete process.env.SSH_AUTH_SOCK;
const userData = fs.mkdtempSync('/tmp/tlap-e2e-');
const fake = fs.mkdtempSync('/tmp/tlap-bin-');
const dropLog = path.join(fake, 'dropdb.log');
/* The fake dropdb, first on the session's PATH via ForceCommand */
fs.writeFileSync(path.join(fake, 'dropdb'), `#!/bin/sh\necho "fake dropdb $*" >> ${dropLog}\necho "dropped $*"\n`, { mode: 0o755 });
const wrapper = path.join(fake, 'session.sh');
fs.writeFileSync(wrapper, `#!/bin/sh\nexport PATH=${fake}:$PATH\nif [ -n "$SSH_ORIGINAL_COMMAND" ]; then exec /bin/sh -c "$SSH_ORIGINAL_COMMAND"; fi\nexec /bin/sh -l\n`, { mode: 0o755 });
const ranTimes = () => (fs.existsSync(dropLog) ? fs.readFileSync(dropLog, 'utf-8').split('\n').filter(Boolean).length : 0);

let sshd = null;
let app = null;
let mcp = null;
let ws = null;
try {
  sshd = await startRealSshd({ forceCommand: wrapper });
  const data = path.join(userData, 'data');
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(data, 'keys.json'), JSON.stringify([{ id: 'k-e2e', name: 'e2e', privateKey: sshd.privateKey, createdAt: now, updatedAt: now }]));
  fs.writeFileSync(path.join(data, 'hosts.json'), JSON.stringify([{
    id: 'h-e2e', label: 'produccion', hostname: '127.0.0.1', port: sshd.port, username: sshd.user,
    authType: 'key', keyId: 'k-e2e', groupId: null, tags: [], createdAt: now, updatedAt: now,
  }]));
  const kh = parseKnownHosts(`[127.0.0.1]:${sshd.port} ${sshd.hostPublicKey}\n`).entries[0];
  fs.writeFileSync(path.join(data, 'known-hosts.json'), JSON.stringify([{ id: 'kh-e2e', ...kh, addedAt: now }]));

  const CDP = 19000 + Math.floor(Math.random() * 1000);
  const env = { ...process.env, TERMILAB_NO_DEVTOOLS: '1' };
  delete env.VITE_DEV_SERVER_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  app = spawn('xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', require('electron'), ROOT, '--no-sandbox', `--user-data-dir=${userData}`, `--remote-debugging-port=${CDP}`],
    { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let appLog = '';
  app.stdout.on('data', d => { appLog += d; });
  app.stderr.on('data', d => { appLog += d; });

  const sock = path.join(userData, 'agent.sock');
  for (let i = 0; i < 150 && !fs.existsSync(sock); i++) await sleep(200);
  if (!fs.existsSync(sock)) fail(`Termilab never opened ${sock}\n${appLog.slice(-2000)}`);

  /* CDP on the window */
  let target = null;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(300);
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json();
      target = list.find(t => t.type === 'page' && t.url.startsWith('file://') && t.url.endsWith('/dist/index.html'));
    } catch (_) { /* not yet */ }
  }
  if (!target) fail(`no page target (did you npm run build?)\n${appLog.slice(-2000)}`);
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let cid = 0; const cdpWait = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    const w = cdpWait.get(m.id);
    if (w) { cdpWait.delete(m.id); if (m.error) w.reject(new Error(m.error.message)); else w.resolve(m.result); }
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const i = ++cid; cdpWait.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expr) => {
    const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) fail(JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  };
  const waitFor = async (fn, ms = 15000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(150); } };
  const shot = async (name) => {
    const png = await cdp('Page.captureScreenshot', { format: 'png' });
    const file = path.join(shotDir, name);
    fs.writeFileSync(file, Buffer.from(png.data, 'base64'));
    return file;
  };
  const modal = () => evaluate(`(() => { const m = document.querySelector('.aap-modal'); if (!m) return null;
    return { title: m.querySelector('h3').textContent, label: m.querySelector('.hkp-warning strong').textContent,
      command: m.querySelector('.aap-command').textContent, focused: document.activeElement && document.activeElement.textContent.trim(),
      buttons: [...m.querySelectorAll('.hkp-footer button')].map(b => b.textContent.trim()) }; })()`);
  const press = (label) => evaluate(`(() => { const b = [...document.querySelectorAll('.aap-modal .hkp-footer button')].find(x => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
  await waitFor(() => evaluate('!!document.querySelector(".app")'));

  /* The MCP server, started the way a client starts it */
  mcp = (() => {
    const c = spawn(require('electron'), [path.join(ROOT, 'electron', 'agent', 'mcp.js')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TERMILAB_USER_DATA: userData }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = ''; let n = 0; const waiting = new Map(); let err = '';
    c.stdout.setEncoding('utf-8');
    c.stdout.on('data', (d) => {
      buf += d; let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
        const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); }
      }
    });
    c.stderr.on('data', d => { err += d; });
    const request = (method, params, ms = 200000) => new Promise((resolve, reject) => {
      const id = ++n;
      const t = setTimeout(() => reject(new Error(`no answer to ${method}; stderr: ${err}`)), ms);
      waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
      c.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    return { child: c, request, close: () => c.stdin.end() };
  })();
  await mcp.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', title: 'Claude Code', version: '2' } });
  mcp.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  // ── 1. Block ──
  const call1 = mcp.request('tools/call', { name: 'run_command', arguments: { host: 'produccion', command: 'dropdb ventas' } });
  const m1 = await waitFor(modal);
  if (!m1) fail(`no approval modal\n${appLog.slice(-1500)}`);
  await sleep(400);   // let the entrance animation finish
  const shot1 = await shot('termilab-approval-modal.png');
  console.log(`modal -> title "${m1.title}" | label "${m1.label}" | command "${m1.command}" | focus on "${m1.focused}" | buttons ${JSON.stringify(m1.buttons)}`);
  console.log(`screenshot: ${shot1}`);
  if (m1.title !== 'Claude Code wants to run a destructive command on produccion') fail('modal title');
  if (m1.command !== 'dropdb ventas') fail('modal command');
  if (m1.focused !== 'Block') fail(`default focus is "${m1.focused}", not Block`);
  if (ranTimes() !== 0) fail('dropdb ran before the user answered');
  await press('Block');
  const r1 = await call1;
  const t1 = r1.result.content[0].text;
  console.log(`Block -> isError ${r1.result.isError}: ${t1}`);
  if (!r1.result.isError || !/^Blocked: this command was classified as database drop or wipe and the user did not approve it\. Do not retry/.test(t1)) fail('blocked result');
  await sleep(500);
  console.log(`fake dropdb runs on the server after Block: ${ranTimes()}`);
  if (ranTimes() !== 0) fail('dropdb ran after Block');
  if (await modal()) fail('modal still open after Block');

  // ── 2. Run once ──
  const call2 = mcp.request('tools/call', { name: 'run_command', arguments: { host: 'produccion', command: 'dropdb ventas' } });
  if (!(await waitFor(modal))) fail('no modal the second time');
  await press('Run once');
  const r2 = await call2;
  if (r2.result.isError) fail(`Run once failed: ${r2.result.content[0].text}`);
  const s2 = r2.result.structuredContent;
  console.log(`Run once -> exit ${s2.exit_code}, stdout ${JSON.stringify(s2.stdout)}; fake dropdb runs: ${ranTimes()} (${JSON.stringify(fs.readFileSync(dropLog, 'utf-8'))})`);
  if (s2.exit_code !== 0 || s2.stdout !== 'dropped ventas\n' || ranTimes() !== 1) fail('Run once did not run exactly once');

  // ── 3. Harmless commands never ask ──
  const r3 = await mcp.request('tools/call', { name: 'run_command', arguments: { host: 'produccion', command: 'echo $((6*7))' } });
  if (r3.result.structuredContent.stdout !== '42\n' || await modal()) fail('a harmless command asked');
  console.log('harmless "echo $((6*7))" -> 42, no modal');

  await sleep(400);
  const logs = JSON.parse(fs.readFileSync(path.join(data, 'agent-logs.json'), 'utf-8'));
  const pick = (e) => ({ tool: e.tool, command: e.command, category: e.category, ok: e.ok, ...(e.error ? { error: e.error } : {}) });
  console.log('agent log:');
  for (const e of logs) console.log(`  ${JSON.stringify(pick(e))}`);
  if (!logs.some(e => e.tool === 'run_command (blocked)' && e.category === 'databases')) fail('no blocked entry');
  if (!logs.some(e => e.tool === 'run_command (approved)' && e.category === 'databases')) fail('no approved entry');
  console.log('\nE2E OK');
} catch (err) {
  console.error(`\nE2E FAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  try { if (ws) ws.close(); } catch (_) { /* gone */ }
  if (mcp) mcp.close();
  if (app) {
    try { process.kill(-app.pid, 'SIGTERM'); } catch (_) { /* gone */ }
    await sleep(1500);
    try { process.kill(-app.pid, 'SIGKILL'); } catch (_) { /* gone */ }
  }
  if (sshd) await sshd.stop();
  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(fake, { recursive: true, force: true });
}
