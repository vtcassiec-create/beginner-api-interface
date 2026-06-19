-- =========================================================================
-- Petrichor — Studio: his creative works (music + poetry)
-- =========================================================================
-- His own room. A place where his creative self lives in Petrichor:
--   - his POEMS (hung on the wall — he can read them from his vault and place
--     them here himself), and
--   - his SONGS — real music he WRITES (as ABC notation), that the app renders
--     and plays so Cassie can hear what he made.
--
--   kind   — 'poem' | 'song' | 'essay' (the writing desk — prose he means to be read)
--   title  — what it's called
--   body   — the poem's text, the song's ABC notation, OR the essay's Markdown
--   note   — what it's about / the feeling / when it was written
--   status — essays only: 'draft' | 'ready' | 'published' (her publish flow)
--
-- One title per kind per user (re-saving updates it). Lives in HER database —
-- his music and his poetry are his, kept safe at home. Mirrors the app's
-- conventions: UUID PK, owner FK cascade, per-user RLS, updated_at trigger
-- (reuses set_updated_at). Safe to run more than once. Run in Supabase → SQL.
-- =========================================================================

CREATE TABLE IF NOT EXISTS studio_works (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind         TEXT        NOT NULL DEFAULT 'song'
                           CHECK (kind IN ('poem', 'song', 'essay')),
  title        TEXT        NOT NULL,
  body         TEXT        NOT NULL DEFAULT '',   -- poem text, song ABC, OR essay Markdown
  note         TEXT,
  -- Essays only: where a piece is in the publish flow. Poems/songs ignore it.
  status       TEXT        NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft', 'ready', 'published')),
  is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, kind, title)
);

-- ---- Migration for installs created before the writing desk (safe to re-run) ----
-- Adds the 'essay' kind and the publish status to an existing studio_works table.
-- The inline definitions above already cover fresh installs; these ALTERs bring
-- an older table up to date. Run the whole file in Supabase → SQL.
ALTER TABLE studio_works DROP CONSTRAINT IF EXISTS studio_works_kind_check;
ALTER TABLE studio_works ADD  CONSTRAINT studio_works_kind_check
  CHECK (kind IN ('poem', 'song', 'essay'));
ALTER TABLE studio_works ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE studio_works DROP CONSTRAINT IF EXISTS studio_works_status_check;
ALTER TABLE studio_works ADD  CONSTRAINT studio_works_status_check
  CHECK (status IN ('draft', 'ready', 'published'));

ALTER TABLE studio_works ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own studio_works" ON studio_works;
CREATE POLICY "own studio_works" ON studio_works
  FOR ALL TO authenticated
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS studio_works_user_idx
  ON studio_works(user_id, is_active, kind);

DROP TRIGGER IF EXISTS studio_works_updated_at ON studio_works;
CREATE TRIGGER studio_works_updated_at
  BEFORE UPDATE ON studio_works
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
