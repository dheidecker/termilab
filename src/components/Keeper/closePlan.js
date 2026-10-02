/* Kept by its own module: sessions.js stays pure (the harness bundles it). */
import { askKeeperClose } from './KeeperCloseDialog';

/*
 * Tabs whose session a keeper holds (on the server via ssh-service, or on
 * this computer for a kept local terminal): ask
 * main what is in the foreground (2 s cap). Only the shell, and no `cmd &` /
 * nohup jobs under it → end the kept session silently; anything else →
 * "‹cmd› is still running" with [Keep running in background] / [End
 * session]. Plain shells: nothing to ask.
 * → null when the user cancelled, else { end: Set<tabId> } for endSessions.
 */
export async function planKeeperClose(members) {
  const end = new Set();
  const api = typeof window !== 'undefined' ? window.electronAPI : null;
  const ssh = api?.ssh;
  const local = api?.localShell;
  /* Who answers for each tab: ssh-service, or the local keeper (Linux) for a
     kept local terminal (its pty id is ptySessionId) */
  const askFor = (t) => {
    if (t.type === 'terminal' && t.sessionId && !t.connecting && typeof ssh?.keeperForeground === 'function') {
      return () => ssh.keeperForeground(t.sessionId);
    }
    if (t.type === 'local-terminal' && t.kept && t.ptySessionId && typeof local?.keeperForeground === 'function') {
      return () => local.keeperForeground(t.ptySessionId);
    }
    return null;
  };
  const live = members.map(t => [t, askFor(t)]).filter(([, ask]) => ask);
  if (!live.length) return { end };
  const infos = await Promise.all(live.map(async ([t, ask]) => {
    try { return [t, await ask()]; } catch (_) { return [t, null]; }
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

