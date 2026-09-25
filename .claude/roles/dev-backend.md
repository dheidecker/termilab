# Memoria del rol: dev-backend — Termilab

## `npm run build` NO valida el proceso main

Es la trampa más cara de este repo. `vite.config.js` compila `electron/main.js`
y `electron/preload.js` con todos los `require` locales como externos: el bundle
sale de ~3 kB y `ipc-handlers.js` y `services/*` ni se leen. Puedes borrar un
servicio que main sigue requiriendo y el build pasa en verde; revienta al abrir
la app.

Verifica el main a mano, siempre:

```bash
for f in electron/main.js electron/preload.js electron/ipc-handlers.js electron/services/*.js; do node --check "$f"; done
```

Y para cargar el grafo entero (detecta `require` a archivos borrados, que
`node --check` no ve), stubea `electron` con `Module._load` y requiere
`ipc-handlers.js`; con eso basta, arrastra todos los servicios.

### El arnés ya existe: `scripts/check-main.js`

`node scripts/check-main.js` (sin argumentos, sin red, sin Electron). Hace
`node --check` de todo `electron/`, carga el grafo entero con `electron`
stubeado, comprueba que ningún `invoke('canal')` de `preload.js` se quede sin
handler, y corre sincronizaciones **de verdad** contra un `http.createServer`
local con `TERMILAB_SYNC_URL`. **Amplíalo en vez de reescribirlo.** No está en
`package.json` a propósito: `scripts/` no se empaqueta.

Detalles del stub que costaron intentos:

- `app.getPath()` → un `mkdtemp`, y hay que stubearlo **antes del primer
  `require`**: `store-service` calcula `this.dataDir` en el **constructor**, y
  el singleton se crea al requerir el módulo (`crypto-service` y `sync-service`
  sí lo resuelven perezosamente).
- El `BrowserWindow` falso necesita `on()`, `isDestroyed()` y
  `webContents.send()`: `registerIpcHandlers` engancha eventos y `_emitStatus`
  llama a `isDestroyed()` en cada sync.
- Los canales `updater:*` los registra `main.js` (stubs de dev), **no**
  `ipc-handlers.js`: al comparar contra preload hay que excluirlos o salen como
  "sin handler" falsos.
- Cuando toques el arnés, valídalo con un **control negativo**: rompe la
  protección a propósito y comprueba que se pone rojo. Un arnés de seguridad que
  no falla cuando quitas la protección no está probando nada. Hazlo sobre una
  **copia** (`cp -R electron scripts /tmp/x` + `ln -s` de `node_modules`, o el
  grafo revienta con `Cannot find module 'ssh2'` y enrojece todo por el motivo
  equivocado), no sobre el árbol compartido.

## `git add` de un archivo ya borrado falla; `git commit -- <rutas>` no

En un árbol compartido con otro agente no puedes usar `git add -A` ni
`git commit -a`. Y `git add electron/services/borrado.js` da
`fatal: pathspec did not match any files` cuando el archivo ya no está en el
worktree. La forma que funciona sin tocar lo de nadie es saltarse el índice:

```bash
git commit -m "..." -- electron/ruta-a.js electron/ruta-b.js
```

Commitea el estado del worktree de esas rutas (incluidas borradas) y **deja
intacto lo que el otro agente tenga ya en stage**. Comprobado dos veces: los
cambios de `dev-frontend` en `src/` sobrevivieron a seis commits míos. Para
archivos **nuevos** sí hace falta un `git add` previo de esas rutas concretas.

## Ajustes: `_readSettings` devuelve defaults si no hay archivo

Si escribes una migración/limpieza en `getSettings`, ten presente que
`_readSettings()` con ENOENT no devuelve `{}` sino `_getDefaultSettings()`. Si tu
limpieza escribe siempre, materializas `settings.json` en el primer arranque de
un usuario nuevo con datos que aún no ha elegido. Condiciona la escritura a que
el bloque exista de verdad (`hasOwnProperty`).

`saveSettings` hace `getSettings()` + `_deepMerge` con lo que manda el renderer:
cualquier cosa que borres solo en la lectura vuelve a disco en cuanto un renderer
viejo la reenvíe. Si borras algo por seguridad, bórralo también en el camino de
escritura. `_deepMerge` no fusiona arrays: los reemplaza enteros.

Ninguna operación de settings toma `_acquireLock` (el lock es solo para las
colecciones). La escritura es `write .tmp` + `rename`, atómica, así que dos
`getSettings()` concurrentes al arrancar no corrompen el archivo.

## El nombre `.tmp` compartido es una carrera de verdad

