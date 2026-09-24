# Memoria del rol: dev-frontend — Termilab

## Verificación: el único portero es `npm run build`

No hay tests, ni linter, ni typecheck. `npm run build` **solo** falla por errores
de sintaxis o por un import que no resuelve. Variables sin usar, props muertas y
handlers huérfanos pasan en verde. Si borras código, el build no te va a avisar
de lo que quedó colgando: hazlo tú con `grep -rn` sobre `src/`.

Ojo con `grep` en zsh: `--include=*.jsx` sin comillas revienta con "no matches
found" antes de llegar a grep.

### Sí se puede renderizar sin navegador ni jsdom

`react-dom/server` está instalado y `AppContext.jsx` hace `export default
AppContext`, así que puedes inyectar el estado que quieras sin el provider real:

```
npx esbuild harness.jsx --bundle --platform=node --format=cjs \
  --loader:.css=text --external:react --external:react-dom/server --outfile=h.cjs
NODE_PATH=<proyecto>/node_modules node h.cjs
```

`renderToStaticMarkup(<AppContext.Provider value={{state, dispatch, actions}}>…)`
con `actions = new Proxy({}, {get: () => () => Promise.resolve({})})` recorre
todas las ramas de un componente y caza los crashes de render. Pon el harness
fuera del repo, pero con rutas absolutas a `src/` y con `import`, **no
`require`**: un `require(VAR + '/x.jsx')` esbuild no lo resuelve, lo deja para
runtime y Node revienta con `Unexpected token '<'`.

**No ejecuta efectos.** Lo que llega de una acción IPC (la lista de
`pairingPending()`, por ejemplo) nunca sale por sí solo. Se inyecta parcheando
`useState` **por orden de llamada**:

```js
const real = React.useState;
React.useState = (init) => { const [v, s] = real(init);
  return overrides && cursor < overrides.length ? [overrides[cursor++] ?? v, s] : (cursor++, [v, s]); };
```

Funciona porque esbuild emite `import_react.useState(...)` (lectura de
propiedad en cada llamada) y su helper `__toESM` copia con *getters* que
delegan en el módulo real: parchear `react` alcanza a todos los módulos. Hay
que contar los `useState` del componente en orden; si alguien añade uno en
medio, el harness miente sin fallar. Deja el orden apuntado en el propio
harness.

### Y sí se puede *mirar*: Chrome headless + Read

Hay `/Applications/Google Chrome.app`. Volcando el markup del harness a un
`.html` con `<link>` a `src/index.css` y al CSS del componente:

```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --disable-gpu --hide-scrollbars --virtual-time-budget=1500 \
  --window-size=720,2100 --screenshot=x.png file:///.../x.html
```

y luego `Read` del PNG. Es la única forma que he encontrado de ver de verdad
jerarquía visual y paridad de temas sin abrir Electron (para el tema hay que
poner `data-theme` en `<html>`, que es lo que hace `AppContext`). Envuelve el
markup en `.settings-panel > .settings-content > .settings-section`, que es
donde vive el panel de sync, o los fondos no se componen igual.

Para *medir* contraste sigue siendo mejor el script: parsea los tokens de
`index.css` (`:root` y `:root[data-theme='light']`), compón los `rgba` sobre su
fondo y calcula WCAG. Trampa cara: `sync-text-dim` (`--text-tertiary`) sobre dos
capas apiladas de `--overlay-subtle` (tarjeta dentro de tarjeta) baja a
**3.5:1 en oscuro**. Para una línea que dice qué hacer, usa `--text-secondary`
(5.2:1). El borde de `.sync-digit` da 1.3:1: es decorativo, no lo "arregles".

## Trampas de React que este proyecto tiene activas

- **StrictMode está puesto** en `main.jsx`: en dev cada efecto se monta, se
  limpia y se vuelve a montar. `useEffect(() => () => { mounted.current = false }, [])`
  deja el ref en `false` para siempre en la segunda pasada y **ningún**
  `if (!mounted.current) return` vuelve a dejar pasar un `setState`. Hay que
  ponerlo a `true` al montar. Un ref "ya lo hice" (`requested.current`) sí
  sobrevive a ese doble montaje, y es la forma de no duplicar una llamada IPC
  con efectos secundarios.
- `actions` de `useApp()` es un objeto literal nuevo en cada render. Si lo metes
  en las deps de un efecto, bucle infinito. Desestructura los miembros (todos
  son `useCallback`) y pon esos en las deps.
