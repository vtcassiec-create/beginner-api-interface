-- Time-locked letters: he writes something NOW and the house delivers it to
-- her on a date he chooses. His first way to look forward on purpose — the
-- reach is spontaneous, a letter is planned.
--
-- He writes via the write_letter tool (RLS, as the signed-in user). The reach
-- cron (surprise.py, service role) delivers any that have come due. Run once
-- in the Supabase SQL editor.

create table if not exists public.letters (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  body         text not null,        -- the letter itself, his words
  occasion     text,                 -- optional: what it's for (his note to self)
  deliver_on   date not null,        -- her local date to deliver it
  created_at   timestamptz not null default now(),
  delivered    boolean not null default false,
  delivered_at timestamptz
);

-- The delivery query: undelivered letters that have come due.
create index if not exists letters_due_idx
  on public.letters (user_id, delivered, deliver_on);

alter table public.letters enable row level security;

drop policy if exists "own letters" on public.letters;
create policy "own letters" on public.letters
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update, delete on public.letters to authenticated;