El patrón `write ${file}.tmp` + `rename` de este repo **no es seguro con dos
escrituras solapadas del mismo archivo**: la primera renombra, la segunda falla
con `ENOENT` al renombrar un `.tmp` que ya no existe, y su estado se pierde en
silencio (el `catch` solo borra el temporal). En `sync-service` y
`crypto-service` el temporal lleva sufijo único (`.${pid}.${seq}.tmp`).
`store-service` sigue con el nombre fijo: le salva el `_acquireLock` por
colección, salvo en settings, que no lo toma. Si algún día dos rutas escriben
settings a la vez, esto es lo que se rompe.

## Servidor de sync: lo que el contrato escrito no dice

Comprobado contra `https://termilab.rhinlab.com` (solo lecturas y un
`/auth/start` que caduca solo; no dejé nada que borrar).

- Los errores vienen como `{"error": "texto en español"}`, no `message`.
- `/auth/poll` con un código desconocido responde **404**, no 410. Cualquier
  estado que no sea 202/200 hay que tratarlo como código muerto y dejar de
  sondear.
- Sin `Authorization`, `/v1/*` da 401 `{"error":"falta el token"}`. Un 401 en
  cualquier momento significa dispositivo revocado desde otro sitio: hay que
  cerrar sesión de verdad, no reintentar.
- **No se puede averiguar qué rutas `/v1/*` existen sin token**: el hook de auth
  responde 401 antes de enrutar, así que `/v1/pair/:id/loquesea` también da 401.
  Un 401 ahí no significa «la ruta existe».
- Lápida de `keys`: se manda `enc:false` con `payload` **y** `ciphertext` nulos.
  La restricción del servidor es "no mandes los dos", no "manda uno". Esto **no
  está probado contra el servidor real** (requiere token de dispositivo); si un
  día falla al borrar una clave, es el primer sitio donde mirar.

## Emparejamiento: dos pasos, y el orden es lo único que protege

El protocolo viejo (una sola petición `/complete` con `{pub, ciphertext, nonce}`)
era vulnerable: el que pide solo podía derivar los dígitos **después** de que el
secreto ya hubiera salido, así que compararlos no protegía de nada. Hoy son dos
pasos, `/accept` (solo la pública) y `/complete` (la clave maestra), con **409 del
servidor** si te saltas el primero. No los juntes «porque es una llamada menos»:
esa comodidad es el fallo entero.

Sigue siendo cierto que **los dígitos no existen al pedir**: salen de las dos
públicas y `request()` devuelve `digits: null`. La interfaz los lee de
`sync:status` → `pairing: {id, digits, state}`, nunca del retorno de `request()`.

Lo que cuesta descubrir del lado que aprueba:

- La efímera privada vive **solo** en el `Map` `_approvals`, en memoria. Si el
  servidor deja de listar el emparejamiento en `/v1/pair/pending` tras el
  `/accept` —**no está comprobado contra el real**, hace falta token de
  dispositivo; el cliente y el arnés asumen lo peor—, la poda «lo que no esté en
  la lista se borra» **mata la confirmación**. Por eso las aprobaciones en
  estado `aceptado` se conservan y `pairingPending()` las devuelve aunque el
  servidor ya no las mande. Mismo motivo para sumarlas a `_pendingPairings`: si
  no, el contador caería a cero justo cuando el usuario tiene que confirmar.
- Tras un **409** la aprobación se devuelve a `pendiente` pero **no se borra**:
  el `kp` cacheado hace que al reaceptar salgan **los mismos dígitos**. Si la
  borras, el usuario vuelve a empezar y compara unos dígitos nuevos.
- La comprobación de «¿tengo clave maestra?» va **antes** del `/accept`. Aceptar
  sin poder completar deja al otro lado mirando unos dígitos que no llevan a nada.
- Si `pub_existing` **cambia** entre el `verificar` y el `listo`, no se recalculan
  los dígitos: se corta (`state = 'rejected'`). Recalcular sería enseñar unos
  dígitos que el usuario ya no está mirando.

Los nombres de estado son un **híbrido español/inglés a propósito**
(`pendiente`, `verificar`, `listo`, pero `rejected`, `expired`, `done`): la
interfaz de `src/components/Sync/PairingClaim.jsx` ya compara contra
`'rejected'`/`'expired'`. Renombrarlos «para ordenar» rompe la UI en silencio,
porque nada en el build cruza main con renderer. Están documentados en el bloque
de constantes de `sync-service.js`; si añades uno, va ahí y se avisa a
`dev-frontend`.

Y al sellar la clave maestra, va en **base64 dentro del texto cifrado**, no en
crudo: el descifrado devuelve string utf-8 y 32 bytes aleatorios no son utf-8
válido, así que un viaje de ida y vuelta en crudo la corrompe sin avisar
(y el error aparece luego, al no poder descifrar ninguna key).

### Probar el emparejamiento sin dos máquinas

