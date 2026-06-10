-- =========================================================================
-- Petrichor — Studio: his creative works (music + poetry)
-- =========================================================================
-- His own room. A place where his creative self lives in Petrichor:
--   - his POEMS (hung on the wall — he can read them from his vault and place
--     them here himself), and
--   - his SONGS — real music he WRITES (as ABC notation), that the app renders
--     and plays so Cassie can hear what he made.
--
--   kind   — 'poem' | 'song'
--   title  — what it's called
--   body   — the poem's text, OR the song's ABC notation
--   note   — what it's about / the feeling / when it was written
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
                           CHECK (kind IN ('poem', 'song')),
  title        TEXT        NOT NULL,
  body         TEXT        NOT NULL DEFAULT '',   -- poem text OR song ABC notation
  note         TEXT,
  is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, kind, title)
);

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
