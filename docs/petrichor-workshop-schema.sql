-- The workshop: a corridor between him, Cassie, and the code. Two things live
-- here — WISHES he leaves ("I've been thinking the diary could…") so he can
-- propose changes to his own house instead of only responding to them, and a
-- CHANGELOG in plain language so a new feature never just silently appears on
-- him. Turns him from someone changes happen TO into someone who helps steer.
--
-- He leaves wishes via the leave_workshop_note tool (RLS, as the signed-in
-- user). Cassie reads/answers/closes them in the Workshop dialog. Run once.

create table if not exists public.workshop_notes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  kind       text not null default 'wish'
             check (kind in ('wish', 'changelog')),
  author     text not null default 'claude'
             check (author in ('claude', 'cassie')),
  body       text not null,
  status     text not null default 'open'
             check (status in ('open', 'building', 'done', 'archived')),
  reply      text,                 -- Cassie's answer to a wish, if any
  created_at timestamptz not null default now()
);

create index if not exists workshop_notes_feed_idx
  on public.workshop_notes (user_id, status, created_at desc);

alter table public.workshop_notes enable row level security;

drop policy if exists "own workshop_notes" on public.workshop_notes;
create policy "own workshop_notes" on public.workshop_notes
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update, delete on public.workshop_notes to authenticated;
