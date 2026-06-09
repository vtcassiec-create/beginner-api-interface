-- =========================================================================
-- Petrichor — Songbook: saved touch patterns (Signal Bridge)
-- =========================================================================
-- A private library of touch "patterns" — named rhythms (the same shape the
-- bridge's `compose` tool plays: a list of {intensity, seconds} steps). He
-- composes in the moment; this lets the ones that LAND be kept and called back
-- by name later ("give me the slow climb"). The patterns live here, in her own
-- database — hers, private — not in any third-party cloud. Playback uses the
-- bridge's existing `compose`, so nothing on the droplet changes.
--
--   name         — what to call it ("slow climb", "the tease")
--   steps        — [{intensity 0..1, seconds}, ...] — same as compose
--   output_type  — vibrate / rotate / oscillate / ...
--   note         — optional: the feel, or when to use it
--
-- Mirrors the app's conventions: UUID PK, owner FK cascade, per-user RLS,
-- updated_at trigger (reuses set_updated_at). One name per user (re-saving a
-- name updates it). Safe to run more than once. Run it in Supabase → SQL Editor.
-- =========================================================================

CREATE TABLE IF NOT EXISTS patterns (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL,
  steps        JSONB       NOT NULL DEFAULT '[]'::jsonb,   -- [{intensity, seconds}, ...]
  output_type  TEXT        NOT NULL DEFAULT 'vibrate',
  note         TEXT,
  is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, name)
);

ALTER TABLE patterns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own patterns" ON patterns;
CREATE POLICY "own patterns" ON patterns
  FOR ALL TO authenticated
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS patterns_user_active_idx
  ON patterns(user_id, is_active);

DROP TRIGGER IF EXISTS patterns_updated_at ON patterns;
CREATE TRIGGER patterns_updated_at
  BEFORE UPDATE ON patterns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