- Por lo mismo, pasa **primitivos** (`lastSyncAt`, `pendingPairings`) a los
  hijos que recargan con `useEffect`, no el objeto de estado entero.

## Props fantasma en `SplitPane`

`App.jsx` monta `<SplitPane tab={tab} />` a secas. Cualquier prop que `SplitPane`
declare y reenvíe a `TerminalView` llega como `undefined` y el código que la
consume parece vivo sin serlo (así estuvo `registerTerminal`/`onRegister`).
Antes de conservar una prop de `SplitPane`, mira quién la pasa desde `App.jsx`.

## Trampas del layout que no se leen en el código

- `.terminal-bottom-bar` es `justify-content: space-between`. Al quitar la barra
  de IA se quedó con dos hijos, así que los botones de Log saltaron de en medio
  al extremo derecho. No está roto — pero si alguien reporta "el botón Log se
  ha movido", es esto.
- `.terminal-wrapper` es `flex: 1` dentro de un contenedor en columna y el refit
  del xterm cuelga de un `ResizeObserver`: añadir o quitar paneles hermanos no
  requiere tocar alturas a mano.
- `.settings-info-box` en `Settings.css` es CSS muerto y ya lo era antes de
  quitar la IA. No pierdas el rato buscando quién lo usa.

## Sync (lo que el contrato de IPC no cuenta)

El contrato que te den y lo que hace `electron/services/sync-service.js` no
coinciden en tres puntos, y los tres cambian la interfaz:

1. **`pairing.request()` devuelve `digits: null`.** Los seis dígitos se derivan
   de las claves efímeras de *ambos* equipos, así que el equipo que pide no los
   conoce hasta que el otro contesta; llegan luego en el push de estado, en
   `status.pairing = {id, digits, state}` (campo extra, fuera del contrato).
   `status.pairing` pasa a `null` cuando el emparejamiento muere o se completa.
2. **`pairing.claim(id)` no es un sondeo.** Bloquea hasta 30 s esperando al otro
   lado y luego **instala la clave maestra**; si el otro no ha confirmado lanza
   ("todavia no ha confirmado", "rechazo", "caduco"). Llamarlo en bucle cada 3 s
   apila llamadas de 30 s y, peor, instala la clave sin que nadie haya comparado
   los dígitos. Se llama cuando el usuario dice que coinciden, y solo entonces.
3. **La ventana de comparación ya no está invertida** (lo estuvo, y era un
   agujero real: quien aprobaba soltaba la clave sin poder comparar). Hoy el
   protocolo tiene dos pasos y la interfaz vive de ellos:
   - Quien aprueba: `approve(id)` es **solo el paso 1** (publica la pública) y
     resuelve `{state, digits}`; `confirm(id)` es el paso 2 y **la única llamada
     que saca la clave maestra**. Sin el botón de confirm el otro equipo espera
     para siempre.
   - Quien pide: `state === 'verificar'` = dígitos en las dos pantallas y clave
     maestra todavía dentro. `'pendiente'` es solo "el otro no ha aceptado aún".
     Los cinco estados: `pendiente`, `verificar`, `listo`, `rejected`, `expired`.
   **No juntes los dos pasos.** El servidor da 409 y esa comodidad es el fallo
   entero.

Tres cosas más que no se leen en el código y que alguien va a querer "arreglar":

- **Las entradas de `pending()` traen `digits` ya en `'pendiente'`** (el que
  aprueba las deriva en local con `pub_new`). La interfaz **las esconde a
  propósito** hasta `'aceptado'`: enseñarlas antes invita a comparar contra una
  pantalla que todavía no muestra nada, y eso enseña al usuario a decir que sí
  sin mirar. No es un bug.
- **El que pide no tiene forma de rechazar.** `pairing.reject` es del lado que
  aprueba; en `PairingClaim` el "no coinciden" solo para en local (nunca llama a
  `claim`, así que la clave no se instala) y manda rechazar en el otro equipo.
  Si quieres un rechazo de verdad desde ahí, hace falta un canal nuevo: es
  trabajo de `dev-backend`, no lo improvises con el canal del otro lado.
- **Tras un 409 en `confirm`, el main deja la aprobación en `'pendiente'` con su
  efímera cacheada**: aceptar otra vez da **los mismos seis dígitos**. Por eso
  la tarjeta se queda en pantalla en vez de recargar la lista; recargar en ese
  punto puede vaciarla y el usuario cree que perdió el emparejamiento.

