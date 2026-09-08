# Memoria del rol: dev-frontend — Termilab

## Verificación: el único portero es `npm run build`

No hay tests, ni linter, ni typecheck. `npm run build` **solo** falla por errores
de sintaxis o por un import que no resuelve. Variables sin usar, props muertas y
handlers huérfanos pasan en verde. Si borras código, el build no te va a avisar
de lo que quedó colgando: hazlo tú con `grep -rn` sobre `src/`.

Ojo con `grep` en zsh: `--include=*.jsx` sin comillas revienta con "no matches
found" antes de llegar a grep.

## Trampas del layout que no se leen en el código

- `.terminal-bottom-bar` es `justify-content: space-between`. Al quitar la barra
  de IA se quedó con dos hijos, así que los botones de Log saltaron de en medio
  al extremo derecho. No está roto — pero si alguien reporta "el botón Log se
  ha movido", es esto. Meter un tercer hijo lo vuelve a repartir.
- `.terminal-wrapper` es `flex: 1` dentro de un contenedor en columna, y el
  refit del xterm cuelga de un `ResizeObserver` sobre el contenedor. Por eso
  añadir o quitar paneles hermanos (el de IA, por ejemplo) no requiere tocar
  alturas a mano: el alto se recalcula solo.
- `.settings-info-box` en `Settings.css` es CSS muerto, y ya lo era antes de
  quitar la IA. Lo dejé ahí a propósito para no meter ruido; no pierdas el rato
  buscando quién lo usa.

## Media res: exportar purga las keys, importar no

`Settings.jsx#handleExportData` ya excluye `ai` de `state.settings` (requisito
explícito de Derek: un `settings.json` viejo guarda las API keys en claro y el
backup las volcaba tal cual).

**`handleImportData` sigue aplicando `data.settings` entero** — `SET_SETTINGS`
más el guardado en el store. Un backup antiguo que traiga `ai` vuelve a escribir
esas claves en `settings.json`. Se dejó así porque el encargo era solo el
export; si alguien retoma la fuga, es ahí, en el mismo archivo.

## Estado de la IA en el renderer (tras `feat/sync-sin-ia`)

No queda nada: ni `AIAssistant/`, ni las clases `tai-*`, ni la pestaña de
Settings, ni `src/config/` (esa carpeta **solo** contenía `aiModels.js` y
`commandSafety.js`, así que desapareció entera).

Consecuencia para quien lea el `CLAUDE.md`: la tabla de "módulos duplicados a
través de la frontera de procesos" y la sección "AI assistant command safety"
describen archivos del renderer que ya no existen. Compruébalo antes de fiarte.

## Props fantasma en `SplitPane`

`App.jsx` monta `<SplitPane tab={tab} />` a secas. Cualquier prop que `SplitPane`
declare y reenvíe a `TerminalView` llega como `undefined` y el código que la
consume parece vivo sin serlo (así estuvo `registerTerminal`/`onRegister`).
Antes de conservar una prop de `SplitPane`, mira quién la pasa desde `App.jsx`.
