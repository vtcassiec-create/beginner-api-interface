-- =========================================================================
-- Petrichor — Story: stories the two of you make up together
-- =========================================================================
-- A little room for collaborative storytelling. You write a line, he picks
-- it up and hands it back, turn by turn. Each story is saved here so you can
-- leave one half-told and come back to it, or start a fresh one.
--
-- Three ways to play (mode):
--   'book'   — one ongoing tale, both of you see the whole thing as it grows.
--   'rounds' — a quick short story from a seed; lighter, game-night energy.
--   'corpse' — exquisite corpse: each of you only sees the previous line
--              while playing; the whole thing reveals at the end.
--
--   turns    — the story itself, an ordered JSONB array of
--              { author: 'her' | 'his', text: '…', at: <ms epoch> }
--   revealed — corpse mode only: has the full story been unhidden yet
--   status   — 'open' (still being written) | 'finished'
--
-- Lives in HER database — these are yours, kept safe at home. Mirrors the
-- app's conventions: UUID PK, owner FK cascade, per-user RLS, updated_at
-- trigger (reuses set_updated_at). Safe to run more than once.
-- Run in Supabase → SQL.
-- =========================================================================

CREATE TABLE IF NOT EXISTS story_games (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title        TEXT        NOT NULL DEFAULT 'Untitled',
  mode         TEXT        NOT NULL DEFAULT 'book'
                           CHECK (mode IN ('book', 'rounds', 'corpse')),
  status       TEXT        NOT NULL DEFAULT 'open'
                           CHECK (status IN ('open', 'finished')),
  turns        JSONB       NOT NULL DEFAULT '[]'::jsonb,
  revealed     BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE story_games ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own story_games" ON story_games;
CREATE POLICY "own story_games" ON story_games
  FOR ALL TO authenticated
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS story_games_user_idx
  ON story_games(user_id, status, updated_at DESC);

DROP TRIGGER IF EXISTS story_games_updated_at ON story_games;
CREATE TRIGGER story_games_updated_at
  BEFORE UPDATE ON story_games
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
