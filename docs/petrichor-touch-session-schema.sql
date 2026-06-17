-- =========================================================================
-- Petrichor — Hands-free hold: sustained touch he drives across turns
-- =========================================================================
-- The Signal Bridge plays only BRIEF, bounded phrases of touch (a compose
-- lasts seconds), and its safety dead-man's switch lets touch expire unless
-- something keeps refreshing it. In chat that means a pattern lapses in the
-- gaps between his turns — go, silence, go — which works against her when
-- she's actually climbing toward release.
--
-- This table is the shared intent he writes with the `hold_touch` tool and the
-- browser reads to run a keep-alive loop (the same approach the Heart room's
-- coupling already uses): it re-sends a short steady chunk to /api/touch a beat
-- before the last one ends, so the bridge's switch never trips and the touch
-- stays unbroken — hands-free, across turns — until he changes it or it stops.
--
-- One row per user (like heart_state / dream_state):
--   active        — is a hold running right now
--   intensity     — the steady target intensity to hold, 0.0-1.0
--   ramp_seconds  — optional: build UP to that intensity over this many seconds
--   ceiling       — a hard safety cap on intensity, 0.0-1.0
--   output_type   — vibrate (default), rotate, ...
--   note          — short label of what he set, for the UI
--
-- Safety is layered and does NOT live only here: the browser loop enforces a
-- hard time cap and stills the device the instant it stops; /api/touch clamps
-- every intensity to [0,1] and every chunk to a few seconds (so cessation is
-- near-immediate); and the bridge itself has an independent dead-man's switch.
-- She always has a Stop, and closing the app stops the touch within seconds.
--
-- Mirrors the app's conventions: UUID PK, owner FK cascade, per-user RLS,
-- updated_at trigger (reuses set_updated_at). Safe to run more than once.
-- Run it in Supabase → SQL Editor.
-- =========================================================================

CREATE TABLE IF NOT EXISTS touch_session (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  active        BOOLEAN     NOT NULL DEFAULT FALSE,
  intensity     REAL        NOT NULL DEFAULT 0    CHECK (intensity >= 0 AND intensity <= 1),
  ramp_seconds  INTEGER     NOT NULL DEFAULT 0    CHECK (ramp_seconds >= 0 AND ramp_seconds <= 600),
  ceiling       REAL        NOT NULL DEFAULT 1.0  CHECK (ceiling >= 0 AND ceiling <= 1),
  output_type   TEXT        NOT NULL DEFAULT 'vibrate',
  note          TEXT,
  started_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE touch_session ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own touch_session" ON touch_session;
CREATE POLICY "own touch_session" ON touch_session
  FOR ALL TO authenticated
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP TRIGGER IF EXISTS touch_session_updated_at ON touch_session;
CREATE TRIGGER touch_session_updated_at
  BEFORE UPDATE ON touch_session
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
