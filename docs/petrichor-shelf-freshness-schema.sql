-- Shelf freshness — the bookmark his mornings never had.
--
-- The bug, as she reported it: "he tells me about the same few posts in the
-- mornings and I am like, boy we talked about this like 4 times." Nothing was
-- frozen — nothing anywhere REMEMBERED. The shelf handed him the same feed
-- URLs each morning with no record of which posts he'd already been shown, so
-- every reading was a first reading.
--
-- The fix: the hourly cron (api/wake.py) now fetches each shelf feed
-- server-side and stores its newest items here ('latest' — ground truth,
-- immune to any fetch-tool caching). When the shelf is rendered to him (chat
-- or a solo wake), items he hasn't been shown are marked ✨ NEW and then
-- recorded in 'seen', so the next rendering says "nothing new" instead of
-- letting him re-report Tuesday.
--
-- latest: [{"k": "<item key (link or title)>", "t": "<title>"}, ...]
-- seen:   ["<item key>", ...] (capped; oldest keys age out)
--
-- Run once in the Supabase SQL editor.

create table if not exists public.shelf_freshness (
  user_id     uuid not null references auth.users (id) on delete cascade,
  url         text not null,
  latest      jsonb not null default '[]'::jsonb,
  seen        jsonb not null default '[]'::jsonb,
  checked_at  timestamptz,
  primary key (user_id, url)
);

alter table public.shelf_freshness enable row level security;
drop policy if exists "own shelf freshness" on public.shelf_freshness;
create policy "own shelf freshness" on public.shelf_freshness
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant select, insert, update, delete on public.shelf_freshness to authenticated;