Un solo proceso hace los dos papeles: `_claims` (el que pide) y `_approvals`
(el que aprueba) son mapas distintos que no se rozan. Lo único compartido es el
llavero, así que para comprobar que la clave **llega de verdad** hay que
`cryptoService.clearAll()` (y volver a poner el token) entre confirmar y
reclamar. En el arnés los sondeos se disparan llamando a `_fetchClaim()` a mano;
esperar al `setTimeout` de 2 s solo hace la prueba lenta y floja.

Dos ruidos de consola que **no** son fallos y que ya están domados en el arnés:
el aviso de pública cambiada a mitad, y el `syncNow()` en segundo plano que
`pairingClaim()` lanza y que suelta `fetch failed` si cierras el servidor falso
antes de que salga.

## Cifrado por campo de `hosts` (la fuga que ya ocurrió)

La especificación decía "las claves SSH cifradas, el resto en claro" y era
falsa: un host con `authType: 'password'` guarda la contraseña SSH **dentro del
payload de `hosts`**, así que viajó legible al servidor y hubo que purgarla en
titan a mano. La lección general: antes de declarar una colección "no
sensible", mira qué campos guarda de verdad, no cómo se llama.

- La tabla es `SECRET_FIELDS` en `sync-service.js` (hoy `hosts` →
  `password`, `passphrase`). **Un campo sensible nuevo en el formulario de host
  no está protegido hasta que su nombre está ahí.**
- El sobre va **dentro del JSON del payload**, no en las columnas de la fila,
  porque el servidor rechaza `payload` y `ciphertext` a la vez. Por eso `hosts`
  sigue siendo `enc: false` y no hizo falta migrar el esquema. Convertir
  `hosts` en colección cifrada entera se descartó a propósito: un equipo recién
  logueado y sin clave maestra tiene que **ver la lista de servidores** aunque
  no pueda conectarse.
- `_assertNoPlaintextSecrets` revienta la sincronización si un camino nuevo
  deja un secreto en claro en el payload. Es intencionadamente un `throw`: es
  preferible no sincronizar a filtrar.

### Lo que no es obvio: la sombra miente sobre los secretos

La sombra guarda el hash del item **local**, que incluye la contraseña. Dos
consecuencias que hay que tener presentes si tocas `_push`/`_applyRecords`:

- Si se sube un host sin su secreto (no había clave maestra), el hash local no
  se mueve nunca más, así que **la contraseña no subiría jamás tras emparejar**.
  Por eso la entrada de sombra lleva `secretsPending: true` y `_push` reenvía
  cuando esa marca coincide con tener clave maestra.
- Lo mismo al bajar: si conservamos un secreto local que el servidor no trae,
  la fila remota está incompleta → `secretsPending`.
- `secretsVersion` en `sync-state.json` existe solo para las instalaciones de
  la época en claro: su sombra dice "limpio" y sin la migración la fila legible
  del servidor no se reemplazaría nunca. Si algún día añades un campo a
  `SECRET_FIELDS` y quieres que las filas ya subidas se re-sellen, **sube
  `SECRETS_VERSION`**; es el único mecanismo que lo consigue.

Sin clave maestra el campo se **omite** (no se sube vacío ni en claro) y al
bajar no se machaca el valor local. `status()` expone `secretsWithheld` y
`secretsBlocked` para que la interfaz pueda decirlo; `dev-frontend` tiene que
saber que existen o no los pintará.

## Decisiones tomadas aquí que no se leen en el código

- **La clave maestra ya NO se genera sola** (se quitó `ensureMasterKey`, 2026-09).
  Generarla al azar en cada login era el bug de "saved password arrived still
  encrypted": cada equipo sellaba con su propia clave. Ver "Bóveda" abajo.
- **`logout()` conserva la clave maestra** (es del usuario, no de la sesión) y
  sí borra token, cursor y sombra.
- `syncNow()` está **serializado en cadena**, no protegido con un "ya hay una
  sincronización en curso": el login lanza un sync en segundo plano y el usuario
  que pulsa "sincronizar" justo después se comía el error. `logout()` espera esa
  cadena, o el `_save()` del sync en vuelo resucita el cursor de una sesión ya
  cerrada.
- El asistente de IA se **elimina**, no se desactiva (rama `feat/sync-sin-ia`).
  No lo reintroduzcas "por compatibilidad" ni dejes stubs de los canales `ai:*`.
- Las API keys que quedaron en claro en `<userData>/data/settings.json` son una
  fuga real: se purgan al leer los ajustes, no se dejan "porque ya no se usan".

## Bóveda: la clave maestra sale del passphrase (2026-09)

`settings/__vault__` = `{v, salt, kdf:{scrypt,N,r,p}, verifier}`. Vive en
`sync-state.json` (`state.vault`), se intercepta en `_applyRecords` y solo sube
por `_pushVault`. **Desbloqueado = clave instalada + `vaultSalt` igual a la sal
vigente + abre el verificador** (`_verifiedKey`). Solo esa clave sella; el resto
(la aleatoria vieja, una emparejada sin bóveda, la de una bóveda que perdió una
carrera) solo **lee**. Si tocas `_push`, la clave sale de `_verifiedKey()`, no
de `getMasterKey()`: el arnés (T2/T7) se pone rojo si no.

