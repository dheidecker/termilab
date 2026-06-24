<p align="center">
  <img src="assets/icon.png" width="128" height="128" alt="Termilab">
</p>

<h1 align="center">Termilab</h1>

<p align="center">
  <strong>A modern SSH client for managing your servers.</strong><br>
  Connect, explore, and automate — all in one place.
</p>

<p align="center">
  <a href="https://github.com/dheidecker/termilab/releases/latest">
    <img src="https://img.shields.io/github/v/release/dheidecker/termilab?style=flat-square&color=58a6ff" alt="Release">
  </a>
  <a href="https://github.com/dheidecker/termilab/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License">
  </a>
  <img src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-blueviolet?style=flat-square" alt="Platform">
</p>

---

## ✨ Features

- **🖥️ SSH Terminal** — Full-featured terminal powered by xterm.js with search, resize, and scroll
- **📁 SFTP Explorer** — Browse, upload, download, and manage remote files
- **🏠 Host Management** — Save connections with groups, tags, and drag & drop organization
- **🔑 Key Manager** — Import, generate, and manage SSH keys (RSA, ED25519, ECDSA)
- **📝 Snippets** — Save and reuse frequently used commands
- **🔀 Port Forwarding** — Local and remote port forwarding with one click
- **🖥️ Local Terminal** — Open multiple local shell tabs alongside SSH sessions
- **🔄 Auto-Updates** — Get notified when a new version is available and update in-app
- **🎨 Customizable** — Accent colors, font sizes, cursor styles, and more

## 📸 Screenshots

<p align="center">
  <em>Dark, sleek interface inspired by modern terminal clients</em>
</p>

| Host Management | Terminal Session |
|:---:|:---:|
| Visual host cards with drag & drop groups | Multiple tabs with SSH and local terminals |

## 🚀 Installation

### Linux

**AppImage** (portable, no install needed):
```bash
chmod +x Termilab-1.0.0.AppImage
./Termilab-1.0.0.AppImage
```

**Debian/Ubuntu** (.deb):
```bash
sudo dpkg -i termilab_1.0.0_amd64.deb
```

### From Source

```bash
# Clone the repository
git clone https://github.com/dheidecker/termilab.git
cd termilab

# Install dependencies
npm install

# Run in development mode
npm run electron:dev

# Build for production
npm run dist
```

## 🏗️ Tech Stack

| Layer | Technology |
|---|---|
| **Framework** | Electron 33 |
| **Frontend** | React 18 + Vite |
| **Terminal** | xterm.js |
| **SSH** | ssh2 (Node.js) |
| **Shell** | node-pty |
| **Updates** | electron-updater |
| **Storage** | JSON file-based (electron-store pattern) |

## 📁 Project Structure

```
termilab/
├── electron/                  # Main process
│   ├── main.js                # App entry, window, auto-updater
│   ├── preload.js             # Context bridge API
│   ├── ipc-handlers.js        # IPC channel registry
│   └── services/
│       ├── ssh-service.js     # SSH connections via ssh2
│       ├── sftp-service.js    # SFTP file operations
│       ├── local-shell-service.js  # Local PTY shells
│       ├── store-service.js   # JSON persistence
│       ├── key-service.js     # SSH key management
│       └── port-forward-service.js
├── src/                       # Renderer process (React)
│   ├── contexts/AppContext.jsx
│   ├── components/
│   │   ├── Terminal/          # xterm.js terminal view
│   │   ├── HostList/          # Visual host cards
│   │   ├── HostForm/          # Host creation/editing
│   │   ├── SFTP/              # File explorer
│   │   ├── Snippets/          # Command snippets
│   │   ├── KeyManager/        # SSH key management
│   │   ├── PortForwarding/    # Port forwarding UI
│   │   ├── Settings/          # App settings + updates
│   │   ├── TabBar/            # Multi-tab management
│   │   ├── Sidebar/           # Navigation
│   │   ├── Titlebar/          # Custom frameless titlebar
│   │   └── WelcomeScreen/     # Landing page
│   └── index.css              # Design system (CSS variables)
├── assets/
│   └── icon.png               # App icon
└── package.json
```

## ⚙️ Available Scripts

| Command | Description |
|---|---|
| `npm run electron:dev` | Start in development mode with hot reload |
| `npm run dist` | Build `.deb` and `.AppImage` for Linux |
| `npm run dist:all` | Build for Linux, macOS, and Windows |
| `npm run pack` | Build unpacked (for testing) |
| `npm run build` | Build frontend only |

## 🔄 Auto-Updates

Termilab includes a built-in auto-update system powered by `electron-updater`:

1. On startup, the app checks for updates via GitHub Releases
2. If a new version is available, a notification appears in **Settings → About**
3. Click **Download Update** → progress bar shows download status
4. Click **Restart & Install** → app restarts with the new version

### Publishing a New Release

```bash
# 1. Bump version in package.json
# 2. Build the installers
npm run dist

# 3. Create a GitHub Release
gh release create v1.1.0 \
  release/Termilab-1.1.0.AppImage \
  release/termilab_1.1.0_amd64.deb \
  --title "Termilab v1.1.0" \
  --notes "Release notes here"
```

## 🤝 Contributing

Contributions are welcome! Feel free to open issues and pull requests.

## 📄 License

MIT © [Derek](https://github.com/dheidecker)
