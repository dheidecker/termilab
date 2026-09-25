/* The colours a user can give a host (or a session) with the swatch pickers.
   ONE list for the whole renderer: the popover, the HostForm row and every
   place that paints the colour read it from here. Mid-tone on purpose: each
   one is >= 3:1 against the dark AND light backgrounds (bg-primary,
   bg-secondary and the terminal's #0d1117), so a 2-3 px stripe still reads.
   main does NOT have a copy: it only validates the format (null | #rrggbb,
   electron/services/store-service.js HOST_COLOR_RE), so a colour added here
   needs no change there. */
export const HOST_COLORS = [
  { id: 'red', name: 'Red', hex: '#e5484d' },
  { id: 'orange', name: 'Orange', hex: '#dd6a1f' },
  { id: 'amber', name: 'Amber', hex: '#b88207' },
  { id: 'green', name: 'Green', hex: '#2f9e44' },
  { id: 'teal', name: 'Teal', hex: '#0f9a8a' },
  { id: 'cyan', name: 'Cyan', hex: '#0b95b5' },
  { id: 'blue', name: 'Blue', hex: '#3b82f6' },
  { id: 'indigo', name: 'Indigo', hex: '#6e6ade' },
  { id: 'purple', name: 'Purple', hex: '#a15ce0' },
  { id: 'pink', name: 'Pink', hex: '#d6409f' },
];

const HEX_RE = /^#[0-9a-f]{6}$/i;

/** A colour we are willing to paint: '#rrggbb' (lower-cased) or null. host.color
    arrives from sync as opaque JSON, so anything else is ignored, not styled. */
export function validColor(c) {
  return typeof c === 'string' && HEX_RE.test(c) ? c.toLowerCase() : null;
}

/** The colour of a terminal tab/pane, or null. The terminal's own session
    colour wins (`tab.color`, set from its pane/tab picker, never persisted;
    `'none'` = explicitly none); otherwise its saved host's colour, live from
    `hosts`, as the default every new terminal of that host starts with. */
export function tabColor(tab, hosts) {
  if (!tab) return null;
  if (tab.color === 'none') return null;
  if (validColor(tab.color)) return validColor(tab.color);
  const saved = tab.hostId ? (hosts || []).find(h => h.id === tab.hostId) : null;
  return validColor(saved && saved.color);
}

/* Hosts without a colour of their own and without a group get one of these,
   picked by a stable hash of the hostname. Shared by the Hosts grid and the
   Logs table so the same server looks the same in both. */
export const PALETTE = ['#4f8ff7', '#2fb389', '#e3a232', '#e0625a', '#9a7cf0', '#2ba9cf', '#d56ba8', '#7a8aa8'];

export function hashIndex(str, mod) {
  let hash = 0;
  for (let i = 0; i < (str || '').length; i++) {
    hash = (str.charCodeAt(i) + ((hash << 5) - hash)) | 0;
  }
  return Math.abs(hash) % mod;
}

/** host.color, else its group's, else a stable pick from PALETTE. */
export function hostColor(host, groupMap = {}) {
  return validColor(host.color) || groupMap[host.groupId]?.color
    || PALETTE[hashIndex(host.hostname || host.label, PALETTE.length)];
}

/** Background of a host's icon: an explicit host.color wins over the distro
    logo's brand colour, which wins over the group/hash fallback. */
export function hostIconBackground(host, distro, groupMap = {}) {
  return validColor(host.color) || (distro ? distro.bg : hostColor(host, groupMap));
}
