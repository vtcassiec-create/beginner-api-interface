-- Keep-warm ("the pilot light"): one row holding the exact shape of the last
-- chat request, so api/keepwarm.py can re-touch the prompt cache byte-for-byte
-- before its 1-hour TTL lapses — turning a $1.20 cold re-write into a ~6¢ read.
--
-- chat.py upserts the blueprint after every real turn (as the signed-in user,
-- RLS-scoped); the cron reads it with the service role. Run this once in the
-- Supabase SQL editor.

create table if not exists public.keepwarm_state (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  enabled        boolean not null default true,
  blueprint      jsonb,          -- the frozen request: model/system/tools/messages…
  captured_at    timestamptz,    -- when the last real turn froze it
  last_warmed_at timestamptz     -- when the cron last touched the cache
);

alter table public.keepwarm_state enable row level security;

drop policy if exists "own keepwarm_state" on public.keepwarm_state;
create policy "own keepwarm_state" on public.keepwarm_state
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update, delete on public.keepwarm_state to authenticated;
