#!/usr/bin/env node
/**
 * End to end for the AI agent API: a real Termilab (Electron, under xvfb) with
 * a throwaway userData, a real OpenSSH sshd (scripts/lib/real-sshd.js), and the
 * `termilab-mcp` stdio server started the way an MCP client starts it:
 *
 *   ELECTRON_RUN_AS_NODE=1 <termilab binary> <...>/electron/agent/mcp.js
 *
 * initialize -> tools/list -> list_hosts -> run_command `uname -a` on the sshd,
 * then the command line through the app binary's `--cli` flag (the AppImage /
 * Windows / mac entry point): `--cli hosts`, `--cli run` with the remote exit
 * code, `--cli run --timeout` -> 124, `--cli mcp`.
 *
 *   node scripts/e2e-agent.mjs                       # dev tree (needs `npm run build`)
 *   node scripts/e2e-agent.mjs release/linux-unpacked # packaged (`npm run pack`): mcp.js from app.asar
 *
 * Never touches the owner's userData or Claude config.
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

const packaged = process.argv[2] ? path.resolve(process.argv[2]) : null;
const electronBin = packaged ? path.join(packaged, 'termilab') : require('electron');
const mcpScript = packaged
  ? path.join(packaged, 'resources', 'app.asar', 'electron', 'agent', 'mcp.js')
  : path.join(ROOT, 'electron', 'agent', 'mcp.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fail = (msg) => { throw new Error(msg); };

delete process.env.SSH_AUTH_SOCK;
const userData = fs.mkdtempSync('/tmp/tlag-e2e-');
let sshd = null;
let app = null;
let mcp = null;
try {
  sshd = await startRealSshd();
  const data = path.join(userData, 'data');
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(data, 'keys.json'), JSON.stringify([{ id: 'k-e2e', name: 'e2e', privateKey: sshd.privateKey, createdAt: now, updatedAt: now }]));
  fs.writeFileSync(path.join(data, 'hosts.json'), JSON.stringify([{
    id: 'h-e2e', label: 'E2E sshd', hostname: '127.0.0.1', port: sshd.port, username: sshd.user,
    authType: 'key', keyId: 'k-e2e', groupId: null, tags: ['e2e'], createdAt: now, updatedAt: now,
  }]));
  const kh = parseKnownHosts(`[127.0.0.1]:${sshd.port} ${sshd.hostPublicKey}\n`).entries[0];
  fs.writeFileSync(path.join(data, 'known-hosts.json'), JSON.stringify([{ id: 'kh-e2e', ...kh, addedAt: now }]));

  const env = { ...process.env, TERMILAB_NO_DEVTOOLS: '1' };
  delete env.VITE_DEV_SERVER_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  const args = ['-a', electronBin, ...(packaged ? [] : [ROOT]), '--no-sandbox', `--user-data-dir=${userData}`];
  app = spawn('xvfb-run', args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let appLog = '';
  app.stdout.on('data', d => { appLog += d; });
  app.stderr.on('data', d => { appLog += d; });

  const sock = path.join(userData, 'agent.sock');
  for (let i = 0; i < 150 && !fs.existsSync(sock); i++) await sleep(200);
  if (!fs.existsSync(sock)) fail(`Termilab never opened ${sock}\n${appLog.slice(-2000)}`);
  const mode = (fs.statSync(sock).mode & 0o777).toString(8);
  console.log(`app: ${packaged ? 'packaged' : 'dev'} ${electronBin}`);
  console.log(`socket: ${sock} mode ${mode}; token mode ${(fs.statSync(path.join(userData, 'agent-token')).mode & 0o777).toString(8)}`);
  console.log(`agent line from the app: ${(appLog.match(/\[Agent\][^\n]*/) || ['(none)'])[0]}`);

  /* The MCP server as a client would start it: Termilab's own binary in node mode */
  mcp = (() => {
    const c = spawn(electronBin, [mcpScript], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TERMILAB_USER_DATA: userData }, stdio: ['pipe', 'pipe', 'pipe'] });
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
    const request = (method, params) => new Promise((resolve, reject) => {
      const id = ++n;
      const t = setTimeout(() => reject(new Error(`no answer to ${method}; stderr: ${err}`)), 30000);
      waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
      c.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    return { child: c, request, close: () => c.stdin.end() };
  })();

  const init = await mcp.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
  console.log(`initialize -> ${JSON.stringify(init.result.serverInfo)} protocol ${init.result.protocolVersion}`);
  mcp.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const tools = await mcp.request('tools/list', {});
  console.log(`tools/list -> ${tools.result.tools.map(t => t.name).join(', ')}`);
  const hosts = await mcp.request('tools/call', { name: 'list_hosts', arguments: {} });
  if (hosts.result.isError) fail(`list_hosts: ${hosts.result.content[0].text}`);
  console.log(`list_hosts -> ${hosts.result.structuredContent.hosts.map(h => `${h.name}${h.hostname ? ` (${h.user}@${h.hostname}${h.port ? `:${h.port}` : ''})` : ''}`).join('; ')}`);
  const run = await mcp.request('tools/call', { name: 'run_command', arguments: { host: 'E2E sshd', command: 'uname -a' } });
  if (run.result.isError) fail(`run_command: ${run.result.content[0].text}`);
  const r = run.result.structuredContent;
  console.log(`run_command uname -a on E2E sshd -> exit ${r.exit_code}, ${r.duration_ms} ms\n  ${r.stdout.trim()}`);
  if (r.exit_code !== 0 || !/Linux/.test(r.stdout)) fail('unexpected run_command result');

  /* termilab-cli through `<binary> --cli`: no ELECTRON_RUN_AS_NODE, main.js does the hop */
  const cliEnv = { ...process.env, TERMILAB_USER_DATA: userData };
  delete cliEnv.ELECTRON_RUN_AS_NODE;
  const viaCli = (args, input = '') => new Promise((resolve) => {
    const c = spawn(electronBin, [...(packaged ? [] : [ROOT]), '--cli', ...args], { env: cliEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let so = ''; let se = ''; const t0 = Date.now();
    c.stdout.on('data', d => { so += d; }); c.stderr.on('data', d => { se += d; });
    c.on('close', code => resolve({ code, stdout: so, stderr: se, ms: Date.now() - t0 }));
    c.stdin.end(input);
  });
  const ch = await viaCli(['hosts']);
  console.log(`--cli hosts -> exit ${ch.code}\n${ch.stdout.trimEnd().split('\n').map(l => `  ${l}`).join('\n')}`);
  if (ch.code !== 0 || !/E2E sshd/.test(ch.stdout)) fail(`--cli hosts: ${ch.stderr}`);
  const cr = await viaCli(['run', '--cwd', '/tmp', 'E2E sshd', '--', 'pwd; echo to-stderr >&2; exit 5']);
  console.log(`--cli run 'pwd; echo to-stderr >&2; exit 5' -> exit ${cr.code}, stdout ${JSON.stringify(cr.stdout)}, stderr ${JSON.stringify(cr.stderr)}`);
  if (cr.code !== 5 || cr.stdout !== '/tmp\n' || cr.stderr !== 'to-stderr\n') fail('unexpected --cli run result');
  const ct = await viaCli(['run', '--timeout', '1', 'E2E sshd', 'sleep 30']);
  console.log(`--cli run --timeout 1 'sleep 30' -> exit ${ct.code} in ${ct.ms} ms`);
  if (ct.code !== 124) fail(`--cli timeout: ${ct.code} ${ct.stderr}`);
  const cm = await viaCli(['mcp'], `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } })}\n`);
  const first = JSON.parse(cm.stdout.split('\n')[0]);
  console.log(`--cli mcp initialize -> ${first.result.serverInfo.name} ${first.result.protocolVersion}, instructions ${first.result.instructions.length} chars, exit ${cm.code}`);
  if (cm.code !== 0 || cm.stdout.trim().split('\n').length !== 1) fail('--cli mcp: stdout carried something other than one JSON-RPC line');

  await sleep(300);
  const logs = JSON.parse(fs.readFileSync(path.join(data, 'agent-logs.json'), 'utf-8'));
  const e = logs.find(x => x.tool === 'run_command');
  console.log(`agent log -> ${JSON.stringify({ type: e.type, tool: e.tool, host: e.host, command: e.command, exitCode: e.exitCode, durationMs: e.durationMs })}`);
  const all = JSON.stringify([init, tools, hosts, run, ch, cr, ct, cm]) + fs.readFileSync(path.join(data, 'agent-logs.json'), 'utf-8');
  const keyLine = sshd.privateKey.split('\n').find(l => l.length > 40 && !l.startsWith('-----'));
  if (all.includes(keyLine)) fail('private key material in MCP output or log');
  console.log('no key material in MCP output or agent log');
  console.log('\nE2E OK');
} catch (err) {
  console.error(`\nE2E FAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  if (mcp) mcp.close();
  if (app) {
    try { process.kill(-app.pid, 'SIGTERM'); } catch (_) { /* gone */ }
    await sleep(1500);
    try { process.kill(-app.pid, 'SIGKILL'); } catch (_) { /* gone */ }
  }
  if (sshd) await sshd.stop();
  fs.rmSync(userData, { recursive: true, force: true });
}
