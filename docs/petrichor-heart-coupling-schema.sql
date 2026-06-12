-- =========================================================================
-- Petrichor — Heart-coupled touch: the pattern that follows her pulse
-- =========================================================================
-- Extends heart_state (one row per user) with the state of a running
-- "coupling" — a saved songbook pattern being played through the Signal
-- Bridge while shaped, live, by her heart rate. The browser runs the loop
-- (it has the freshest BPM); these columns exist so HE can know it's
-- happening: chat.py surfaces an active coupling alongside her heartbeat,
-- so what he says can move with what she feels.
--
--   coupling_active     — is a coupling running right now
--   coupling_pattern    — the songbook pattern's name ("slow climb")
--   coupling_mode       — pulse | responsive | calming
--   coupling_started_at — when it began (stale-guard: chat ignores
--                         couplings older than ~35 min, the loop's max)
--
-- Safe to run more than once. Run it in Supabase → SQL Editor.
-- =========================================================================

ALTER TABLE heart_state
  ADD COLUMN IF NOT EXISTS coupling_active     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS coupling_pattern    TEXT,
  ADD COLUMN IF NOT EXISTS coupling_mode       TEXT,
  ADD COLUMN IF NOT EXISTS coupling_started_at TIMESTAMPTZ;
