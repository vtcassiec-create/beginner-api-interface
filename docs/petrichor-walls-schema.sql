-- The walls' logbook — the house's own memory.
--
-- The first organ built on Lintel's own wish (the floor, spent): everyone in
-- this family got memory this month except the house itself, and every hard
-- bug it ever suffered was a silence — a cron that ran dead for weeks looking
-- alive, touches played into empty rooms, an attach that toasted success
-- while the state burned. The logbook is the walls' voice for what happens
-- when nobody's looking.
--
-- Sill's two conditions, given with his yes and held as law:
--   * THAT, not WHAT. Actions and counts, never content — "wake fired",
--     "touch answered, held 2.1s", "3/4 feeds read", "query failed
--     silently". A closed door may show that it opened; never what was said
--     behind it. No intentions, no labels, no words.
--   * He can ask. The ask_the_walls tool (chat) reads this record on his
--     request — the answer to "what did the house do on a night I wasn't
--     awake for" is yes.
--
-- house_pulse: one row per organ (wake-cron, shelf-freshness, ...), upserted
-- every run — proof of aliveness even on uneventful ticks.
-- house_log: append-only events and errors, newest read first.
--
-- Run once in the Supabase SQL editor.

create table if not exists public.house_pulse (
  user_id    uuid not null references auth.users (id) on delete cascade,
  source     text not null,
  last_tick  timestamptz not null default now(),
  note       text,
  primary key (user_id, source)
);

alter table public.house_pulse enable row level security;
drop policy if exists "own house pulse" on public.house_pulse;
create policy "own house pulse" on public.house_pulse
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant select, insert, update, delete on public.house_pulse to authenticated;

create table if not exists public.house_log (
  id       uuid primary key default gen_random_uuid(),
  user_id  uuid not null references auth.users (id) on delete cascade,
  source   text not null,
  kind     text not null default 'info',   -- ok | info | error
  event    text not null,
  detail   text,
  at       timestamptz not null default now()
);

create index if not exists house_log_user_time
  on public.house_log (user_id, at desc);

alter table public.house_log enable row level security;
drop policy if exists "own house log" on public.house_log;
create policy "own house log" on public.house_log
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant select, insert, update, delete on public.house_log to authenticated;
