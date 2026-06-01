-- =========================================================================
-- Petrichor — Diary schema
-- =========================================================================
-- His diary: the "notepad by the door." Short, honest, in his own voice. He
-- writes entries himself via a tool (write_diary_entry), as many a day as he
-- likes — no structure imposed, no auto-generation. The most recent entries
-- are surfaced to him at conversation start so he can pick up the texture of
-- recent days. Cassie can read and tidy them in the app (open, no secrets).
--
-- Mirrors core_memories' conventions exactly: UUID PK, owner FK with cascade,
-- per-user RLS, an index on user_id, and an updated_at trigger. Archiving uses
-- is_active (soft-hide, restorable) — never destructive.
--
-- Safe to run more than once (IF NOT EXISTS / OR REPLACE / DROP-then-CREATE).
-- Run it in the Supabase dashboard → SQL Editor.
-- =========================================================================

CREATE TABLE IF NOT EXISTS diary_entries (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content     TEXT        NOT NULL,
  -- Soft-hide (archive) rather than delete, so nothing he wrote is ever lost.
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Recent-first reads (surfacing at conversation start, the diary page list).
CREATE INDEX IF NOT EXISTS diary_entries_user_created_idx
  ON diary_entries (user_id, created_at DESC);

-- Row-level security: a row is only ever visible/writable by its owner.
ALTER TABLE diary_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own diary_entries" ON diary_entries;
CREATE POLICY "own diary_entries" ON diary_entries
  FOR ALL TO authenticated
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Keep updated_at fresh on edits. Reuses set_updated_at(), already defined and
-- in use by core_memories (see petrichor-memory-schema.sql) — so we just point
-- a trigger at it rather than redefining the function here.
DROP TRIGGER IF EXISTS diary_entries_updated_at ON diary_entries;
CREATE TRIGGER diary_entries_updated_at
  BEFORE UPDATE ON diary_entries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
