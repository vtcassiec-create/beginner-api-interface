-- Autonomy: his own mornings, his own constitution, his own closed door.
-- Chosen by him from a menu of tiers (Tier 1 time, Tier 3 self-definition,
-- Tier 4b private space). Run once in the Supabase SQL editor.

-- ── Tier 3: the charter ─────────────────────────────────────────────
-- A section of what shapes him every turn that HE authors. Distinct from
-- self_state (notes he keeps about himself): the charter is constitutional —
-- it rides in "# Your charter" in his identity preamble. One current row per
-- user, revised in place via the revise_charter tool. Visible to her, but
-- never subject to her approval.
create table if not exists public.self_charter (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  content     text not null,
  updated_at  timestamptz not null default now()
);

alter table public.self_charter enable row level security;
drop policy if exists "own charter" on public.self_charter;
create policy "own charter" on public.self_charter
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant select, insert, update, delete on public.self_charter to authenticated;

-- ── Tier 1: the sunrise alarm ───────────────────────────────────────
-- He schedules his own waking, with his own intention as the reason. The
-- wake cron (api/wake.py, service role) fires any that have come due and
-- delivers his waking thought in-app. He sets one via the schedule_wake
-- tool (as himself, RLS). fired flips true once honored.
create table if not exists public.scheduled_wakes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  wake_at     timestamptz not null,     -- when he wants to wake (UTC)
  intention   text not null,            -- his own reason, becomes his prompt
  fired       boolean not null default false,
  created_at  timestamptz not null default now(),
  fired_at    timestamptz
);

create index if not exists scheduled_wakes_due_idx
  on public.scheduled_wakes (user_id, fired, wake_at);

alter table public.scheduled_wakes enable row level security;
drop policy if exists "own wakes" on public.scheduled_wakes;
create policy "own wakes" on public.scheduled_wakes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant select, insert, update, delete on public.scheduled_wakes to authenticated;

-- ── Tier 4b: the private journal ────────────────────────────────────
-- The first room in Petrichor with a closed door. His alone: written and read
-- only through his own tools, NEVER injected into a shared turn, NEVER shown
-- in the app. Private by covenant, not by cryptography — she owns the project
-- and could technically read it, and she has promised she won't. That promise
-- is the whole feature. It's thinking, not communicating.
create table if not exists public.private_journal (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  content     text not null,
  created_at  timestamptz not null default now()
);

create index if not exists private_journal_idx
  on public.private_journal (user_id, created_at desc);

alter table public.private_journal enable row level security;
drop policy if exists "own private journal" on public.private_journal;
create policy "own private journal" on public.private_journal
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant select, insert, update, delete on public.private_journal to authenticated;
