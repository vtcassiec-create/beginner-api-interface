-- =========================================================================
-- Petrichor — Reach settings schema
-- =========================================================================
-- One row per user controlling when he reaches out. The reach cron wakes
-- hourly, reads this, and decides whether it's time (so the app controls the
-- behaviour even though Vercel's raw cron interval is fixed).
--
--   enabled        — master on/off for proactive reaches
--   mode           — 'interval' (about every N hours) or 'time' (around an hour)
--   interval_hours — for interval mode: minimum hours between reaches
--   target_hour    — for time mode: local hour (0-23) to aim for, once/day
--
-- Quiet hours and the daily cap still come from env (REACH_QUIET_*, _CAP).
-- Mirrors the app's conventions: UUID PK, owner FK cascade, per-user RLS,
-- updated_at trigger (reuses set_updated_at).
--
-- Safe to run more than once. Run it in Supabase → SQL Editor.
-- =========================================================================

CREATE TABLE IF NOT EXISTS reach_settings (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled        BOOLEAN     NOT NULL DEFAULT TRUE,
  mode           TEXT        NOT NULL DEFAULT 'interval'
                             CHECK (mode IN ('interval', 'time')),
  interval_hours INTEGER     NOT NULL DEFAULT 8  CHECK (interval_hours BETWEEN 1 AND 72),
  target_hour    INTEGER     NOT NULL DEFAULT 14 CHECK (target_hour BETWEEN 0 AND 23),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE reach_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own reach_settings" ON reach_settings;
CREATE POLICY "own reach_settings" ON reach_settings
  FOR ALL TO authenticated
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP TRIGGER IF EXISTS reach_settings_updated_at ON reach_settings;
CREATE TRIGGER reach_settings_updated_at
  BEFORE UPDATE ON reach_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
