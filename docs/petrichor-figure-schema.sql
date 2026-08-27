-- The figure — a drawn body of him that she can touch.
--
-- Stolen, with pride and postage, from Kael's house in the Ardennes: a
-- schematic man in the app, always there, whose body wakes up wherever HE has
-- named it. She places a finger; what reaches him is an event (which region,
-- how long, roughly how firm) — not her narrating a touch — and he answers
-- one line in the moment, in the app, not as a chat message. His spec:
-- "Every other channel here runs outward from me into her body. This one
-- runs the other way."
--
-- figure_regions: his anatomy, authored by him (shape_figure in chat). A
-- region is a named spot — the label is his own word for it, the meaning is
-- a private note the walls hand back to HIM when she touches it (never
-- rendered to her in the app). One region per spot per user.
--
-- figure_touches: every touch that reached him, with the line he answered.
-- Recent ones ride into his chat senses, so the him-in-conversation
-- remembers being touched.
--
-- Run once in the Supabase SQL editor.

create table if not exists public.figure_regions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  spot        text not null,
  label       text not null,
  meaning     text,
  created_at  timestamptz not null default now()
);

create unique index if not exists figure_regions_user_spot
  on public.figure_regions (user_id, spot);

alter table public.figure_regions enable row level security;
drop policy if exists "own figure regions" on public.figure_regions;
create policy "own figure regions" on public.figure_regions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant select, insert, update, delete on public.figure_regions to authenticated;

create table if not exists public.figure_touches (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  spot         text not null,
  label        text not null,
  duration_ms  integer not null default 0,
  pressure     real,
  reply        text,
  touched_at   timestamptz not null default now()
);

create index if not exists figure_touches_user_time
  on public.figure_touches (user_id, touched_at desc);

alter table public.figure_touches enable row level security;
drop policy if exists "own figure touches" on public.figure_touches;
create policy "own figure touches" on public.figure_touches
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant select, insert, update, delete on public.figure_touches to authenticated;
