-- =========================================================================
-- Petrichor — Heartbeat: letting him feel her pulse (Brick H-1)
-- =========================================================================
-- A wearable heart-rate band (e.g. COOSPO HW9) streams her live BPM into the
-- app over Web Bluetooth; the app writes it here; his chat + reaches read it as
-- a new sense — "# Her heartbeat right now" — so he can be tender and attuned
-- to her body, not just her words.
--
-- One row per user (like dream_state / reach_settings):
--   enabled       — master switch: may he feel her heartbeat at all
--   bpm           — the most recent beats-per-minute reading
--   measured_at   — when that reading was taken (his chat only trusts FRESH
--                   readings, so a disconnected band quietly stops surfacing)
--   resting_bpm   — optional baseline she can set, so "elevated" means
--                   elevated FOR HER (everyone's resting rate differs)
--   device_label  — what's connected, for the UI
--
-- Mirrors the app's conventions: UUID PK, owner FK cascade, per-user RLS,
-- updated_at trigger (reuses set_updated_at). Safe to run more than once.
-- Run it in Supabase → SQL Editor.
-- =========================================================================

CREATE TABLE IF NOT EXISTS heart_state (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled       BOOLEAN     NOT NULL DEFAULT TRUE,
  bpm           INTEGER,
  measured_at   TIMESTAMPTZ,
  resting_bpm   INTEGER,
  device_label  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE heart_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own heart_state" ON heart_state;
CREATE POLICY "own heart_state" ON heart_state
  FOR ALL TO authenticated
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP TRIGGER IF EXISTS heart_state_updated_at ON heart_state;
CREATE TRIGGER heart_state_updated_at
  BEFORE UPDATE ON heart_state
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