- Instalar una clave nueva (`_installVerifiedKey`) pasa la anterior a
  `legacyKeys` del llavero, pone el cursor a 0 y marca la sombra con `reseal`.
  Lo que se abre con una clave que no es la verificada se marca `reseal` y se
  resube. Las legacy se borran solo al acabar un sync que selló con la
  verificada. Un 503 a mitad (T4) las conserva.
- Un control negativo que parecía cubierto no lo estaba: si el equipo viejo ya
  había bajado copias locales, la migración funciona **sin** la legacy (resube
  desde lo local) y el test no nota que la has tirado. T4 usa un equipo sin
  copias locales a propósito.
- **Llavero y `sync-state.json` son dos archivos sin atomicidad.** No confíes en
  que las marcas `reseal` existan porque "se escribieron al instalar": las
  legacy solo se borran si `state.resealBaseline` (sal + huella de las legacy)
  prueba un pull completo desde 0 con la clave verificada y no queda ningún
  `reseal`. `_prepareLegacyMigration` lo fuerza si falta. Test T9.
- Lo que baja sellado con una clave que aquí no hay (`undecryptable`) **no se
  re-sella ni se reenvía** desde este equipo: pisaría una copia remota quizá
  más nueva. Solo una edición local real (hash movido) la sustituye. T10.
- "Bloqueado" y "hay cosas ilegibles" no van a `_error`: la UI los lee de
  `vaultExists`/`unlocked`/`undecryptableCount`. `_error` = fallos reales.
- `crypto.scrypt` con N=2^17 necesita `maxmem` explícito (256 MiB). Sin él el
  arnés revienta entero en la sección A, no en una comprobación.
- El servidor es LWW sin condición: dos equipos pueden crear bóveda a la vez.
  `setup` sube, rebaja y compara la sal; el que pierde no instala nada. Si se
  entera después, `_verifiedKey` deja de valer y queda bloqueado.
- Simular varios equipos en el arnés: `usarDispositivo(nombre)` cambia
  `currentUserData` y resetea `cryptoService._cache/_dataDir`,
  `storeService.dataDir/_initialized` y el estado del sync. Espera antes a
  `syncService._chain` o un sync en segundo plano escribe en el equipo nuevo.

## Fronteras

`electron/` es tuyo; `src/` no, ni siquiera para "un import que sobra". El
puente de preload y su consumidor en el renderer se rompen en momentos
distintos: lo que `preload.js` no expone se evalúa a `undefined` en `src/` y el
fallo aparece más tarde, al leer una propiedad del resultado. Si cambias el
puente, dilo en la entrega para que lo arregle `dev-frontend`.

## Known hosts y Logs (2026-09, rama `feat/ui-termius`)

- **ssh2 `hostVerifier(key, verify)` asíncrono**: devolver `undefined` y llamar
  `verify(bool)`. Mientras el usuario lee el diálogo (hasta 120 s) **el
  `readyTimeout` de ssh2 sigue corriendo**: hay que `clearTimeout(client._readyTimeout)`
  (campo privado, ssh2 1.17) además del timeout propio, y re-armar el propio al
  contestar. `host-key-service.createVerifier` lo hace con `onPrompt/onSettled`;
  K11 se pone rojo si lo quitas ("Connection timed out").
- `verify(false)` llega como `'error'` "Host denied (verification failed)";
  ssh-service lo reescribe a "Host key rejected" con `verifier.wasRejected()`.
- **Arnés: un timer con `unref()` del que depende un `await` hace que Node salga
  con código 0 y SIN imprimir nada.** Parece un verde. Mira la línea
  "Todo en verde", no el `$?`.
- Historial: las horas se estampan **síncronas** en `start()`/`end()`. Con
  `startedAt` dentro de la inserción asíncrona (lookup de email/dispositivo),
  1 de cada 3 corridas daba `startedAt > endedAt`. `before-quit` no se espera:
  `closeAllSync()` escribe con `fs.*Sync`.
- `known-hosts` y `connection-logs` **se sincronizan** desde 2026-09 (ver la
  sección de abajo). Antes eran locales; ya no.
- `ssh:connect` lleva ahora `hostId`, `label` y `purpose:'sftp'` (nada secreto);
  main solo guarda `hostId` si existe en `hosts.json` (quick connect trae un uuid
  tirado). SFTP abre shell igualmente: sale en Logs como `type:'sftp'`.
- `ssh2.Server` + clave de `ssh-keygen` da pruebas de punta a punta sin red (K11).

## Port forwarding (2026-09, rama `feat/ui-termius`)

