import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

/* Aplica las migraciones en orden y registra cuales corrieron.
   Solo crea; ninguna migracion borra ni reescribe datos existentes. */
export async function migrate(log) {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  await pool.query(
    'create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())'
  );
  const { rows } = await pool.query('select name from _migrations');
  const done = new Set(rows.map(r => r.name));

  for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into _migrations (name) values ($1)', [file]);
      await client.query('commit');
      log.info(`migracion aplicada: ${file}`);
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }
}
