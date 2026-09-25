<p align="center">
  <img src="assets/icon.png" width="128" height="128" alt="Termilab">
</p>

<h1 align="center">Termilab</h1>

<p align="center">
  <strong>A self-hosted SSH client for desktop and Android.</strong><br>
  Hosts, terminals, SFTP and tunnels, synced end to end encrypted against your own server.
</p>

<p align="center">
  <a href="https://github.com/dheidecker/termilab/releases/latest">
    <img src="https://img.shields.io/github/v/release/dheidecker/termilab?style=flat-square&color=58a6ff" alt="Release">
  </a>
  <a href="https://github.com/dheidecker/termilab/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License">
  </a>
  <img src="https://img.shields.io/badge/platform-Linux%20%7C%20Windows%20%7C%20macOS%20%7C%20Android-blueviolet?style=flat-square" alt="Platform">
</p>

---

## Overview

Termilab is an SSH client in the spirit of Termius, built for people who want to keep their
connection data on infrastructure they control. The desktop app runs on Linux, Windows and macOS;
the Android app shares the same interface, the same sync protocol and the same encryption code.
Hosts, groups, snippets, keys, port forwards, known hosts and connection history sync across every
device through a small service you deploy yourself (`server/`).

## Features

### Hosts

- Card and list views of hosts and groups, with search, tag filter and sorting (A-Z, Z-A, newest, oldest).
- Groups you can open like folders; a host created inside a group starts in that group.
- Quick connect from the search bar: type `user@host[:port]` and press Enter. An address that matches a saved host uses that host's credentials.
- Operating system detection on connect, shown as the distribution's logo on the host card.
- Optional default colour per host.
- Duplicate detection: hosts that point at the same `user@host:port` are grouped, and can be merged into one, keeping the group, tags and credential the others add.

### Terminal

- xterm.js terminal with search, scrollback, session logging and 12 colour schemes (GitHub Dark and Light, Dracula, Monokai, Nord, One Dark, Tokyo Night, Catppuccin Mocha, Solarized Dark and Light, Gruvbox Dark, Cyberpunk).
- Split panes, horizontal and vertical, in any combination.
- Drag a session tab onto a pane of another tab to add it to that split. Drag panes to move them, drop on the centre of another pane to swap, or drag a pane back to the tab bar to give it its own tab. Moving a pane never reconnects and never loses scrollback.
- Per-terminal alias and colour for the current session. A coloured terminal gets a solid header, a coloured tab and a tinted background, so several terminals of the same host stay distinguishable. Contrast of the terminal text is measured and preserved for every scheme.
- Broadcast input: type once, send to every open terminal.
- Local terminal tabs next to SSH sessions.

### SFTP

- Two-pane file manager; each pane is the local machine or any saved host, including host to host.
- Breadcrumb navigation, typed paths, back and forward, filter, hidden files, sortable columns, multi-selection and keyboard shortcuts.
- Transfers by drag and drop between panes or from the operating system's file manager, with a queue showing progress, speed and remaining time, cancel and retry. Existing targets ask whether to replace, skip or keep both.
- Transfers are atomic: an interrupted or cancelled copy leaves neither a partial file nor a damaged original.
- Edit remote text files in your default editor, with upload on save.
- Rename, permissions (rwx grid and octal), new file and folder, delete (local deletes go to the system trash).

### Port forwarding

- Local (`-L`), remote (`-R`) and dynamic SOCKS5 (`-D`) rules, each tied to a saved host.
- A guided setup that explains each type, or a single form for those who know what they want.
- Live status per rule, with the reason when a rule fails (for example, a local port already in use).

### Security

- Host key verification on first use. Unknown servers ask for confirmation with their SHA-256 fingerprint; a changed key, or a new key type for a known host, is flagged as a possible interception and refused by default.
- Known hosts view, with import from `~/.ssh/known_hosts`.
- SSH key manager: generate (Ed25519, ECDSA, RSA), import or paste keys.
- Saved passwords and SSH keys are encrypted before they leave the device, with a key derived from an account passphrase (scrypt) that the server never sees. Known hosts are encrypted as well, so a compromised server cannot plant a host key.
- Devices can also be paired directly. The six digits both screens show are derived from both devices' ephemeral keys, so a server that swapped a key would make them disagree.

### Sync

- Sign in with Google through the browser; the app receives a revocable device token from your sync service and never sees a Google token.
- Delta sync on a server cursor, with deletions propagated as tombstones.
- Syncs a few seconds after each local change, when the window regains focus, and periodically in the background.
- Hosts, groups, snippets, SSH keys, port forwarding rules, known hosts, connection history and settings.

### Connection history

- Every SSH, SFTP and local session with its start, end, duration, device and account.
- Reconnect from any entry, and save an unsaved connection as a host in one click.

