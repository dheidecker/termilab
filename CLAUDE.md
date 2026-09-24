# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install            # also runs electron-builder install-app-deps (rebuilds node-pty, cpu-features)
npm run dev            # THE dev command — Vite serves the renderer AND launches Electron
npm run build          # frontend + electron bundles only, no packaging
npm run pack           # unpacked app in release/, for testing packaging
npm run dist           # Linux .deb + .AppImage
npm run dist:mac       # macOS .dmg
npm run dist:all       # Linux + Windows + macOS
```

There is no test runner, linter, or formatter configured. Verification is manual: run the app.

`npm run dev` is what you want. `vite-plugin-electron` sets `VITE_DEV_SERVER_URL` and spawns Electron
itself once the dev server listens, so `vite` alone gives you the full app with hot reload.
`npm run electron:dev` spawns a *second* Electron without that env var — that one falls through to
`loadFile('../dist/index.html')` and shows a stale build.

Unsigned macOS builds need `CSC_IDENTITY_AUTO_DISCOVERY=false` in the environment, otherwise
electron-builder looks for a signing identity. Distribution outside your own machine requires real
signing + notarization.

## Architecture

Electron app: a CommonJS main process (`electron/`) and a React 18 renderer (`src/`), talking over IPC.

### The IPC boundary

Everything crossing the boundary goes through three files, and all three must be edited together when
adding a channel:

1. `electron/ipc-handlers.js` — the single registry. Every handler is wrapped by `wrapHandler()`,
   which converts throws into `{ success: false, error }` and returns `{ success: true, data }`.
2. `electron/preload.js` — the context bridge. Its local `invoke()` unwraps that envelope, so
   renderer code gets raw data and a rejected promise on failure. Exposed as `window.electronAPI`.
3. Renderer call site, normally via `AppContext`.

Channels are namespaced `domain:action` (`ssh:connect`, `sftp:list`, `store:save-host`).
Streaming data (terminal output, update progress) goes the other way with `ipcRenderer.on` listeners
that return the listener function so callers can detach it.

### Main-process services

`electron/services/*.js` are singleton class instances, each owning a `Map` keyed by `sessionId`:
`ssh-service` (ssh2 clients + shell streams), `sftp-service`, `local-shell-service` (node-pty),
`port-forward-service`. `main.js` tears all of them down in `before-quit`.

Persistence is `store-service.js`: plain JSON files under `app.getPath('userData')/data/` — one per
collection (`hosts`, `groups`, `snippets`, `keys`, `port-forwards`) plus settings. Writes take a
per-collection in-process lock (`_acquireLock`) because several renderer actions can race. **SSH
private keys are stored in plaintext** in `keys.json`.

### Renderer state

One `useReducer` store in `src/contexts/AppContext.jsx` holds hosts, groups, tabs, sessions, and
settings. It also carries `MOCK_*` fixtures used when `window.electronAPI` is absent, so the UI
renders in a plain browser without Electron.

Theming: all colors are CSS custom properties in `src/index.css`. Dark is the `:root` baseline; light
overrides only the color tokens under `:root[data-theme='light']`. `AppContext` stamps `data-theme`
on `<html>` from `settings.appearance.theme`. Terminal color schemes are separate, in
`src/themes/terminal-themes.js`.

### The AI assistant is gone

Removed entirely on branch `feat/sync-sin-ia`. If you find a reference to `AIAssistant`,
`ai-service`, `aiModels`, `commandSafety` or an `ai:*` IPC channel, it is a leftover — delete it,
don't restore it.

Two consequences worth knowing:

- **`webviewTag` is now `false`** in `main.js`. It existed only for the assistant's embedded
  `<webview>`. Don't turn it back on without a reason.
- **Old installs have AI provider API keys sitting in plaintext** in `settings.json`.
  `store-service._purgeAiCredentials()` drops the whole `ai` block the first time settings are read
  and rewrites the file, and `saveSettings()` does `delete merged.ai` unconditionally so nothing can
  put it back — including an imported backup from an older version. Don't remove either guard.

### Sync backend

Termilab syncs against a service on the user's own server, reachable at
`https://termilab.rhinlab.com`. **Its source lives in `server/` in this repo** and is deployed to
`/home/contenedores/termilab` on that host; `server/README.md` documents the endpoints.

Client and server share a protocol that is not versioned or negotiated, so **a change on one side
is a change on both**. They are in one repo for exactly that reason — keep them in the same commit
when the contract moves. Deploying is copying `server/` to the host (minus `.env` and `data/`) and
running `docker compose up -d --build`; the API applies its own migrations on boot.

Three things about it shape the client:

- **The app never sees a Google token.** It opens a browser, polls `/auth/poll`, and receives a
  device token minted by the sync API. Tokens are stored server-side as hashes and are revocable per
  device via `/v1/devices`.
- **Sync is delta-based on a server cursor**, and deletes are tombstones. A client that has been
  offline for weeks catches up with `GET /v1/sync?since=<cursor>`; it must honour `deleted: true`
  rows or it will resurrect objects the user removed elsewhere.
- **SSH private keys are end-to-end encrypted before they leave the machine.** The server stores
  opaque `ciphertext` + `nonce` and cannot read them; everything else syncs as plaintext JSON. The
  master key lives in the OS keychain and reaches a new device by pairing: the six digits the user
  compares are **derived from both devices' ephemeral public keys**, never generated by the server,
  so a server that swapped a key would make the digits disagree.

### Build pipeline quirk

`vite.config.js` builds `electron/main.js` and `electron/preload.js` into `dist-electron/`, but
nothing loads them: `package.json` `main` points at `electron/main.js`, `main.js` resolves preload as
`__dirname/preload.js`, and electron-builder's `files` list ships `electron/**/*` without
`dist-electron`. Both dev and packaged builds run the CommonJS sources directly. Editing
`dist-electron/` output has no effect.

Native modules (`ssh2`, `node-pty`) are marked external in the Vite config and rebuilt against
Electron's ABI by the `postinstall` hook.

## Roles (subagents)

Delegate with Task/Agent. Each role reads this file plus its own
`.claude/roles/<role>.md` on birth, and must write and commit that memory file
before delivering.

| Role | Use it for | Not for |
|---|---|---|
| `roles:explorador` | "Where is X", "how does Y work" — read-only, keeps search out of the orchestrator's context | Anything that changes a file |
| `roles:dev-backend` | The main process: services, IPC handlers, ssh2/node-pty/sftp, JSON persistence | The renderer |
| `roles:dev-frontend` | The renderer: React components, `AppContext`, terminal views | Main-process logic |
| `roles:disenador` | Design tokens in `index.css`, dark/light parity, terminal color schemes | Features |
| `empaquetador` | electron-builder config, native module ABI, universal binaries, signing, the update channel | App logic or UI |

`empaquetador` is defined locally in `.claude/agents/`, so it exists only in
this project; the other four come from the `roles` plugin.

**Main is CommonJS, the renderer is ESM, and neither can import the other.** If a
constant has to exist on both sides it gets duplicated, and whoever is given that
task owns *both* copies. Never split a duplicated pair between two roles: the
halves drift silently and nothing in the build catches it.

## Releasing

`electron-updater` checks GitHub Releases on startup (5s delay) and surfaces the result in
Settings → About. In dev the updater IPC handlers are registered as stubs so that panel doesn't
crash. Publishing: bump `version` in `package.json`, build, then `gh release create` with the
artifacts from `release/`.

### Android (same release as desktop)

`npm run android:apk` builds the signed arm64 APK and its feed into `release/`:
`Termilab-<v>-android-arm64.apk` + `latest-android.json` `{version, versionCode, file, sha256, size}`.
Upload **both** to the same GitHub release as the desktop artifacts: the app fetches
`releases/latest/download/latest-android.json` 5 s after launch (and from Settings → About),
404 = up to date. versionCode = `major*1e6 + minor*1e3 + patch` of `package.json` — minor and
patch must stay ≤ 999. The script fails on an unsigned or debug-signed APK and checks
`apksigner`, `zipalign -c -P 16` and the 16 KB LOAD alignment of every `.so`.

Signing: `mobile/android/app/build.gradle` reads env `TERMILAB_KEYSTORE_FILE` +
`TERMILAB_KEYSTORE_PASSWORD` (+ `TERMILAB_KEY_ALIAS`, `TERMILAB_KEY_PASSWORD`), else a
`keystore.properties` from `TERMILAB_KEYSTORE_PROPERTIES`, `~/.config/termilab/`, or
`mobile/android/` (gitignored). The keystore is `~/.config/termilab/termilab-release.jks`.

> **Lose the keystore (or its password) and no installed Termilab can ever update again**:
> Android refuses an update signed with another key, so every user would have to uninstall
> (losing local data) and reinstall. Back up `termilab-release.jks` **and**
> `keystore.properties` to the owner's password manager and to an offline copy. Never commit
> them, never print the password. Note `~/.config/termilab/` is also the desktop app's
> `userData`: wiping the desktop app's data there wipes the keystore too.

The `updateTest` build type (release + debuggable, `TERMILAB_BUILD_TYPE=updateTest`) exists
only to test the updater end to end with `am start ... --es TERMILAB_UPDATE_URL <feed>`;
release builds ignore that extra. Never publish an `updateTest` APK.
