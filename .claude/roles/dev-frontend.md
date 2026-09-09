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
