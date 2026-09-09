/* Emparejamiento de un dispositivo nuevo con uno que ya tiene la clave
   maestra. El servidor solo transporta bytes opacos: nunca ve la clave
   maestra ni puede derivarla.

   Las dos claves publicas son efimeras y de un solo uso. El codigo de 6
   digitos que ve el usuario NO se guarda aqui: cada dispositivo lo deriva
   de las dos publicas. Si el servidor intentara sustituir una, los digitos
   dejarian de coincidir en las dos pantallas y el usuario lo veria. */
create table if not exists pairings (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,
  new_device_id  uuid not null references devices(id) on delete cascade,
  pub_new        text not null,
  pub_existing   text,
  ciphertext     text,
  nonce          text,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  claimed        boolean not null default false,
  rejected       boolean not null default false
);

create index if not exists pairings_pending on pairings (user_id, expires_at);