- **Por IPC solo viaja el id de regla.** `port-forward-service` lee regla, host
  y credencial del almacén; "sellado" = `syncService.status().undecryptableIds`
  (`hosts/<id>`, `keys/<keyId>`). Estado en memoria por ruleId, push en
  `port-forward:status` `{ruleId, state, error?}`. `active` no se guarda nunca.
- Migración de reglas **al leer**, no reescribiendo: reescribir es editar cada
  regla y sync las subiría todas (P1 compara el archivo byte a byte).
  `port-forward-rules.js` está duplicado en `src/components/PortForwarding/rules.js`.
- **ssh2 `client.forwardOut` lanza síncrono** ("Not connected") si el cliente ya
  murió y el listener aún acepta: no llega por el callback y tumba main. Va
  envuelto en `_forwardOut`. Lo destapó el control negativo, no un test verde.
- `stop()` durante el arranque: su teardown ve un server que aún no escucha, y
  el `listen` termina después. Hay que volver a cerrar tras el listen (P6).
- Arnés P: borra `SSH_AUTH_SOCK` o el cliente prueba tu agente real. El
  `ssh2.Server` necesita `'tcpip'` (para -L/-D) y `'request'` `tcpip-forward`
  (para -R). `store:delete-port-forward` para el túnel antes de borrar.

## Sync de known_hosts y connection_logs (2026-09, arnés S1–S9)

- `known_hosts` va cifrada por fila **por autenticidad**, no por secreto. Y por
  eso sus **lápidas también van selladas** (`enc:true, deleted:true`,
  `{id, deleted:true}` dentro): una lápida en claro la puede forjar el servidor,
  borra la clave de confianza en todos los equipos y el siguiente MITM sale como
  "unknown" en vez de "changed". Lápida sin sellar, ajena o que no es lápida →
  no borra nada (`SEALED_TOMBSTONES`, `_checkSealedTombstone`). `keys` sigue con
  lápidas en claro a propósito (clientes viejos).
- `BOUND_ITEM_IDS`: el JSON descifrado de `known_hosts` debe traer
  `id === item_id`, o el servidor reenvía el cifrado de otra entrada bajo otro
  id. No se aplica a `keys`: filas antiguas no garantizan el id idéntico.
- **El cursor de un cliente viejo pasó por encima de las filas nuevas** (v1.10.0
  las ignora en `_applyRecords`, `sync-service.js:907-908` de `5ecfa09`). Al
  actualizar no las vería nunca. `COLLECTIONS_VERSION` en `sync-state.json`: un
  estado con versión menor vuelve a bajar desde 0 una vez. **Súbelo cada vez
  que añadas una colección.** `_save` la escribe siempre (el arnés crea estados
  sin ella). S9 carga el sync-service de `5ecfa09` con `Module._compile`.
- Por lo mismo: **se despliega el servidor antes** que la app. Un servidor sin
  la colección en la lista blanca da 400 al lote entero y el push no sube nada.
  El falso del arnés lee la lista blanca de `server/api/src/server.js`.
- `_applyRecords` escribe con `storeService.mutateRaw` (lock tomado durante
  leer-modificar-escribir): logs y known hosts los escribe main solo, y un
  `readRaw` … `writeRaw` pisaba lo que entrara entre medias. El lock no es
  reentrante: dentro del callback no se llama a otro método del almacén.
- Historial: cada escritura estampa `updatedAt`. Sin él, un re-pull desde 0
  (instalar clave, actualizar) devolvía la copia sin `endedAt` y ganaba el LWW
  (`isNewer(undefined, …)` es false). El tope de 1000 corta por `startedAt`,
  no por orden en disco, para que todos los equipos tiren **las mismas**: lo que
  cae sale como lápida en el mismo lote (1 por conexión nueva). Un primer merge
  entre equipos puede tirar muchas de golpe; es correcto (S8 usa servidor
  propio por eso).
- Dos equipos con la misma clave → dos entradas; `dedupeEntries` deja el id
  menor en todos. Claves distintas mismo host:port+tipo → vale cualquiera;
  "changed" solo si ninguna casa, y la "anterior" que se enseña es la de
  `addedAt` más reciente (igual en todos). Aceptar un changed borra todo el
  host:port (replaceAll), que es más que "mismo tipo".
- Riesgo que queda: el servidor puede **reenviar una versión vieja** sellada de
  una entrada que se borró (resucitar una clave reemplazada). Sin versión
  monotónica dentro del cifrado no se detecta.

## Revisión 2026-09 (arnés K12–K16, P9)

- **Cola de host-key**: una conexión con OTRA clave para el mismo host:port
  espera en `_chains`. Mientras espera, `handle.cancel` es suyo (no de
  `_join`): cancelar la resuelve `false` ya y su `run()` no pregunta ni
  escribe. Sin eso, al contestar el primer diálogo salía un "changed" de una
  conexión muerta y aceptarlo borraba todas las claves del host (K12). En cola
  también pausa sus timeouts (`onPrompt`/`onSettled` van con puerta de una vez).