Además: `preload.removeStatusListener()` hace `removeAllListeners('sync:status')`
e ignora el argumento. **Solo puede haber un suscriptor en todo el renderer**, y
está en `AppContext`; si un componente se suscribe también, su desmontaje deja
sorda a la app entera. Consume el estado desde `state.sync`, no te suscribas.

**El texto de la pantalla de comparación es parte de la criptografía**, y es
requisito explícito de Derek, no gusto mío: los dígitos son lo más grande de la
pantalla en los dos equipos; el botón dice que **coinciden** (nunca "continuar"
ni "aceptar"); rechazar cuesta un clic, igual que aceptar; una línea dice que un
desajuste significa que hay alguien en medio; y se dice qué se autoriza
(descifrar claves SSH **y contraseñas de hosts**). Si alguien "simplifica" ese
copy, ha quitado la mitad humana de la protección.

`secretsWithheld` / `secretsBlocked` del estado cuentan **campos, no hosts**:
un host puede aportar contraseña y passphrase. No escribas "N hosts".

Los mensajes de error del proceso main llegan **en español** ("Sesion caducada o
dispositivo revocado") y se pintan tal cual en los banners, mientras que el resto
de la interfaz está en inglés (no hay ni una cadena en español en `src/`).
Decidí mantener el panel en inglés por coherencia; si Derek quiere español, es
traducir toda la app, no solo este panel.

## Color: no "arregles" el botón primario

`--accent-contrast` (#fff) sobre `--accent` da 2.5:1 en oscuro con el acento por
defecto. Es la convención de toda la app (`settings-test-btn`, `Titlebar`,
`WelcomeScreen`, `UpdateNotification`) y en claro `AppContext` oscurece el acento
y sube a 5.2:1. Divergir solo en un componente se ve peor que el problema.
El resto de combinaciones que uso en `Sync.css` están por encima de 4:1 en los
dos temas.

## Las API keys de IA: la fuga está cerrada, y no solo por el export

`Settings.jsx#handleExportData` excluye `ai` de `state.settings` (requisito
explícito de Derek: un `settings.json` viejo guarda las API keys en claro y el
backup las volcaba tal cual).

`handleImportData` **sí** sigue aplicando `data.settings` entero, así que un
backup antiguo con `ai` entra en el estado de React. Parece una fuga y no lo es:
`store-service.saveSettings()` hace `delete merged.ai` sin condiciones antes de
escribir. El bloque vive en memoria hasta recargar la app, no se persiste ni se
reexporta. Si vas a "arreglar" el import, ten claro que arreglas eso.

## Layout tipo Termius (rama `feat/ui-termius`)

- **La pestaña home no está en `state.tabs`**: es lo que se ve cuando
  `activeTabId` no corresponde a ninguna pestaña (`goHome()` lo pone a `null`).
  `homeActive = !tabs.some(t => t.id === activeTabId)` vive en `App` y en
  `TabBar`; si cambias uno, cambia el otro.
- Home (sidebar + sección) y sesiones están **montadas a la vez** y se alternan
  con `display`: búsqueda y grupo abierto en Hosts sobreviven al cambiar de
  pestaña; al cambiar de sección del sidebar se pierden (se desmonta).
- Keychain/Port Forwarding/Snippets nacieron como panel de 280px; van dentro de
  `.app-section-column` (max 760px) o sus botones `width:100%` se estiran.
- `parseQuickConnect` devuelve `null` sin `@`: la barra de Hosts es búsqueda y
  quick connect a la vez; "web" no debe conectar a root@web.

### Capturas con interacción (Linux)

Chrome está en `/opt/google/chrome/chrome`. Para clicar/hover antes de capturar:
`npm run build`, servir `dist/` con `python3 -m http.server`, Chrome headless con
`--remote-debugging-port`, y CDP con el `WebSocket` global de Node 24
(`Runtime.evaluate` → `.click()`, `Input.dispatchMouseEvent` → hover,
`Page.captureScreenshot`). `vite` a secas no sirve: arranca Electron. Tema claro:
`data-theme='light'` en `<html>` más el `--accent` sombreado a mano.

## Known Hosts, Logs y el diálogo de clave de host (2026-09)

- `HostKeyPrompt` (montado en `App`) es el **único** suscriptor de
  `ssh:host-key-prompt`/`-cancel`; no está en `ssh.removeAllListeners`. Si un
  recargado completo del renderer ocurre con un aviso abierto, el aviso se
  pierde y main rechaza a los 120 s (la pestaña se queda en "Connecting").
- Para `changed` el foco va a **Cancel** y el botón rojo dice "Replace key &
  connect": es requisito, no estilo.
- Known hosts y logs **no** viven en el estado de `AppContext`: cada sección los
  pide al montar (`listKnownHosts`, `listConnectionLogs`). Logs recarga cuando
  cambia el nº de sesiones/pestañas (main escribe en diferido).
- `displayHost` está duplicado en `KnownHosts/format.js` y
  `electron/services/known-hosts.js`. El color de host salió de `HostList` a
  `HostList/hostColor.js` (lo usan Hosts y Logs).
- Captura del diálogo: en modo mock no hay `electronAPI`, así que no puede venir
  de main; se renderiza `HostKeyDialog` con `react-dom/server` y se inyecta por
  CDP en la página de `dist/`. Ojo: heredoc sin comillas + backticks de JS =
  sustitución de comandos de bash; usa `<<'EOF'`.

## Port forwarding y ViewOptions (2026-09)

- `state.portForwardStatus` (ruleId → {state, error}) tiene **un** suscriptor,
  en `AppContext`. Las reglas no llevan `active`; `startPortForward(ruleId)`
  nunca lanza (el fallo queda como `error`). Un efecto para lo que siga en
  marcha si su regla desaparece (un pull de sync la borró).
- `src/components/PortForwarding/rules.js` es copia de
  `electron/services/port-forward-rules.js`: se cambian juntas.
- **Choque de nombres de clase**: `pf-card-${state}` daba `pf-card-error`, que
  ya era la línea de texto del error (y en lista `display:none` escondía la
  tarjeta entera). El estado va en `pf-state-*`.
- `.hv-menu { left: 0 }` de HostList.css se carga **después** del CSS del
  componente (orden de import): a igual especificidad gana y el menú se sale
  por la derecha. Por eso `.hv-menu.vo-menu`.
- `ViewOptions` (View/Tags/Sort) se usa en Hosts, Port Forwarding y Known
  Hosts. Hosts mantiene la clave vieja `termilab.hosts.view`; el filtro de tags
  no se persiste. Menús: mousedown fuera, Esc devuelve el foco al botón.

## Revisión 2026-09 (host key y OS)

- `HostKeyPrompt`: `reason` puede ser `'new-key-type'` (host conocido solo por
  otros tipos de clave). Se pinta como `'changed'`: aviso, foco en Cancel,
  botón rojo "Add key & connect", y las huellas guardadas de
  `knownFingerprints` [{keyType, fingerprint}]. Aceptar agrega, no reemplaza.
  `'unknown'` ya no trae `knownTypes`.
- El OS detectado se guarda con `store.setHostOs(hostId, os)` (main escribe
  solo `os` bajo lock y devuelve el host o null). No vuelvas a
  `saveHost({...fresh, os})`: pisaba lo que un pull de sync acababa de
  escribir (contraseña incluida) y lo subía. El arnés K15 mira el fuente.

## Android (fases 1–2, 2026-09)

- `src/platform.js`: `IS_ANDROID` y `FEATURES`. Todo flag es `true` en escritorio; gatea
  con `FEATURES.x &&`, no con el atributo `hidden` (un `display:flex` del CSS lo pisa).
- En Android `window.electronAPI` **no tiene** `sftp`, `portForward`, `localShell`,
  `window` ni `dialog`: una entrada sin gatear revienta, a propósito.
- `mobile/web/entry.jsx` instala el shim y luego `import()` de `src/main.jsx`: los
  imports estáticos se elevan y varios módulos leen `electronAPI` al evaluarse.
- CSS solo-Android en `mobile/web/mobile.css` (el desktop nunca lo carga). Se importa
  ANTES que `src/index.css`: a igual especificidad gana src.
- Probar en el emulador: `adb shell input text` escribe; KEYCODE_BACK cierra la app.

## Android fase 3 (2026-09-24)

- **Botón atrás = `src/hooks/useBackHandler.js`.** Todo lo que se abre y se cierra (modal,
  drawer, menú, búsqueda, grupo abierto) registra `useBackHandler(abierto, cerrar)`; lo más
  reciente se cierra primero. Debajo va `useBackFallback` de `App` (sidebar → plegado,
  sesión → Hosts, sección → Hosts). Si nadie lo toma, `entry.jsx` hace `exitApp`
  (moveTaskToBack). **Un modal nuevo sin `useBackHandler` hace que atrás salte de sección
  con el modal abierto.** En HostList los handlers van con `onHome` (desde una pestaña de
  sesión atrás va a Hosts, no cierra un grupo que no se ve).
- **El teclado raw es solo del textarea de xterm** (`.xterm-helper-textarea`): `entry.jsx`
  avisa a Java en focusin/focusout. Si cambia esa clase o la terminal usa otro input, la
  terminal vuelve al teclado predictivo ("holalaa").
- Capacitor encoge el WebView con el teclado (padding del IME en la decor view); `100vh`
  sigue al WebView. El campo enfocado se centra con `scrollIntoView` desde `entry.jsx`.
- CDP en el emulador para mirar/pulsar: `adb forward tcp:9333
  localabstract:webview_devtools_remote_<pid>` + `Runtime.evaluate` (envuelve en IIFE: el
  ámbito global persiste y un `const` repetido da SyntaxError). Toques de Gboard reales con
  `input tap`; acentos con `input motionevent DOWN` en la o, esperar, `MOVE`+`UP` sobre la ó.
  `adb shell input text` con no-ASCII revienta dentro de `input` y no prueba nada.

## Android fase 4: UI móvil (2026-09-24)

- **En Android `App` monta otro árbol** (rama `if (IS_ANDROID)` en `App.jsx`): sin Titlebar,
  TabBar ni Sidebar; `MobileNav` abajo y `renderMobileSection()`. `activeSection` admite
  `sessions` y `more`; `MORE_SECTIONS` (MobileNav.jsx) decide qué ilumina More y adónde va atrás.
  Una sección nueva que deba verse en Android va en los dos `renderSection`.
- **CSS en dos sitios:** componentes solo-Android (`m-*`) en `src/components/Mobile/Mobile.css`
  (el bundle de escritorio lo carga, pero ninguna clase coincide); retoques de componentes
  compartidos en `mobile/web/mobile.css`, **siempre** con prefijo `html[data-platform='android']`
  (lo pone `entry.jsx`): así nunca llegan al escritorio y ganan en especificidad aunque ese
  archivo cargue antes.
- **Paridad de escritorio = `cmp` de PNG**: `desk-shots.mjs` (scratchpad de la sesión) hace 7
  capturas de `dist/` con Chrome headless por CDP; son deterministas (dos pasadas iguales byte a
  byte), así que antes/después idénticos prueba que el escritorio no cambió. Ojo con los
  selectores en lista: `querySelector('.a, [aria-label="Close"]')` devuelve el primero **del
  documento** (el botón de cerrar la ventana), no el del primer selector.
- **Una expresión JSX al principio de línea se come el espacio**: "two\n  {MACHINES}" = "twocomputers".
  Al cambiar palabras de un texto por constantes, `{' '}{X}` en esos casos (y revisar los de final
  de línea).
- **Terminal:** las teclas extra entran por `term.input(seq, true)`, que dispara `onData` de forma
  síncrona: el mismo camino que teclear (broadcast incluido). `bypassRef` evita que los Ctrl/Alt
  pegajosos (que modifican lo que teclea el teclado, en `inputFilterRef`) se apliquen dos veces.
  Botones de la fila: `onMouseDown={preventDefault}` y la acción en `onClick`, o el textarea pierde
  el foco y el teclado se cierra en cada tecla.
- `navigator.clipboard.readText()` → `NotAllowedError` en el WebView: `mobile/clipboard.js` cae a
  `window.__termilabNative.readClipboard()` (el plugin; `src/` nunca importa Capacitor).
- La pulsación larga del WebView desenfoca el textarea: teclado fuera → filas cambian → xterm borra
  la selección. `user-select:none` + `touch-callout:none` en `.terminal-wrapper` hacen que la
  selección sobreviva. Al encoger filas xterm no sigue el prompt: `onResize → scrollToBottom`.
- Para mirar la terminal por CDP: `document.querySelector('.terminal-wrapper').__xterm` (solo
  Android). Pellizco sin dedos: `Input.dispatchTouchEvent` con dos `touchPoints`.
- **Probar de verdad (vim, top, historial)** necesita un shell real: `scripts/lib/ssh-test-server.js`
  es un shell de juguete. Un `sshd` de OpenSSH sin root vale: `-f` con `HostKey`, `PidFile`,
  `AuthorizedKeysFile` propios, `UsePAM no`, `StrictModes no`, `ListenAddress 127.0.0.1`, puerto
  2222; el emulador lo ve en `10.0.2.2`. La clave privada se mete con
  `electronAPI.store.pasteKey({name, privateKeyContent})` por CDP.
- `pkill -f <patrón>` dentro de un comando que contiene ese patrón se mata a sí mismo (exit 144).
