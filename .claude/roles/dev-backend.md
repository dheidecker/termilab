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
`ipc-handlers.js`; con eso basta, arrastra todos los servicios. Mismo truco para
probar `store-service` sin Electron: solo necesita `app.getPath()` devolviendo un
directorio temporal.

## `git add` de un archivo ya borrado falla; `git commit -- <rutas>` no

En un árbol compartido con otro agente no puedes usar `git add -A` ni
`git commit -a`. Y `git add electron/services/borrado.js` da
`fatal: pathspec did not match any files` cuando el archivo ya no está en el
worktree. La forma que funciona sin tocar lo de nadie es saltarse el índice:

```bash
git commit -m "..." -- electron/ruta-a.js electron/ruta-b.js
```

Commitea el estado del worktree de esas rutas (incluidas borradas) y **deja
intacto lo que el otro agente tenga ya en stage**. Comprobado: sus `D src/...`
staged sobrevivieron a tres commits míos.

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

## Decisiones de Derek que no se leen en el código

- El asistente de IA se **elimina**, no se desactiva (rama `feat/sync-sin-ia`).
  No lo reintroduzcas "por compatibilidad" ni dejes stubs de los canales `ai:*`.
- Las API keys que quedaron en claro en `<userData>/data/settings.json` son una
  fuga real: se purgan al leer los ajustes, no se dejan "porque ya no se usan".

Cuando esa rama se integre, el `CLAUDE.md` queda desfasado en tres puntos —
canal de ejemplo `ai:chat`, la tabla de "módulos duplicados" (`command-safety` /
`ai-models` ya no existen en ninguno de los dos lados) y la sección entera "AI
assistant command safety". Ese archivo lo mantiene quien orquesta, avísale.

## Fronteras

`electron/` es tuyo; `src/` no, ni siquiera para "un import que sobra". El
puente de preload y su consumidor en el renderer se rompen en momentos
distintos: al quitar `ai` de `preload.js` los `window.electronAPI?.ai?.chat(...)`
que sigan en `src/` se evalúan a `undefined` y el fallo aparece más tarde, al
leer `res.success`. Menciónalo en la entrega para que lo arregle `dev-frontend`.
