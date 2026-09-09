import { pool } from './db.js';

const TTL_MIN = 5;
const b64 = /^[A-Za-z0-9+/=_-]{20,200}$/;

/* Emparejamiento: el dispositivo nuevo publica una clave efimera, el que ya
   tiene la clave maestra responde con la suya y con la clave maestra cifrada
   para ese destinatario. Aqui solo se guardan cadenas opacas. */
export function registerPairingRoutes(app) {
  /* Lo llama el dispositivo NUEVO, recien logueado y sin clave maestra. */
  app.post('/v1/pair/request', async (req, reply) => {
    const pub = String(req.body?.pub || '');
    if (!b64.test(pub)) return reply.code(400).send({ error: 'clave publica invalida' });

    await pool.query(
      `update pairings set rejected = true
        where user_id = $1 and new_device_id = $2 and claimed = false and rejected = false`,
      [req.user.id, req.deviceId]
    );

    const { rows } = await pool.query(
      `insert into pairings (user_id, new_device_id, pub_new, expires_at)
       values ($1, $2, $3, now() + interval '${TTL_MIN} minutes')
       returning id, expires_at`,
      [req.user.id, req.deviceId, pub]
    );
    return { pairing_id: rows[0].id, expires_at: rows[0].expires_at };
  });

  /* Lo consulta el dispositivo YA emparejado para mostrar la solicitud. */
  app.get('/v1/pair/pending', async (req) => {
    const { rows } = await pool.query(
      `select p.id, p.pub_new, p.created_at, p.expires_at, d.name as device_name, d.platform
         from pairings p join devices d on d.id = p.new_device_id
        where p.user_id = $1 and p.claimed = false and p.rejected = false
          and p.expires_at > now() and p.new_device_id <> $2
        order by p.created_at desc`,
      [req.user.id, req.deviceId]
    );
    return { pending: rows };
  });

  /* PASO 1 de dos. Publica SOLO la clave publica del dispositivo que aprueba,
     sin nada de material cifrado.

     Esta separacion es lo que hace que los seis digitos sirvan de algo. Si la
     publica y la clave maestra cifrada viajaran juntas -- como ocurria antes --
     el que aprueba soltaria el secreto en la misma peticion que revela su
     publica, y el otro extremo solo podria calcular sus digitos DESPUES. Un
     atacante que sustituyera la publica del dispositivo nuevo recibiria la
     clave maestra, y el usuario descubriria el enganio al ver digitos
     distintos cuando ya no sirve de nada.

     Con el corte en dos, los dos extremos pueden mostrar los digitos antes de
     que se mueva un solo byte de la clave maestra. */
  app.post('/v1/pair/:id/accept', async (req, reply) => {
    const pub = String(req.body?.pub || '');
    if (!b64.test(pub)) return reply.code(400).send({ error: 'clave publica invalida' });

    const { rowCount } = await pool.query(
      `update pairings set pub_existing = $1
        where id = $2 and user_id = $3 and claimed = false and rejected = false
          and expires_at > now() and new_device_id <> $4 and ciphertext is null`,
      [pub, req.params.id, req.user.id, req.deviceId]
    );
    if (!rowCount) return reply.code(404).send({ error: 'solicitud no valida o caducada' });
    return { ok: true };
  });

  /* PASO 2 de dos. Entrega la clave maestra cifrada, ya con el usuario habiendo
     comparado los digitos en las dos pantallas. Exige que el paso 1 haya
     ocurrido: sin pub_existing no hay nada que comparar, asi que aceptar aqui
     seria volver al agujero de antes. */
  app.post('/v1/pair/:id/complete', async (req, reply) => {
    const { ciphertext, nonce } = req.body || {};
    if (!ciphertext || !nonce) return reply.code(400).send({ error: 'falta el material cifrado' });

    const { rowCount } = await pool.query(
      `update pairings set ciphertext = $1, nonce = $2
        where id = $3 and user_id = $4 and claimed = false and rejected = false
          and expires_at > now() and new_device_id <> $5 and pub_existing is not null`,
      [ciphertext, nonce, req.params.id, req.user.id, req.deviceId]
    );
    if (!rowCount) {
      return reply.code(409).send({ error: 'hay que aceptar (paso 1) antes de entregar la clave' });
    }
    return { ok: true };
  });

  app.post('/v1/pair/:id/reject', async (req, reply) => {
    const { rowCount } = await pool.query(
      'update pairings set rejected = true where id = $1 and user_id = $2 and claimed = false',
      [req.params.id, req.user.id]
    );
    if (!rowCount) return reply.code(404).send({ error: 'solicitud desconocida' });
    return { ok: true };
  });

  /* Lo pregunta el dispositivo NUEVO hasta que el otro responde. Se entrega
     una sola vez: el material cifrado se borra al reclamarlo. */
  app.get('/v1/pair/:id', async (req, reply) => {
    const { rows } = await pool.query(
      `select pub_existing, ciphertext, nonce, claimed, rejected, expires_at
         from pairings where id = $1 and user_id = $2 and new_device_id = $3`,
      [req.params.id, req.user.id, req.deviceId]
    );
    if (!rows.length) return reply.code(404).send({ error: 'solicitud desconocida' });

    const p = rows[0];
    if (p.rejected) return reply.code(403).send({ status: 'rechazado' });
    if (p.claimed) return reply.code(410).send({ status: 'usado' });
    if (new Date(p.expires_at) < new Date() && !p.ciphertext) {
      return reply.code(410).send({ status: 'caducado' });
    }
    /* Aceptado pero aun sin clave: se devuelve la publica para que este
       extremo pueda mostrar los seis digitos y el usuario compare ANTES de
       que el otro lado entregue nada. */
    if (!p.ciphertext) {
      if (!p.pub_existing) return reply.code(202).send({ status: 'pendiente' });
      return reply.code(202).send({ status: 'verificar', pub_existing: p.pub_existing });
    }

    await pool.query(
      'update pairings set claimed = true, ciphertext = null, nonce = null where id = $1',
      [req.params.id]
    );
    return { status: 'listo', pub_existing: p.pub_existing, ciphertext: p.ciphertext, nonce: p.nonce };
  });
}
