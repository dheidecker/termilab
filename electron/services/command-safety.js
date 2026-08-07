/**
 * Command safety classifier — decides whether a shell command is destructive
 * (deletes, overwrites, or irreversibly changes data or system state) and must
 * therefore NEVER run without the user's explicit approval, in any AI mode.
 *
 * Mirror of src/config/commandSafety.js (ESM) — main is CommonJS and can't
 * require that module. Keep both files in sync.
 *
 * Bias: when in doubt, flag it. A false positive costs the user one approval
 * click; a false negative deletes their data.
 */

const DESTRUCTIVE_RULES = [
  /* File and directory deletion */
  { re: /\b(rm|rmdir|unlink|shred|srm)\b/, reason: 'deletes files or directories' },
  { re: /\bfind\b[^\n]*\s-delete\b/, reason: 'deletes files matched by find' },
  { re: /\btruncate\b/, reason: 'truncates file contents' },
  { re: /\bmv\b[^\n]*\s\/dev\/null/, reason: 'discards data into /dev/null' },
  { re: /\brsync\b[^\n]*--(delete|remove-source-files)/, reason: 'rsync deletes files' },

  /* Disks, filesystems, partitions, volumes */
  { re: /\b(mkfs(\.\w+)?|wipefs|fdisk|parted|sgdisk|badblocks)\b/, reason: 'modifies disks or partitions' },
  { re: /\bdd\b/, reason: 'writes raw data (dd)' },
  { re: />\s*\/dev\/(sd|nvme|hd|vd)/, reason: 'writes directly to a block device' },
  { re: /\b(lvremove|vgremove|pvremove)\b|\bzfs\s+destroy\b/, reason: 'destroys storage volumes' },

  /* Version control data loss */
  { re: /\bgit\b[^\n]*\breset\b[^\n]*--hard/, reason: 'discards git changes (reset --hard)' },
  { re: /\bgit\b[^\n]*\bclean\b/, reason: 'deletes untracked files (git clean)' },
  { re: /\bgit\b[^\n]*\b(checkout|restore)\b[^\n]*(\s--(\s|$)|\s\.(\s|$))/, reason: 'discards working tree changes' },
  { re: /\bgit\b[^\n]*\bpush\b[^\n]*(--force\b|\s-f\b)/, reason: 'force-pushes (rewrites remote history)' },
  { re: /\bgit\b[^\n]*\bbranch\b[^\n]*\s-D\b/, reason: 'force-deletes a branch' },
  { re: /\bgit\b[^\n]*\bstash\b[^\n]*\b(drop|clear)\b/, reason: 'discards stashed changes' },

  /* Databases */
  { re: /\bdrop\s+(database|table|schema|collection|index|user)\b/i, reason: 'drops database objects' },
  { re: /\btruncate\s+table\b/i, reason: 'truncates a database table' },
  { re: /\bdelete\s+from\b/i, reason: 'deletes database rows' },
  { re: /\bflush(all|db)\b/i, reason: 'flushes database contents' },

  /* Containers and orchestration */
  { re: /\bdocker\b[^\n]*\b(rm|rmi|prune)\b/, reason: 'removes docker resources' },
  { re: /\bdocker(-|\s+)compose\b[^\n]*\bdown\b[^\n]*(\s-v\b|--volumes)/, reason: 'removes compose volumes' },
  { re: /\b(kubectl|helm)\b[^\n]*\b(delete|uninstall)\b/, reason: 'deletes cluster resources' },

  /* System package removal */
  { re: /\b(apt|apt-get|aptitude)\b[^\n]*\b(remove|purge|autoremove)\b/, reason: 'removes system packages' },
  { re: /\bdpkg\b[^\n]*(\s-P\b|--purge|\s-r\b|--remove)/, reason: 'removes system packages' },
  { re: /\b(yum|dnf)\b[^\n]*\b(remove|erase|autoremove)\b/, reason: 'removes system packages' },
  { re: /\bpacman\b[^\n]*\s-R/, reason: 'removes system packages' },
  { re: /\bapk\s+del\b|\bsnap\s+remove\b|\bflatpak\s+uninstall\b|\bzypper\s+(remove|rm)\b/, reason: 'removes system packages' },

  /* Users, permissions, scheduled jobs */
  { re: /\b(userdel|groupdel)\b/, reason: 'deletes users or groups' },
  { re: /\bcrontab\b[^\n]*\s-r\b/, reason: 'erases the crontab' },
  { re: /\bchmod\b[^\n]*(\s-R\b|777)/, reason: 'recursive or world-writable permission change' },
  { re: /\bchown\b[^\n]*\s-R\b/, reason: 'recursive ownership change' },
  { re: /\bhistory\s+-c\b/, reason: 'clears shell history' },

  /* Service and machine disruption */
  { re: /\b(shutdown|reboot|poweroff|halt)\b/, reason: 'shuts down or reboots the machine' },
  { re: /\binit\s+0\b/, reason: 'shuts down the machine' },
  { re: /\bsystemctl\b[^\n]*\b(stop|disable|mask)\b/, reason: 'stops or disables a service' },
  { re: /\b(kill|pkill|killall)\b/, reason: 'kills processes' },
  { re: /\b(iptables|nft)\b[^\n]*(\s-F\b|\bflush\b)/, reason: 'flushes firewall rules' },
  { re: /\bufw\s+(disable|reset)\b/, reason: 'disables the firewall' },

  /* Classic footguns */
  { re: /:\(\)\s*\{/, reason: 'fork bomb' },
];

/**
 * Classify a command (or a whole ```bash:run block — multi-line is fine;
 * chaining with && / ; / | can't hide a match since rules scan the full text).
 * @returns {{destructive: boolean, reason: string|null}}
 */
function classifyCommand(command) {
  const cmd = String(command || '');
  for (const rule of DESTRUCTIVE_RULES) {
    if (rule.re.test(cmd)) return { destructive: true, reason: rule.reason };
  }
  return { destructive: false, reason: null };
}

function isDestructive(command) {
  return classifyCommand(command).destructive;
}

module.exports = { DESTRUCTIVE_RULES, classifyCommand, isDestructive };
