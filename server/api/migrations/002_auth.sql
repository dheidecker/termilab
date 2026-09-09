/* Login iniciado por la app: la app crea una sesion, abre el navegador y
   pregunta por ella hasta que Google devuelve el control al servidor.
   Asi el token de Google nunca pasa por la app ni por el navegador. */
create table if not exists auth_sessions (
  code        text primary key,
  state       text unique not null,
  device_name text not null,
  platform    text,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  user_id     uuid references users(id) on delete cascade,
  device_id   uuid references devices(id) on delete cascade,
  token       text,
  consumed    boolean not null default false,
  error       text
);

/* Un token por dispositivo, guardado solo como hash: si alguien lee la base
   no puede suplantar a nadie. Revocar un portatil perdido es marcar aqui. */
create table if not exists device_tokens (
  token_hash   text primary key,
  user_id      uuid not null references users(id) on delete cascade,
  device_id    uuid not null references devices(id) on delete cascade,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked      boolean not null default false
);

create index if not exists device_tokens_user on device_tokens (user_id);
