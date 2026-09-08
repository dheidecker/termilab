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

Channels are namespaced `domain:action` (`ssh:connect`, `sftp:list`, `store:save-host`, `ai:chat`).
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

### Modules deliberately duplicated across the process boundary

Main is CommonJS and cannot import the renderer's ES modules, so two files exist twice and **must be
kept in sync**:

| Main (CJS) | Renderer (ESM) |
|---|---|
| `electron/services/command-safety.js` | `src/config/commandSafety.js` |
| `electron/services/ai-models.js` | `src/config/aiModels.js` |

For AI models this is enforced asymmetrically: `store-service` validates saved settings against
main's `VALID_MODELS`, so a model ID that exists only in the renderer catalog gets silently migrated
away on load. Add IDs to both.

### AI assistant command safety

`classifyCommand()` decides whether a shell command is destructive. It gates two things at once: the
warning the UI shows, and whether the command may auto-execute. **Destructive commands never run
automatically in any mode** — not in Auto-Approve, not in Autonomous; they render with an
"Approve & Run" button. The classifier is deliberately biased toward false positives.

Three modes live in `src/components/AIAssistant/AIAssistant.jsx`: `ask`, `auto-approve` (safe
commands, one round per message), `autonomous` (loops, with a max-rounds cap). The model emits
runnable commands in ` ```bash:run ` fences; plain ` ```bash ` fences are display-only.

Providers (Claude, DeepSeek, OpenAI) are a table in `ai-service.js` — each entry supplies
`buildHeaders` / `buildBody` / `parseResponse`. Claude 5 models think by default, reject
`temperature`/`top_p`, and take `output_config.effort` instead; their responses put thinking blocks
before text, so `parseResponse` filters for `type === 'text'` rather than reading `content[0]`.

### Build pipeline quirk

`vite.config.js` builds `electron/main.js` and `electron/preload.js` into `dist-electron/`, but
nothing loads them: `package.json` `main` points at `electron/main.js`, `main.js` resolves preload as
`__dirname/preload.js`, and electron-builder's `files` list ships `electron/**/*` without
`dist-electron`. Both dev and packaged builds run the CommonJS sources directly. Editing
`dist-electron/` output has no effect.

Native modules (`ssh2`, `node-pty`) are marked external in the Vite config and rebuilt against
Electron's ABI by the `postinstall` hook.

## Releasing

`electron-updater` checks GitHub Releases on startup (5s delay) and surfaces the result in
Settings → About. In dev the updater IPC handlers are registered as stubs so that panel doesn't
crash. Publishing: bump `version` in `package.json`, build, then `gh release create` with the
artifacts from `release/`.
