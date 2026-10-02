#!/usr/bin/env node
/*
 * Release gate: every file in the Linux packages must be world-readable.
 * electron-builder copies file modes as they are on disk, so a build run
 * under a restrictive umask (077) shipped app.asar as 0600 root:root and the
 * installed app could not read its own code (1.16.1). Run after building.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const release = path.join(__dirname, '..', 'release');
const { version } = require('../package.json');
const deb = path.join(release, `termilab_${version}_amd64.deb`);
let bad = 0;
if (fs.existsSync(deb)) {
  const list = execFileSync('dpkg-deb', ['-c', deb], { encoding: 'utf-8' }).split('\n').filter(Boolean);
  for (const line of list) {
    const mode = line.slice(0, 10);
    if (mode[0] === '-' && mode[7] !== 'r') { bad++; if (bad <= 5) console.error('not world-readable:', line); }
  }
  console.log(`${path.basename(deb)}: ${list.length} entries, ${bad} not world-readable`);
} else {
  console.error(`missing ${deb}`);
  process.exit(2);
}
const unpacked = path.join(release, 'linux-unpacked', 'resources', 'app.asar');
if (fs.existsSync(unpacked) && !(fs.statSync(unpacked).mode & 0o004)) {
  console.error('linux-unpacked app.asar is not world-readable'); bad++;
}
process.exit(bad ? 1 : 0);
