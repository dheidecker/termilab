/* Kept by its own module: sessions.js stays pure (the harness bundles it). */
import { askKeeperClose } from './KeeperCloseDialog';

/*
 * SSH tabs whose session the keeper holds on the server (ssh-service): ask
 * main what is in the foreground (2 s cap). Only the shell, and no `cmd &` /
 * nohup jobs under it → end the kept session silently; anything else →
 * "‹cmd› is still running" with [Keep running in background] / [End
 * session]. Plain shells: nothing to ask.
 * → null when the user cancelled, else { end: Set<tabId> } for endSessions.
 */
export async function planKeeperClose(members) {
  const end = new Set();
  const ssh = typeof window !== 'undefined' ? window.electronAPI?.ssh : null;
  if (!ssh || typeof ssh.keeperForeground !== 'function') return { end };
  const live = members.filter(t => t.type === 'terminal' && t.sessionId && !t.connecting);
  const infos = await Promise.all(live.map(async (t) => {
    try { return [t, await ssh.keeperForeground(t.sessionId)]; } catch (_) { return [t, null]; }
  }));
  const running = [];
  for (const [t, info] of infos) {
    if (!info || !info.keeper || info.missing) continue;
    const jobs = info.isShell && Array.isArray(info.jobs) ? [...new Set(info.jobs)] : [];
    if (info.isShell && !jobs.length) end.add(t.id);
    else if (info.isShell) running.push({ tab: t, label: t.alias || t.label, fgCommand: jobs.join(', '), background: true });
    else running.push({ tab: t, label: t.alias || t.label, fgCommand: info.fgCommand });
  }
  if (!running.length) return { end };
  const answer = await askKeeperClose(running);
  if (!answer) return null;
  if (answer === 'end') for (const r of running) end.add(r.tab.id);
  return { end };
}