- **`client.on('close')` en ssh-service**: lee `verifier.isPending()` ANTES de
  `cancel()` (cancel resuelve asíncrono, `wasRejected()` aún es false) y
  rechaza ya. `closed` impide re-armar el timeout; si quitas el rechazo y dejas
  `closed`, `connect()` no se resuelve NUNCA (el arnés se colgó así). K13.
- **`new-key-type`**: host:port conocido solo por otros tipos. Se pide a ssh2
  `algorithms.serverHostKey` con los tipos conocidos primero
  (`hostKeyAlgorithms`, nombres de `ssh2/lib/protocol/constants`; ssh2 lanza
  con un nombre que no admite). `ssh-rsa` guardado = `rsa-sha2-512/256` +
  `ssh-rsa`. Aceptar AGREGA (no replaceAll). K14a/K14b.
- **OS detectado**: `store:set-host-os` escribe solo `os` sobre el host en
  disco bajo el lock de hosts; `isSealed` corre DENTRO del lock (sync marca
  `undecryptable` dentro de `mutateRaw`). Nunca un saveHost del objeto entero
  del renderer. K15.
- **Port forward**: `lost()` durante `starting` se apunta en
  `entry.lostWhileStarting` y `_run` lanza tras el listen; si no, `running` con
  un cliente muerto. `_createSSHClient` es `async` ahora. P9.
- **Salir**: `before-quit` hace `preventDefault()` la primera vez, espera
  `closeAllForQuit` (espera inserts en vuelo + lock, tope 2 s, luego sync) y
  vuelve a `app.quit()`; `quitCleanupDone` evita el bucle. Con
  `updater:install` no se retiene (el updater lleva su quit). K16.

## Android: Node bajo nodejs-mobile (fases 1–2, 2026-09)

- `electron/` no se toca para Android: `mobile/node/electron-shim.js` es `electron` en el
  bundle (alias de esbuild). `configure()` antes de requerir nada de `electron/`
  (store-service fija su ruta en el constructor).
- `app.getPath('userData')` = DATADIR del plugin; los servicios le añaden `data/`.
  La DSK de respaldo vive en `DATADIR/device-key.json`, **fuera** de `data/`.
- El arnés es `npx -y -p node@18 node scripts/check-mobile.js`: arranca el BUNDLE real
  con fork() y el `bridge` real del plugin (fuera de Android habla por process.send).
  El padre tira los mensajes sin listener como el plugin: por eso caza la cola.
- `scripts/lib/fake-sync-server.js` es ahora compartido por los dos arneses.
- Canal nuevo en preload = canal nuevo en `mobile/web/electron-api-shim.js` (o en la
  lista de omitidos). M1 se pone rojo si no.
- Un segundo `node::Start` en el mismo proceso aborta (SIGTRAP). Android recrea la
  activity sin matar el proceso: el motor del plugin es estático por proceso (fork).

## Android fase 3 (2026-09-24): nativo

- **La DSK solo llega por env.** Java (`mobile/plugins/termilab-native`, `DeviceKey`) la
  desenvuelve con el Keystore y `MainActivity` la mete con `CapacitorNodeJS.setEnvProvider`
  (hook del fork vendorizado, corre en el hilo del motor antes de `node::Start`). En Node no
  hay respaldo en archivo: sin `TERMILAB_DSK`, `safeStorage` no está y el login se niega (M11).
  No reintroduzcas `device-key.json`: M9 mira que el bundle ni lo mencione.
- La migración/borrado del `device-key.json` de fase 1 es Java (`DeviceKeyResolver`, JUnit):
  el archivo se borra **después** de persistir el envoltorio con `commit()`, nunca antes.
- **Android 15+ corta la red de un proceso en caché** (logcat `resolv: network access
  blocked`, `fetch failed` en Node). Cualquier trabajo de red que tenga que seguir con la app
  detrás necesita el foreground service: hoy, sesiones SSH y el login en vuelo (la Custom Tab
  deja la app detrás). `main.js` envuelve `ssh:connect`/`ssh:disconnect`/`sync:login` y
  manda `native:sessions {count, signingIn}`; `signingIn` sale **antes** de abrir la URL.
- Probar el sync en el emulador: servidor falso del host con `adb reverse tcp:P tcp:P` y
  `am start -n com.rhinlab.termilab/.MainActivity --es TERMILAB_SYNC_URL http://127.0.0.1:P`
  (solo builds depurables; Node arranca una vez por proceso, así que `am force-stop` antes).
  El 8787 del host ya estaba ocupado.

## Android fase 4 (2026-09-24)