### Updates

- The desktop app checks GitHub Releases on startup and updates from Settings, About, for AppImage, `.deb`, `.pacman` and Windows installs.
- The Android app checks the same release, verifies the download's size and SHA-256, and hands it to the system installer.

## Installation

Download the file for your platform from the [latest release](https://github.com/dheidecker/termilab/releases/latest).

| Platform | File | Notes |
|---|---|---|
| Linux (any distribution) | `Termilab-<version>.AppImage` | `chmod +x` and run. Updates itself in place. |
| Debian, Ubuntu | `termilab_<version>_amd64.deb` | `sudo apt install ./termilab_<version>_amd64.deb` |
| Arch, CachyOS | `termilab-<version>.pacman` | `sudo pacman -U termilab-<version>.pacman` |
| Windows | `Termilab-Setup-<version>.exe` | Unsigned: Windows SmartScreen asks for confirmation on first run. |
| Android (arm64) | `Termilab-<version>-android-arm64.apk` | Allow "install unknown apps" for your browser once. Later updates come from the app. |
| macOS | build from source | `npm run dist:mac` on a Mac. Distribution requires signing and notarization. |

## Self-hosting the sync service

The sync service lives in `server/`: a Node API and a Postgres database, run with Docker Compose.
Copy `server/` to your host (without `.env` and `data/`), fill in `.env` from `.env.example`, and run:

```bash
docker compose up -d --build
```

The API applies its own migrations on start. Endpoints and operational notes are in
[`server/README.md`](server/README.md). Client and server share an unversioned protocol, so both
live in this repository and change together.

## Development

Requirements: Node.js 22 or newer. The Android build additionally needs JDK 21 and the Android SDK
(platform 36, build tools, NDK).

```bash
git clone https://github.com/dheidecker/termilab.git
cd termilab
npm install        # also rebuilds the native modules (node-pty, ssh2) for Electron
npm run dev        # Vite serves the renderer and launches Electron, with hot reload
```

| Command | Description |
|---|---|
| `npm run dev` | Development mode. Use this, not `electron:dev`, which shows a stale build. |
| `npm run build` | Renderer and Electron bundles, no packaging. |
| `npm run pack` | Unpacked app in `release/`, for testing packaging. |
| `npm run dist` | Linux packages: AppImage, `.deb` and `.pacman`. The pacman target needs `bsdtar` on `PATH`. |
| `npm run dist:mac` | macOS `.dmg` (on macOS). |
| `npm run dist:all` | Linux, Windows and macOS. |
| `npm run android:debug` | Debug APK, installed on a connected device or emulator. |
| `npm run android:apk` | Signed release APK and its update manifest, in `release/`. |
| `node scripts/check-main.js` | Test harness for the main process: IPC, encryption, sync, pairing, host keys, port forwarding, SFTP. |
| `node scripts/check-mobile.js` | Test harness for the Android adapter, including desktop to mobile interoperability. |

## Architecture

| Layer | Technology |
|---|---|
| Desktop shell | Electron 33 |
| Interface | React 18 and Vite, shared by desktop and Android |
| Terminal | xterm.js 5 |
| SSH and SFTP | ssh2 |
| Local shells | node-pty |
| Android | Capacitor 8 with nodejs-mobile, running the same main-process services as the desktop |
| Storage | JSON files in the app's user data directory |
| Sync service | Node and Postgres, in `server/` |
| Updates | electron-updater on desktop, a native installer bridge on Android, both from GitHub Releases |

```
termilab/
├── electron/            Main process: window, IPC registry, preload bridge
│   └── services/        SSH, SFTP, transfers, local shells, port forwarding,
│                        host keys, OS detection, storage, encryption, sync
├── src/                 Interface (React), shared with Android
│   ├── components/      Hosts, terminal and split panes, SFTP, port forwarding,
│   │                    keychain, known hosts, logs, snippets, sync, settings
│   ├── contexts/        Application state
│   └── themes/          Terminal colour schemes and tinting
├── mobile/              Android: Capacitor project, Node adapter, web entry
├── server/              Sync service (Node, Postgres, Docker Compose)
├── scripts/             Test harnesses and Android build scripts
└── docs/                Design notes (Android plan)
```

## Releasing

Bump `version` in `package.json`, build the desktop packages and the APK, and attach every file to
one GitHub release: the AppImage, `.deb`, `.pacman`, `latest-linux.yml`, the Windows installer with
its `.blockmap`, `latest.yml`, the APK and `latest-android.json`. A missing manifest silently stops
updates for that platform. The details, including Android signing, are in
[`CLAUDE.md`](CLAUDE.md#releasing).

## License

MIT © [Derek Heidecker](https://github.com/dheidecker)
