create extension if not exists pgcrypto;

create table if not exists users (
  id          uuid primary key default gen_random_uuid(),
  google_sub  text unique not null,
  email       text not null,
  created_at  timestamptz not null default now()
);

create table if not exists devices (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  name         text not null,
  platform     text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz
);

/* Un registro por objeto sincronizado.
   El contenido va en payload (claro) o en ciphertext+nonce (sobre cifrado
   que el servidor no puede leer). `enc` dice cual de los dos manda.
   Las claves SSH usaran la via cifrada; hosts/grupos/snippets la clara.
   Nada aqui obliga a elegir ahora: cambiar una coleccion de clara a
   cifrada no necesita migracion. */
create table if not exists records (
  user_id    uuid not null references users(id) on delete cascade,
  collection text not null,
  item_id    text not null,
  seq        bigint not null,
  enc        boolean not null default false,
  payload    jsonb,
  ciphertext bytea,
  nonce      bytea,
  deleted    boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, collection, item_id),
  constraint payload_xor_ciphertext check (
    (enc = false and ciphertext is null and nonce is null)
    or (enc = true and payload is null and ciphertext is not null)
  )
);

/* Secuencia global: da a cada escritura un numero creciente, y el cliente
   pide "lo que haya despues de N". Es lo que hace barata la sincronizacion
   incremental y lo que permite que un dispositivo lleve semanas apagado. */
create sequence if not exists records_seq;
create index if not exists records_delta on records (user_id, seq);
