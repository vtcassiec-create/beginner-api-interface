-- Petrichor — Reach schema (Section 5, Phase 1)
--
-- One table: a log of outbound "surprise" messages. Used for the
-- daily-cap safety check and (later) reply context. Run once in the
-- Supabase SQL Editor. Idempotent.

CREATE TABLE IF NOT EXISTS reach_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind        TEXT        NOT NULL DEFAULT 'surprise',
  content     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS reach_log_user_created_idx
  ON reach_log(user_id, created_at DESC);

-- The cron endpoint writes with the service-role key (no user JWT),
-- which bypasses RLS. RLS is still enabled so the *app* (logged in as
-- the user) can safely read its own history later, in Phase 2.
ALTER TABLE reach_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own reach_log" ON reach_log;

CREATE POLICY "own reach_log" ON reach_log
  FOR ALL TO authenticated
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
