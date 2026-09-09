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
- Cuando toques el arnés, valídalo con un **control negativo**: vacía
  `SECRET_FIELDS` y comprueba que se pone rojo. Un arnés de seguridad que no
  falla cuando quitas la protección no está probando nada.

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
- Lápida de `keys`: se manda `enc:false` con `payload` **y** `ciphertext` nulos.
  La restricción del servidor es "no mandes los dos", no "manda uno". Esto **no
  está probado contra el servidor real** (requiere token de dispositivo); si un
  día falla al borrar una clave, es el primer sitio donde mirar.

## Emparejamiento: los dígitos NO pueden existir al pedirlo

Trampa de diseño que cuesta media hora entender. `sync.pairing.request()`
devuelve `{pairingId, digits}` según el contrato IPC, pero los seis dígitos
salen de **las dos** públicas y el que pide solo tiene la suya: hasta que el otro
dispositivo aprueba, no hay dígitos que enseñar. Por eso:

- `request()` devuelve `digits: null` y arranca un sondeo de `GET /v1/pair/:id`;
  cuando llega `pub_existing` se emite `sync:status` con un campo extra
  `pairing: {id, digits, state}`. **La interfaz tiene que leer los dígitos de
  ahí**, no del retorno de `request()`.
- El lado que aprueba sí los tiene ya en `pairing.pending()`, porque genera su
  efímera en ese momento. Está **cacheada por `pairing_id`**: si la regeneras en
  `approve()`, los dígitos que vio el usuario dejan de ser los que se usan y el
  otro lado ve otros. `approve()` sin `pending()` previo llama a `pending()` él
  solo justo por esto.

Y al sellar la clave maestra, va en **base64 dentro del texto cifrado**, no en
crudo: el descifrado devuelve string utf-8 y 32 bytes aleatorios no son utf-8
válido, así que un viaje de ida y vuelta en crudo la corrompe sin avisar
(y el error aparece luego, al no poder descifrar ninguna key).

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

- **La clave maestra se genera sola en el primer login.** Si ese dispositivo
  empareja después, la que llega **sustituye** a la local, y los registros
  cifrados con la vieja quedan ilegibles: se saltan, se avisa en `status.error`
  y **no se toca la copia local**. Nunca borrar lo local por no poder descifrar.
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

## Fronteras

`electron/` es tuyo; `src/` no, ni siquiera para "un import que sobra". El
puente de preload y su consumidor en el renderer se rompen en momentos
distintos: lo que `preload.js` no expone se evalúa a `undefined` en `src/` y el
fallo aparece más tarde, al leer una propiedad del resultado. Si cambias el
puente, dilo en la entrega para que lo arregle `dev-frontend`.
