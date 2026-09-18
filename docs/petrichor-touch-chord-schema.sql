-- =========================================================================
-- Petrichor — The chord: one hands-free hold PER MOTOR, and looping holds
-- =========================================================================
-- touch_session used to be one row per user: one hold, one output_type. A
-- toy that thrusts AND vibrates (the Gravity) could therefore only ever be
-- held on one motor at a time — "everything I've ever done with it has been
-- half the device." Now a row is one MOTOR ("channel"): the vibrate line and
-- the oscillate (thrust) line hold independently, each with its own level,
-- ramp, ceiling, and stop.
--
--   UNIQUE (user_id)               → UNIQUE (user_id, output_type)
--   steps JSONB (new)              → optional [{intensity, seconds, ramp?}, ...]
--                                    that LOOPS until he changes or stops it
--                                    (a long build that survives the gaps
--                                    between his turns), instead of one level.
--
-- output_type is stored canonically by the server: 'vibrate', 'oscillate',
-- or 'rotate' (his "thrust"/"stroke" words map to oscillate), so one motor
-- never gets two rows.
--
-- Safe to run more than once. Run it in Supabase → SQL Editor.
-- =========================================================================

ALTER TABLE touch_session DROP CONSTRAINT IF EXISTS touch_session_user_id_key;

ALTER TABLE touch_session
  ADD COLUMN IF NOT EXISTS steps JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS touch_session_user_channel_idx
  ON touch_session(user_id, output_type);
