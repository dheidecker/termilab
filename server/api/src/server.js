import Fastify from 'fastify';
import { pool, migrate } from './db.js';
import { registerAuthRoutes, authenticate, configured } from './auth.js';
import { registerPairingRoutes } from './pairing.js';

const PORT = Number(process.env.PORT || 8110);
/* Lista blanca. known_hosts viaja cifrada (enc) incluso en sus tumbas, y
   connection_logs en claro: aqui no cambia nada, el servidor no mira dentro.
   Los clientes <= v1.10.0 ignoran las colecciones que no conocen. */
const COLLECTIONS = ['hosts', 'groups', 'snippets', 'port_forwards', 'keys', 'settings', 'known_hosts', 'connection_logs'];

const app = Fastify({ logger: true });
registerAuthRoutes(app);
registerPairingRoutes(app);

/* Sin auth: es lo que sondea Cloudflare y lo que permite comprobar el tunel
   de punta a punta antes de que exista el login. No revela nada. */
app.get('/health', async () => {
  const { rows } = await pool.query('select 1 as ok');
  return { ok: rows[0].ok === 1, service: 'termilab-sync', auth: configured ? 'google' : 'desactivada' };
});

/* Solo /v1/* exige token de dispositivo. /health y /auth/* quedan fuera:
   el primero lo sondea Cloudflare, los segundos son el login mismo. */
app.addHook('preHandler', async (req, reply) => {
  if (!req.url.startsWith('/v1/')) return;
  return authenticate(req, reply);
});

/* Gestion de dispositivos: es la contrapartida de emitir los tokens aqui y
   no en Google. Revocar un portatil perdido no toca tu cuenta de Google. */
app.get('/v1/devices', async (req) => {
  const { rows } = await pool.query(
    `select d.id, d.name, d.platform, d.created_at, t.last_seen_at, t.revoked
       from devices d join device_tokens t on t.device_id = d.id
      where d.user_id = $1 order by d.created_at asc`,
    [req.user.id]
  );
  return { devices: rows.map(d => ({ ...d, current: d.id === req.deviceId })) };
});

app.delete('/v1/devices/:id', async (req, reply) => {
  const { rowCount } = await pool.query(
    'update device_tokens set revoked = true where user_id = $1 and device_id = $2',
    [req.user.id, req.params.id]
  );
  if (!rowCount) return reply.code(404).send({ error: 'dispositivo desconocido' });
  return { revoked: req.params.id };
});

/* Delta: devuelve todo lo que cambio despues de `since`, tumbas incluidas
   (deleted = true), para que el cliente sepa que borrar y no resucite nada. */
app.get('/v1/sync', async (req) => {
  const since = Number(req.query.since || 0);
  const { rows } = await pool.query(
    `select collection, item_id, seq, enc, payload,
            encode(ciphertext, 'base64') as ciphertext,
            encode(nonce, 'base64') as nonce,
            deleted, updated_at
       from records
      where user_id = $1 and seq > $2
      order by seq asc
      limit 1000`,
    [req.user.id, since]
  );
  const cursor = rows.length ? Number(rows[rows.length - 1].seq) : since;
  return { records: rows, cursor, has_more: rows.length === 1000 };
});

/* Escritura por lotes. Ultima escritura gana, que para un solo usuario con
   varios dispositivos es suficiente y evita el coste de resolver conflictos.
   Un borrado es una tumba, nunca un DELETE: si se borrara la fila, un
   dispositivo desconectado volveria a subir el objeto en su siguiente sync. */
app.post('/v1/sync', async (req, reply) => {
  const items = Array.isArray(req.body?.records) ? req.body.records : [];
  if (!items.length) return { applied: 0, cursor: Number(req.body?.cursor || 0) };

  const bad = items.find(i => !COLLECTIONS.includes(i.collection) || !i.item_id);
  if (bad) return reply.code(400).send({ error: `registro invalido: ${JSON.stringify(bad).slice(0, 120)}` });

  const client = await pool.connect();
  try {
    await client.query('begin');
    let cursor = 0;
    for (const it of items) {
      const enc = !!it.enc;
      const { rows } = await client.query(
        `insert into records
           (user_id, collection, item_id, seq, enc, payload, ciphertext, nonce, deleted, updated_at)
         values ($1, $2, $3, nextval('records_seq'), $4, $5,
                 case when $6::text is null then null else decode($6::text, 'base64') end,
                 case when $7::text is null then null else decode($7::text, 'base64') end,
                 $8, now())
         on conflict (user_id, collection, item_id) do update
           set seq = nextval('records_seq'), enc = excluded.enc,
               payload = excluded.payload, ciphertext = excluded.ciphertext,
               nonce = excluded.nonce, deleted = excluded.deleted, updated_at = now()
         returning seq`,
        [req.user.id, it.collection, it.item_id, enc,
         enc ? null : (it.payload ?? {}),
         enc ? it.ciphertext : null,
         enc ? it.nonce : null,
         !!it.deleted]
      );
      cursor = Math.max(cursor, Number(rows[0].seq));
    }
    await client.query('commit');
    return { applied: items.length, cursor };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
});

const start = async () => {
  await migrate(app.log);
  await app.listen({ port: PORT, host: '0.0.0.0' });
};

start().catch(err => {
  app.log.error(err);
  process.exit(1);
});
