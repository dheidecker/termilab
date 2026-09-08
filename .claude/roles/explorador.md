# Memoria del rol: explorador — Termilab

## El asistente de IA está implementado dos veces, y una está muerta

- **`src/components/AIAssistant/AIAssistant.jsx` (y su CSS) es código muerto**:
  nadie lo importa, ni estática ni dinámicamente. No pierdas tiempo leyéndolo
  para responder cómo se comporta la IA de verdad.
- **La IA viva es una segunda implementación inline** en
  `src/components/Terminal/TerminalView.jsx` — estado en `:399-608`, render en
  `:689-872`. Es la barra "AI" del pie del terminal.
- En la ruta viva hay **dos** modos (selector Auto/Manual, `:847-859` → mapeados
  a `auto-approve`/`ask`), no tres. `ai.defaultMode` que guarda Settings
  (`Settings.jsx:541-548`) **no lo lee nadie vivo**, y `autonomous` es
  inalcanzable.
- `TerminalView.jsx:130-131` (`onRegister`, "Register terminal for AI access")
  es un no-op: `App.jsx:108` monta `<SplitPane>` sin la prop `registerTerminal`.
  Era el puente al componente huérfano.

## Trampas del proceso main

- `webviewTag: true` en `electron/main.js:33` existe **solo** por el `<webview>`
  del componente muerto. No hay otro `<webview>` en el proyecto.
- El proveedor `'claude-web'` (`AIAssistant.jsx:98`) no está en `PROVIDERS` de
  `src/config/aiModels.js:10-14`, y `_migrateAiSettings`
  (`store-service.js:151-163`) **valida modelos y effort pero nunca
  `provider`** — un valor obsoleto persiste indefinidamente.
- `removeIpcHandlers` (`ipc-handlers.js:373-395`) usa una lista fija, y
  `ipcMain.removeHandler` sobre un canal no registrado es no-op. Se pueden
  condicionar registros sin tocar esa lista.

## Otras cosas que ahorran una búsqueda

- No existe infraestructura de feature flags ni uso de `import.meta.env` en el
  renderer. `src/config/` solo tiene `aiModels.js` y `commandSafety.js`.
- Las API keys de IA no están en los defaults del store: nacen al escribirlas,
  con los nombres de `PROVIDERS[].keyField`. Salen **en claro** en el backup de
  `Settings.jsx:99-118`, que vuelca `state.settings` entero.
- `MOCK_SETTINGS` (`AppContext.jsx:31`) no incluye `ai`, así que sin Electron la
  barra responde "No API key configured".
- `Settings.jsx` arranca en la pestaña `general` y solo la cambian los botones
  de `TABS.map` (`:188`). No hay deep-link: filtrar la entrada del array hace el
  panel inalcanzable.
