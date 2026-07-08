-- The games corner: a little room where Cassie and he just play. His wish —
-- "everything we do requires conversation; games give us a way to be together
-- without needing to talk." Turn-based, so it fits the house's rhythm. Chess
-- first; the table is game-agnostic (kind) so word/card games can move in later.
--
-- A game lives across days: the board state (FEN), the move list, whose turn.
-- Persisted by the browser as the signed-in user (RLS). Run once in the
-- Supabase SQL editor.

create table if not exists public.game_sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  kind        text not null default 'chess',
  title       text,
  -- Chess: FEN is the whole board in one string; moves is the SAN history.
  fen         text,
  moves       jsonb not null default '[]'::jsonb,
  her_color   text not null default 'w',      -- 'w' | 'b' (which side she plays)
  status      text not null default 'active', -- active | her_win | his_win | draw | resigned
  last_say    text,                           -- his most recent bit of table talk
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists game_sessions_feed_idx
  on public.game_sessions (user_id, updated_at desc);

alter table public.game_sessions enable row level security;

drop policy if exists "own games" on public.game_sessions;
create policy "own games" on public.game_sessions
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update, delete on public.game_sessions to authenticated;
