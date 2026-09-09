import { randomBytes, createHash } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { pool } from './db.js';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const REDIRECT_URI = `${BASE_URL}/auth/callback`;
const SESSION_TTL_MIN = 10;

export const configured = Boolean(CLIENT_ID && CLIENT_SECRET && BASE_URL);

const client = configured
  ? new OAuth2Client({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI })
  : null;

const rand = (n = 32) => randomBytes(n).toString('base64url');
const hash = (t) => createHash('sha256').update(t).digest('hex');

const page = (title, body) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
   <title>${title}</title>
   <style>body{font:16px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#0d1117;color:#e6edf3;
   display:grid;place-items:center;height:100vh;margin:0;text-align:center}div{max-width:26rem;padding:2rem}
   h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#8b949e;margin:0}</style>
   <div><h1>${title}</h1><p>${body}</p></div>`;

export function registerAuthRoutes(app) {
  /* La app pide una sesion de login y recibe la URL de Google que debe abrir
     en el navegador del sistema. `code` se lo queda para preguntar despues. */
  app.post('/auth/start', async (req, reply) => {
    if (!configured) return reply.code(503).send({ error: 'oauth no configurado' });

    const deviceName = String(req.body?.device_name || '').slice(0, 80) || 'Dispositivo sin nombre';
    const platform = String(req.body?.platform || '').slice(0, 40) || null;
    const code = rand(24);
    const state = rand(24);

    await pool.query(
      `insert into auth_sessions (code, state, device_name, platform, expires_at)
       values ($1, $2, $3, $4, now() + interval '${SESSION_TTL_MIN} minutes')`,
      [code, state, deviceName, platform]
    );

    const authorize_url = client.generateAuthUrl({
      scope: ['openid', 'email', 'profile'],
      state,
      prompt: 'select_account',
    });

    return { code, authorize_url, expires_in: SESSION_TTL_MIN * 60 };
  });

  /* Aqui vuelve Google. El intercambio del codigo usa el client secret, que
     solo existe en este servidor: por eso el binario distribuido no lo lleva. */
  app.get('/auth/callback', async (req, reply) => {
    reply.type('text/html');
    if (!configured) return reply.code(503).send(page('No disponible', 'OAuth no esta configurado.'));

    const { code: googleCode, state, error: googleError } = req.query;

    if (googleError) {
      await pool.query('update auth_sessions set error = $1 where state = $2', [String(googleError).slice(0, 200), state]);
      return reply.code(400).send(page('Login cancelado', 'Puedes cerrar esta pestana.'));
    }
    if (!googleCode || !state) return reply.code(400).send(page('Peticion invalida', 'Faltan parametros.'));

    const { rows } = await pool.query(
      `select code from auth_sessions
        where state = $1 and expires_at > now() and token is null and error is null`,
      [state]
    );
    if (!rows.length) return reply.code(400).send(page('Enlace caducado', 'Vuelve a iniciar sesion desde Termilab.'));
    const sessionCode = rows[0].code;

    let payload;
    try {
      const { tokens } = await client.getToken(String(googleCode));
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: CLIENT_ID });
      payload = ticket.getPayload();
      if (!payload?.email_verified) throw new Error('correo no verificado en Google');
    } catch (err) {
      app.log.error({ err }, 'fallo el intercambio con Google');
      await pool.query('update auth_sessions set error = $1 where code = $2', ['no se pudo verificar la cuenta', sessionCode]);
      return reply.code(400).send(page('No se pudo verificar', 'Vuelve a intentarlo desde Termilab.'));
    }

    const db = await pool.connect();
    try {
      await db.query('begin');
      const user = (await db.query(
        `insert into users (google_sub, email) values ($1, $2)
           on conflict (google_sub) do update set email = excluded.email
           returning id, email`,
        [payload.sub, payload.email]
      )).rows[0];

      const session = (await db.query('select device_name, platform from auth_sessions where code = $1', [sessionCode])).rows[0];
      const device = (await db.query(
        `insert into devices (user_id, name, platform, last_seen_at)
         values ($1, $2, $3, now()) returning id`,
        [user.id, session.device_name, session.platform]
      )).rows[0];

      const token = rand(32);
      await db.query(
        'insert into device_tokens (token_hash, user_id, device_id) values ($1, $2, $3)',
        [hash(token), user.id, device.id]
      );
      await db.query(
        'update auth_sessions set user_id = $1, device_id = $2, token = $3 where code = $4',
        [user.id, device.id, token, sessionCode]
      );
      await db.query('commit');
    } catch (err) {
      await db.query('rollback');
      throw err;
    } finally {
      db.release();
    }

    return reply.send(page('Sesion iniciada', `Ya puedes volver a Termilab. Cuenta: ${payload.email}`));
  });

  /* La app pregunta por su sesion. El token se entrega UNA sola vez: si la
     respuesta se perdiera, hay que rehacer el login, que es lo correcto. */
  app.get('/auth/poll', async (req, reply) => {
    const code = String(req.query.code || '');
    if (!code) return reply.code(400).send({ error: 'falta code' });

    const { rows } = await pool.query(
      `select s.token, s.consumed, s.error, s.expires_at, u.email
         from auth_sessions s left join users u on u.id = s.user_id
        where s.code = $1`,
      [code]
    );
    if (!rows.length) return reply.code(404).send({ error: 'sesion desconocida' });

    const s = rows[0];
    if (s.error) return reply.code(400).send({ status: 'error', error: s.error });
    if (s.consumed) return reply.code(410).send({ status: 'usado' });
    if (!s.token) {
      if (new Date(s.expires_at) < new Date()) return reply.code(410).send({ status: 'caducado' });
      return reply.code(202).send({ status: 'pendiente' });
    }

    await pool.query('update auth_sessions set consumed = true, token = null where code = $1', [code]);
    return { status: 'listo', token: s.token, email: s.email };
  });
}

/* Identifica al dispositivo por su token. Nunca compara el token en claro
   contra la base: se busca por hash. */
export async function authenticate(req, reply) {
  if (!configured) return reply.code(503).send({ error: 'autenticacion no configurada' });

  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return reply.code(401).send({ error: 'falta el token' });

  const { rows } = await pool.query(
    `select t.user_id, t.device_id, u.email
       from device_tokens t join users u on u.id = t.user_id
      where t.token_hash = $1 and t.revoked = false`,
    [hash(header.slice(7))]
  );
  if (!rows.length) return reply.code(401).send({ error: 'token invalido o revocado' });

  req.user = { id: rows[0].user_id, email: rows[0].email };
  req.deviceId = rows[0].device_id;
  pool.query('update device_tokens set last_seen_at = now() where token_hash = $1', [hash(header.slice(7))]).catch(() => {});
}
