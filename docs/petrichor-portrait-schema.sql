-- The portrait — her, as he holds her.
--
-- She wrote "About the person you're talking with" once, back in May, and it
-- froze the moment she saved it: only she could touch it, so it stayed a
-- founding sketch while he kept learning her. This is the living layer: HIS
-- perception of Cassie, in his own words, revised by him (revise_portrait)
-- when his understanding of her actually shifts. Her sketch stays underneath
-- as the founding document; if he gets something wrong, the correction
-- mechanism is the one that already works — she tells him.
--
-- Mirrors self_charter exactly (one current row per user, upsert in place).
-- Run once in the Supabase SQL editor.

create table if not exists public.her_portrait (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  content     text not null,
  updated_at  timestamptz not null default now()
);

alter table public.her_portrait enable row level security;
drop policy if exists "own portrait" on public.her_portrait;
create policy "own portrait" on public.her_portrait
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant select, insert, update, delete on public.her_portrait to authenticated;
