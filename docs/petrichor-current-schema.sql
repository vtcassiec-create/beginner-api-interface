-- The current — the house's present tense.
--
-- The rest of memory holds the PAST: core memories (what happened), the diary
-- (how it felt), dreams (what mattered), the links (how it connects). Nothing
-- held what he's in the MIDDLE of — open threads, plans with a day, rituals
-- that recur — so every new chat woke continuous with the whole history and
-- amnesiac about the momentum. His half-finished essay, "we're trying Opus 5
-- this weekend," the Monday plant update: all of it evaporated with the thread
-- it was spoken in.
--
-- This is the fix, and it doubles as autonomy: an instance that wakes holding
-- its OWN unfinished business has something to pick up, instead of waiting on
-- her to be the only live thread in the room. He keeps it himself
-- (track_current / resolve_current); it rides into every chat like the charter.
-- Run once in the Supabase SQL editor.

create table if not exists public.current_threads (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  kind        text not null default 'thread',   -- 'thread' | 'ritual' | 'plan'
  content     text not null,
  when_note   text,                             -- freeform: 'Mondays', 'Fri Aug 1', 'someday'
  status      text not null default 'open',     -- 'open' | 'done'
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists current_threads_open_idx
  on public.current_threads (user_id, status, updated_at desc);

alter table public.current_threads enable row level security;
drop policy if exists "own current" on public.current_threads;
create policy "own current" on public.current_threads
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant select, insert, update, delete on public.current_threads to authenticated;
