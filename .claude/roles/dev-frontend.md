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
todas las ramas de un componente y caza los crashes de render. **No ejecuta
efectos**, así que los hijos salen en su estado de carga: eso no lo cubre.
Pon el harness fuera del repo, pero con rutas absolutas a `src/` (esbuild
resuelve `react` desde el directorio del *entry*, de ahí los `--external`).

Para el tema claro no hace falta ver la pantalla: parsea los tokens de
`index.css` (`:root` y `:root[data-theme='light']`), compón los `rgba` sobre su
fondo y calcula el contraste WCAG. Es lo único que caza "texto ilegible en
claro" sin abrir la app.

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
   Los estados vienen en español: `pendiente`, `listo`, `rejected`, `expired`.
   `status.pairing` pasa a `null` cuando el emparejamiento muere o se completa.
2. **`pairing.claim(id)` no es un sondeo.** Bloquea hasta 30 s esperando al otro
   lado y luego **instala la clave maestra**; si no ha habido aprobación lanza
   ("todavia no ha aprobado", "rechazo", "caduco"). Llamarlo en bucle cada 3 s
   apila llamadas de 30 s y, peor, instala la clave sin que nadie haya comparado
   los dígitos. Se llama cuando el usuario confirma que coinciden.
3. **La comparación de dígitos está invertida respecto a lo que uno espera.**
   El equipo que aprueba deriva los dígitos en `pairingPending()` y los ve
   *antes*; el que pide solo puede verlos *después* de que el otro apruebe,
   porque `pub_existing` no existe en el servidor hasta el `/complete`. O sea:
   quien aprueba no puede comparar contra la otra pantalla antes de soltar la
   clave sellada. La interfaz lo dice tal cual ("compruébalo justo después y
   revoca si no coincide"); **arreglarlo es cosa del protocolo, no del
   renderer** — está reportado, no lo silencies con copy optimista.

Además: `preload.removeStatusListener()` hace `removeAllListeners('sync:status')`
e ignora el argumento. **Solo puede haber un suscriptor en todo el renderer**, y
está en `AppContext`; si un componente se suscribe también, su desmontaje deja
sorda a la app entera. Consume el estado desde `state.sync`, no te suscribas.

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
