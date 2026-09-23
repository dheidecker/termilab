# termilab-sync

Backend de sincronizacion de Termilab. Cada cuenta de Google ve los mismos
hosts, grupos, snippets, port-forwards, claves SSH, known hosts e historial de
conexiones en todos sus dispositivos.

Colecciones admitidas (`COLLECTIONS` en `api/src/server.js`; cualquier otra
da 400): `hosts`, `groups`, `snippets`, `port_forwards`, `keys`, `settings`,
`known_hosts`, `connection_logs`. Anadir una es un cambio en los dos lados:
la app nueva sube filas de ella y un servidor viejo le rechaza el lote
entero, asi que **se despliega primero el servidor**.

- API en el puerto **8110** del host (`termilab.rhinlab.com` via Cloudflare).
- Postgres propio en `127.0.0.1:5435`, datos en `./data/postgres`.
- No comparte base ni volumen con ningun otro proyecto de /home/contenedores.

## Arranque

    cp .env.example .env    # rellenar DB_PASSWORD y GOOGLE_CLIENT_ID
    docker compose up -d --build

Las migraciones se aplican solas al arrancar la API. Solo crean; ninguna
borra ni reescribe.

## Endpoints

    GET    /health                    sin auth, sondeo del tunel

    POST   /auth/start                la app pide sesion, recibe URL de Google
    GET    /auth/callback             vuelve Google; canjea el codigo aqui
    GET    /auth/poll?code=           la app pregunta hasta recibir su token

    GET    /v1/sync?since=N           cambios posteriores al cursor N
    POST   /v1/sync                   escritura por lotes, devuelve cursor
    GET    /v1/devices                dispositivos de la cuenta
    DELETE /v1/devices/:id            revoca uno

    POST   /v1/pair/request           dispositivo nuevo publica su clave efimera
    GET    /v1/pair/pending           el ya emparejado ve las solicitudes
    POST   /v1/pair/:id/accept        paso 1: publica solo su clave publica
    POST   /v1/pair/:id/complete      paso 2: entrega la clave maestra cifrada
    POST   /v1/pair/:id/reject        descarta una solicitud
    GET    /v1/pair/:id               el nuevo recoge el material, una sola vez

`/v1/*` exige `Authorization: Bearer <token de dispositivo>`, emitido por
esta API, no por Google. Se guarda solo como hash: leer la base no permite
suplantar a nadie. Revocar un dispositivo es inmediato.

El client secret de Google vive solo aqui: la app nunca lo lleva dentro, y
nunca ve un token de Google.

Sin `GOOGLE_CLIENT_ID`, `/v1/*` responde 503. El bypass de desarrollo exige
`DEV_NO_AUTH=1` **y** venir de loopback, condicion que el tunel nunca cumple.

## El sobre cifrado y el emparejamiento

`records` guarda cada objeto en claro (`payload`) o cifrado
(`ciphertext` + `nonce`), segun el flag `enc`. El servidor nunca descifra:
para las colecciones cifradas solo almacena y devuelve bytes. Pasar una
coleccion de clara a cifrada no necesita migracion.

Las claves SSH y los known hosts van por la via cifrada. Los known hosts no
por secretos sino por autenticidad: una fila en claro permitiria a quien
controle este servidor plantar una clave de host falsa en todos los equipos.
Por lo mismo sus tumbas tambien van cifradas (`enc: true, deleted: true`
con `ciphertext`), cosa que la restriccion `payload_xor_ciphertext` ya
admite; el cliente ignora una tumba de `known_hosts` sin sellar.
`connection_logs` va en claro, como `hosts`. La clave maestra que las cifra vive
en el llavero del sistema operativo de cada dispositivo y llega a un equipo
nuevo por emparejamiento: el nuevo publica una clave efimera, el que ya la
tiene responde con la suya y con la maestra cifrada para ese destinatario.

**Los seis digitos que ve el usuario no se guardan aqui ni los genera el
servidor**: cada dispositivo los deriva de las dos claves publicas. Si este
servidor sustituyera una clave para colocarse en medio, los digitos dejarian
de coincidir en las dos pantallas. Por eso el codigo no es aleatorio.

Y por eso el emparejamiento tiene **dos pasos**. La primera version entregaba
la clave publica y la clave maestra cifrada en la misma peticion, y entonces el
extremo que pide solo podia calcular sus digitos DESPUES de que el secreto ya
hubiera salido: un atacante que sustituyera una publica se llevaba la clave
maestra y el usuario descubria el enganio cuando ya no servia de nada.

Con `/accept` y `/complete` separados, los dos extremos muestran los digitos
antes de que se mueva un solo byte de la clave. `/complete` exige que
`pub_existing` ya este puesto: sin eso responde 409. No los vuelvas a juntar.

## Cuidado

Este stack conviene con otros en la misma maquina. No ejecutar nunca
`docker system prune`, `docker volume prune` ni `docker compose down -v`:
el primero se lleva volumenes de contenedores parados de otros proyectos.
Para parar esto: `docker compose down` (sin -v), desde esta carpeta.
