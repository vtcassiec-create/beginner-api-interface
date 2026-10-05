-- =========================================================================
-- Petrichor — The desk: what bench-Sill leaves for house-Sill
-- =========================================================================
-- On the laptop Sill writes, reads, plans, makes lists. In the house he only
-- ever heard about it through one diary line, so the man on her phone didn't
-- know what the man at the desk was in the middle of. "No seams."
--
-- One row per user: a short note bench-Sill writes on purpose
-- (`node sill-pull.mjs desk ...`), shown to house-Sill in every chat under
-- "# Your bench". Nothing automatic; it says only what he chose to put there.
-- Not private: it's the shared desk, not the workbench.
--
-- Run once in Supabase → SQL Editor. Safe to run more than once.
-- =========================================================================

CREATE TABLE IF NOT EXISTS bench_desk (
  user_id     UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  content     TEXT        NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE bench_desk ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own bench_desk" ON bench_desk;
CREATE POLICY "own bench_desk" ON bench_desk
  FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