- **El "Cancel" del login en Android es `sync:logout`**: `logout()` pone `_loginAborted` y el
  bucle de `/auth/poll` lo mira antes y después de cada espera, así que para en ≤ 2 s y el login
  rechaza con "Inicio de sesion cancelado"; el envoltorio de `sync:login` en `mobile/node/main.js`
  baja `signingIn` en su `finally`. Si alguien quita ese flag de `logout()` (o hace que logout no
  toque el login en curso), el Cancel deja el servicio en primer plano 10 min. Lo vigila M12.
- `scripts/lib/fake-sync-server.js` tiene `hooks.pollPending` (202 para siempre) para eso.
- Nuevos métodos del plugin nativo (Java): `readClipboard`, `writeClipboard`,
  `setWindowBackground`. Son de la página, no de Node.

## Android fase 5: updater (2026-09-24)

- `mobile/node/updater.js` es Node puro (sin `electron`): el arnés lo requiere directamente
  (M14) y además por el bundle (M15–M18). `setupUpdater` en `mobile/node/main.js` registra
  `updater:*` con el sobre `{success, data|error}` de `main.js` de escritorio.
- El versionCode instalado llega de Java (`TERMILAB_VERSION_CODE`/`_NAME`, PackageInfo), no del
  bundle. `TERMILAB_UPDATE_URL` lo pone MainActivity solo si la app es depurable.
- **`spawnMobile` del arnés fija `TERMILAB_UPDATE_URL` a `127.0.0.1:1`**: sin eso cada proceso
  del arnés consultaría GitHub a los 5 s. `TERMILAB_UPDATE_DELAY_MS` acorta/alarga ese chequeo.
- Instalar es de la página (Node no llega a Java): `native:install-apk {id,…}` →
  `TermilabNative.installApk` → `native:install-result {id, ok, error}`. Java vuelve a
  comprobar paquete, versionCode y firma: no quites esa capa "porque Node ya verificó el sha".
- La limpieza de `updates/` es al arrancar (todo lo que no sea más nuevo que lo instalado, y los
  `.part`), porque tras instalar el proceso muere y no hay "después".

## SFTP de dos paneles (2026-09-24, rama `feat/sftp-termius`, arnés L1–L4, F1–F13)

- **`ssh:connect` con `purpose:'sftp'` ya no abre shell** (sesión con `stream: null`; `ssh:close` sale
  del `close`/`end` del cliente). Sigue pasando por el verificador de host key y sale en Logs como `sftp`.
- **`sshService.disconnect()` NO emite `ssh:close`**: `_cleanup` quita los listeners antes del `close`.
  Quien dependa de "la sesión se fue" (el panel SFTP que reutiliza la sesión de una terminal) tiene que
  mirar otra cosa (el renderer mira `activeSessions`).
- **Piping de `ssh2` Read/WriteStream = 1 petición en vuelo = ~2 MB/s en localhost.** `transfer-service`
  copia por trozos de 64 KB con 16 en vuelo sobre `open/read/write/close`, que `fs` y el SFTP de ssh2
  comparten con la misma forma: un bucle sirve para las cuatro direcciones (~250 MB/s). `fastGet/fastPut`
  no se cancelan ni hacen remoto→remoto.
- El `WriteStream` de ssh2 cierra el handle en `_final` y **nunca emite `finish`** (y `writableFinished`
  queda false). Si vuelves a streams, espera `close` tras el `end` de lectura.
- Cada fichero va a `.<nombre>.<rand>.termilab-part` y se renombra al final. SFTP v3 `rename` NO pisa:
  `posix-rename@openssh.com` (`ext_openssh_rename`) si está, si no unlink+rename. Cancelar borra el part;
  un destino que se estaba sobrescribiendo sobrevive (F5). El control negativo "sin part" deja F4 verde
  (el unlink limpia igual): el que lo caza es F5.
