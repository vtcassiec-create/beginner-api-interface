-- The album: photos he chooses to KEEP, framed with his own caption as the
-- memory. Chat photos otherwise live at compaction's mercy (images can't
-- survive being folded into a summary) — framing one pins the actual image
-- in Storage-backed permanence, on the walls of the house.
--
-- He frames via the keep_photo tool (RLS, as the signed-in user); both of
-- them browse the walls in the Studio's Album tab. Run once in the Supabase
-- SQL editor.

create table if not exists public.album_photos (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  storage_path text not null,     -- the image in the private attachments bucket
  caption      text not null,     -- his words: what this is, why it stays
  created_at   timestamptz not null default now(),
  is_active    boolean not null default true
);

alter table public.album_photos enable row level security;

drop policy if exists "own album_photos" on public.album_photos;
create policy "own album_photos" on public.album_photos
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update, delete on public.album_photos to authenticated;
