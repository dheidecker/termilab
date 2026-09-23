/**
 * Quick connect: turn what the user typed in the Hosts search bar into a
 * throwaway host for `connectToHost`. Moved here unchanged from the old welcome
 * screen, with two differences that only decide *when* it applies:
 *
 * - A leading `ssh ` is ignored, because the placeholder invites
 *   "ssh user@hostname".
 * - Text without an `@` is a search, not an address: the bar filters hosts as
 *   you type, so "web" must not quick-connect to root@web. Returns null.
 */
export function parseQuickConnect(input) {
  const raw = String(input || '').trim().replace(/^ssh\s+/i, '');
  if (!raw || !raw.includes('@')) return null;

  let username = '';
  let hostname = '';
  let port = 22;

  // user@host:port
  const colonMatch = raw.match(/^([^@]+)@([^:]+):(\d+)$/);
  // user@host -p port
  const flagMatch = raw.match(/^([^@]+)@(\S+)\s+-p\s+(\d+)$/);
  // user@host
  const simpleMatch = raw.match(/^([^@]+)@(\S+)$/);

  if (colonMatch) {
    username = colonMatch[1];
    hostname = colonMatch[2];
    port = parseInt(colonMatch[3], 10);
  } else if (flagMatch) {
    username = flagMatch[1];
    hostname = flagMatch[2];
    port = parseInt(flagMatch[3], 10);
  } else if (simpleMatch) {
    username = simpleMatch[1];
    hostname = simpleMatch[2];
  } else {
    return null;
  }

  return {
    id: crypto.randomUUID(),
    label: `${username}@${hostname}`,
    hostname,
    username,
    port,
    /* What connectToHost reads; empty password, like a new host in HostForm */
    authType: 'password',
  };
}