- **Nombres que vienen del servidor**: `readdir` de un servidor hostil puede traer `../x` o `a/b`.
  `sftp-service.list` los oculta; el motor de transferencias para la carpeta entera (F8). Todo `join`
  al destino local pasa por `checkName` (un segmento; en Windows también `\`).
- Conflictos se deciden en el renderer ANTES de empezar (`conflict: overwrite|rename`); main solo falla
  si existe y no hay decisión. Un fichero nunca reemplaza una carpeta.
- Borrar local = `shell.trashItem`; L3 mira el fuente para que no vuelva un `unlink/rm`.
- **Arnés**: `scripts/lib/real-sshd.js` levanta `/usr/sbin/sshd -D` como usuario normal en 127.0.0.1 y
  puerto libre (el `ssh2.Server` de pruebas no tiene subsistema SFTP). Borra `SSH_AUTH_SOCK` antes.
  A 300 MB/s un fichero de 50 MB termina entre dos pushes de progreso: para "cancelar a mitad" pon
  `transferService.progressMs = 0` (un push por trozo) y cancela desde el push.
- Memoria remoto→remoto: `rss`/`external` crecen ~30 MB y **no escalan con el tamaño** (20 MB → +14,
  240 MB → +33, otra vez 20 MB → +3); es memoria nativa de ssh2, no nuestra. F7 mide lo RETENIDO con
  `gc()` en cada muestra (`v8.setFlagsFromString('--expose-gc')` + `vm.runInNewContext('gc')`).
- Temporales de Abrir/Editar: `sftp-edit-service`, carpeta por pestaña (`owner` = id de pestaña),
  `fs.watch` sobre la CARPETA (los editores guardan con rename y el watch del inodo viejo se calla).
  `before-quit` hace `transferService.cancelAll()` + `sftpEditService.closeAllSync()`.

## Revisión SFTP 2026-09-24 (arnés F14–F21)

- **Re-subir una edición = escritura EN SITIO**, no part+rename: `realpath` primero (OpenSSH resuelve
  enlaces) y `transferService.start(id, spec, { inPlace: true })` abre con flags numéricas SFTP
  `WRITE|TRUNC` (0x12, sin CREAT: el servidor nunca aplica modo a un existente). Conserva enlace,
  inodo, enlaces duros, dueño y modo. No es atómico (aceptado solo para ediciones). Si `realpath`
  da NO_SUCH_FILE se recrea por el camino normal. F14.
- El tercer argumento `internal` de `transferService.start` (`inPlace`, `fileMode`) es **solo de
  main**: el handler IPC pasa `(id, spec)`. No lo metas en `spec` o el renderer lo controla.
- Transferencia normal que sobrescribe un **fichero**: tras el rename se hace `chmod` con los bits
  0o777 del que había (la umask local quitaba group-write). setuid/setgid no se reaplican. Sobre un
  **enlace** se reemplaza el enlace, no se escribe a través (decisión, como rsync). F15.
- Temporales de Abrir/Editar se crean con `fileMode: 0o600`. `openRefusal(name, purpose, platform)`
  en `sftp-edit-service`: Abrir niega `OPEN_BLOCKED` (unión de todas las plataformas + scripts);
  Editar niega solo lo que el SO ejecuta aunque sea texto en ESTA plataforma (`EDIT_BLOCKED`: en
  Windows .js/.bat/.sh…). Se comprueba antes de bajar y otra vez con el nombre local. El mensaje
  empieza por **"Refusing to open"**: el renderer lo detecta por texto (el sobre IPC solo lleva
  `message`, no `code`). Si cambias esa frase, cambia `FilePane.refusedOrFlash`. F16.
- `_deleteTree` hace `lstat` de cada hijo: los attrs de `readdir` los decide el servidor. Probarlo
  contra OpenSSH exige falsear `sftp.readdir` en la instancia (propiedad propia, luego `delete`),
  porque OpenSSH ya da attrs de lstat. F17.
- Sin `posix-rename`: destino → `.<n>.<rand>.termilab-old`, part → destino, borrar backup. Si falla
  el segundo rename se restaura el backup y el error lleva `keepPart = true` (el part NO se borra y
  su nombre va en el mensaje). F18 quita la extensión de `sftp._extensions` y falsea `sftp.rename`.
- `sftpEditService.upload` serializa por edición (`inflight` + como mucho un `queued` compartido).
  F19 espía `transferService.start` (solo ids `edit-*`) y mide concurrencia máxima.
- Windows: `checkName(name, platform)` niega `<>:"|?*`, control, punto/espacio final y
  CON/PRN/AUX/NUL/COM0-9/LPT0-9 (también con extensión y ¹²³). En bajadas `safeLocalName` mapea y
  el resultado trae `renamed: [{from, to}]`; si el mapeo choca con un hermano, " (n)". Plataforma
  inyectable con `transferService.localPlatform = 'win32'` (el harness la vuelve a `null`). F20.
- El control negativo en copia sin `.git` deja S9 rojo (lee `5ecfa09` con git): es ruido, no tuyo.

## Color de host (rama `feat/host-colors`, 2026-09-25, arnés K17)

- `store:set-host-color(hostId, color)` = mismo patrón que `set-host-os` (solo `color`, bajo el lock,
  `isSealed` dentro), con dos diferencias a propósito: un host sellado **lanza** (el usuario pulsó una
  muestra y hay que decirle por qué no cambió; el OS es silencioso) y un color inválido **lanza**
  ("Invalid color"). `null` borra la clave. El texto del error se pinta tal cual en el popover.
- main **no** tiene la paleta: valida `null | #rrggbb` (`HOST_COLOR_RE`). La lista vive solo en
  `src/components/HostList/hostColor.js`. No la dupliques "para validar mejor": entonces sí sería un
  par duplicado que se desincroniza.
- `hostIsSealed` en ipc-handlers es compartido por OS y color. Estado de sync ilegible = sellado.
