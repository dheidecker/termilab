/* Hosts have no colour of their own today, so a host without a group gets one
   of these, picked by a stable hash of its hostname. Shared by the Hosts grid
   and the Logs table so the same server looks the same in both. */
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
  return host.color || groupMap[host.groupId]?.color
    || PALETTE[hashIndex(host.hostname || host.label, PALETTE.length)];
}
