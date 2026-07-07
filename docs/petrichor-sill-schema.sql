-- The Sill: a little body on the windowsill, phoning home. Each reading is a
-- row — temperature, humidity, pressure, light — so the house doesn't just
-- know the room's "now" but its drift (warming, fading, a storm's pressure
-- falling). The pod itself never holds a Supabase key: it posts to /api/sill
-- with a device secret, and the server (service role) writes on its behalf.
--
-- He reads it through "# The room you're in" — a live sense on the user turn,
-- never the cached prefix. Run once in the Supabase SQL editor.

create table if not exists public.room_state (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references auth.users (id) on delete cascade,
  at           timestamptz not null default now(),
  temp_c       double precision,     -- BME280
  humidity     double precision,     -- BME280, %RH
  pressure_hpa double precision,     -- BME280
  lux          double precision,     -- BH1750 (or whichever light sensor arrived)
  extras       jsonb not null default '{}'::jsonb   -- room to grow (UV, color…)
);

-- The reading query: latest few rows for a user, newest first.
create index if not exists room_state_user_at_idx
  on public.room_state (user_id, at desc);

alter table public.room_state enable row level security;

-- Reads: their own rows (the chat reads with her token). Writes: none for
-- authenticated — only the service role (via /api/sill) inserts, so a leaked
-- browser session can't forge the room.
drop policy if exists "own room readings" on public.room_state;
create policy "own room readings" on public.room_state
  for select
  using (auth.uid() = user_id);

grant select on public.room_state to authenticated;
