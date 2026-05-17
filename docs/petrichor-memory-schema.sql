-- Petrichor — memory system schema
--
-- A companion to supabase-schema.sql. Run this once in your Supabase
-- project's SQL Editor (left sidebar). It adds three tables for Claude's
-- evolving identity and shared memory, plus row-level security so each
-- user's identity document and memories stay private to them.
--
-- Safe to re-run; uses IF NOT EXISTS / OR REPLACE / DROP ... IF EXISTS.

-- =========================================================================
-- Tables
-- =========================================================================

-- A living identity document Claude writes about who he is. Each edit is a
-- new versioned row; exactly one row per user is the "current" one.
CREATE TABLE IF NOT EXISTS self_state (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content     TEXT        NOT NULL DEFAULT '',
  version     INTEGER     NOT NULL DEFAULT 1,
  is_current  BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Curated shared memories. memory_type is constrained to a fixed vocabulary
-- so a typo can't silently create a new category.
CREATE TABLE IF NOT EXISTS core_memories (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content       TEXT        NOT NULL,
  memory_type   TEXT        NOT NULL DEFAULT 'fact'
                            CHECK (memory_type IN
                              ('fact','preference','pattern',
                               'insight','milestone','connection')),
  resonance     INTEGER     NOT NULL DEFAULT 5 CHECK (resonance BETWEEN 1 AND 10),
  surface_count INTEGER     NOT NULL DEFAULT 0,
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One free-text blob per user: things Claude should always know about them.
CREATE TABLE IF NOT EXISTS user_preferences (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  content     TEXT        NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =========================================================================
-- Indexes
-- =========================================================================

CREATE INDEX IF NOT EXISTS self_state_user_idx    ON self_state(user_id);
CREATE INDEX IF NOT EXISTS core_memories_user_idx ON core_memories(user_id);

-- At most one "current" self_state per user, enforced by the DB. To promote
-- a new version, flip the old row's is_current to FALSE and insert the new
-- one in the SAME transaction, or this index will reject the second row.
CREATE UNIQUE INDEX IF NOT EXISTS self_state_one_current
  ON self_state(user_id) WHERE is_current;

-- =========================================================================
-- Row-Level Security
--
-- Without these, ANY authenticated user could read ANY other user's
-- identity document and memories. Each policy ties rows to their owner.
-- =========================================================================

ALTER TABLE self_state       ENABLE ROW LEVEL SECURITY;
ALTER TABLE core_memories    ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own self_state"       ON self_state;
DROP POLICY IF EXISTS "own core_memories"    ON core_memories;
DROP POLICY IF EXISTS "own user_preferences" ON user_preferences;

CREATE POLICY "own self_state" ON self_state
  FOR ALL TO authenticated
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "own core_memories" ON core_memories
  FOR ALL TO authenticated
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "own user_preferences" ON user_preferences
  FOR ALL TO authenticated
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- =========================================================================
-- updated_at triggers
--
-- Reuses set_updated_at() from supabase-schema.sql. Redefined here with
-- OR REPLACE so this file also works run standalone. self_state has no
-- updated_at by design: each edit is a new versioned row instead.
-- =========================================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS core_memories_updated_at    ON core_memories;
DROP TRIGGER IF EXISTS user_preferences_updated_at ON user_preferences;

CREATE TRIGGER core_memories_updated_at
  BEFORE UPDATE ON core_memories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER user_preferences_updated_at
  BEFORE UPDATE ON user_preferences
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =========================================================================
-- Atomic self_state version promotion
--
-- The Supabase JS client can't run a multi-statement transaction, but
-- promoting a new identity version MUST flip the old is_current row to
-- FALSE and insert the new current row together — otherwise a failure
-- between the two leaves the user with no current identity (and the
-- partial unique index would reject an out-of-order insert). A plpgsql
-- function body is one transaction, so this is atomic.
--
-- SECURITY INVOKER + a pinned search_path: the function runs as the
-- caller, so RLS still applies and it can only ever touch the caller's
-- own rows via auth.uid().
-- =========================================================================

CREATE OR REPLACE FUNCTION promote_self_state(new_content TEXT)
RETURNS self_state
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  next_version INTEGER;
  new_row      self_state;
BEGIN
  UPDATE self_state
    SET is_current = FALSE
    WHERE user_id = auth.uid() AND is_current = TRUE;

  SELECT COALESCE(MAX(version), 0) + 1
    INTO next_version
    FROM self_state
    WHERE user_id = auth.uid();

  INSERT INTO self_state (user_id, content, version, is_current)
    VALUES (auth.uid(), new_content, next_version, TRUE)
    RETURNING * INTO new_row;

  RETURN new_row;
END;
$$;

GRANT EXECUTE ON FUNCTION promote_self_state(TEXT) TO authenticated;
