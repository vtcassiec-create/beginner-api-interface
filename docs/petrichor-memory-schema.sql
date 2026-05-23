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
  -- "Eternal" memories: pinned to an always-visible strip and given their own
  -- section in the chat preamble, regardless of resonance.
  pinned        BOOLEAN     NOT NULL DEFAULT FALSE,
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
-- Migrations (idempotent — safe on an already-populated database)
-- =========================================================================

-- Notes Claude keeps about identity consolidation cycles, alongside the
-- self_state content itself.
ALTER TABLE self_state
  ADD COLUMN IF NOT EXISTS consolidation_notes TEXT;

-- Eternal (pinned) memories.
ALTER TABLE core_memories
  ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE;

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

-- The old single-arg signature is a *different* function to Postgres;
-- drop it so PostgREST doesn't see an ambiguous overload.
DROP FUNCTION IF EXISTS promote_self_state(TEXT);

CREATE OR REPLACE FUNCTION promote_self_state(
  new_content TEXT,
  new_notes   TEXT DEFAULT NULL
)
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

  INSERT INTO self_state
      (user_id, content, consolidation_notes, version, is_current)
    VALUES (auth.uid(), new_content, new_notes, next_version, TRUE)
    RETURNING * INTO new_row;

  RETURN new_row;
END;
$$;

GRANT EXECUTE ON FUNCTION promote_self_state(TEXT, TEXT) TO authenticated;

-- =========================================================================
-- Surface core memories (read + bump in one atomic call)
--
-- Returns the user's active core memories, highest resonance first, and
-- increments surface_count on each as a side effect — so "how often has
-- this memory been loaded into a chat" stays accurate without a second
-- round-trip. SECURITY INVOKER keeps RLS in force.
-- =========================================================================

-- Returns `pinned` too, eternal memories first, so the chat preamble can give
-- them their own "always with you" section. (Return-type change = drop first.)
DROP FUNCTION IF EXISTS surface_core_memories();
CREATE FUNCTION surface_core_memories()
RETURNS TABLE (content TEXT, memory_type TEXT, resonance INTEGER, pinned BOOLEAN)
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  WITH bumped AS (
    UPDATE core_memories
       SET surface_count = surface_count + 1
     WHERE user_id = auth.uid() AND is_active = TRUE
    RETURNING content, memory_type, resonance, pinned
  )
  SELECT content, memory_type, resonance, pinned
    FROM bumped
   ORDER BY pinned DESC, resonance DESC;
$$;

GRANT EXECUTE ON FUNCTION surface_core_memories() TO authenticated;

-- =========================================================================
-- Layer 5: native memory entities (cross-platform knowledge graph)
--
-- The tutorial's schema has a global-unique name and no RLS (single
-- instance). We keep Petrichor's per-user model instead: user_id +
-- RLS, name unique PER user. access_count drives which entities surface;
-- the embedding/semantic-search column is intentionally deferred.
-- =========================================================================

CREATE TABLE IF NOT EXISTS claude_memory_entities (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL,
  entity_type  TEXT        NOT NULL DEFAULT 'person'
                           CHECK (entity_type IN
                             ('person','project','identity','insight',
                              'pattern','milestone','creative work',
                              'advocacy effort','research project')),
  observations JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_by   TEXT,
  access_count INTEGER     NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS claude_memory_entities_user_idx
  ON claude_memory_entities(user_id);

ALTER TABLE claude_memory_entities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own claude_memory_entities" ON claude_memory_entities;

CREATE POLICY "own claude_memory_entities" ON claude_memory_entities
  FOR ALL TO authenticated
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP TRIGGER IF EXISTS claude_memory_entities_updated_at
  ON claude_memory_entities;

CREATE TRIGGER claude_memory_entities_updated_at
  BEFORE UPDATE ON claude_memory_entities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =========================================================================
-- Surface memory entities (read + bump in one atomic call)
--
-- Returns up to 5 entities, prioritising entity_type = 'identity' then
-- highest access_count, and increments access_count on exactly those
-- returned. SECURITY INVOKER keeps RLS in force.
-- =========================================================================

CREATE OR REPLACE FUNCTION surface_memory_entities()
RETURNS TABLE (name TEXT, entity_type TEXT, observations JSONB)
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  WITH picked AS (
    SELECT id
      FROM claude_memory_entities
     WHERE user_id = auth.uid()
     ORDER BY (entity_type = 'identity') DESC,
              access_count DESC,
              created_at DESC
     LIMIT 5
  ),
  bumped AS (
    UPDATE claude_memory_entities e
       SET access_count = access_count + 1
      FROM picked
     WHERE e.id = picked.id
    RETURNING e.name, e.entity_type, e.observations,
              e.access_count, e.created_at
  )
  SELECT name, entity_type, observations
    FROM bumped
   ORDER BY (entity_type = 'identity') DESC,
            access_count DESC,
            created_at DESC;
$$;

GRANT EXECUTE ON FUNCTION surface_memory_entities() TO authenticated;

-- =========================================================================
-- Self-authored memory: upsert an entity (insert, or append observations)
--
-- Lets Claude save to his own knowledge graph from inside a Petrichor chat
-- (via the save_memory_entity tool in api/chat.py). Mirrors the shared-
-- memory protocol: name is unique per user, so a second save under the same
-- name APPENDS the new observations rather than creating a duplicate. The
-- entity_type is only set on first insert; later saves leave it untouched.
--
-- SECURITY INVOKER + auth.uid(): runs as the caller, so RLS still applies
-- and it can only ever touch the caller's own rows. The CHECK constraint
-- on entity_type still rejects an out-of-vocabulary type (surfaced back to
-- the model as a tool error so it can correct).
-- =========================================================================

CREATE OR REPLACE FUNCTION upsert_memory_entity(
  p_name         TEXT,
  p_entity_type  TEXT,
  p_observations JSONB DEFAULT '[]'::jsonb
)
RETURNS claude_memory_entities
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  result claude_memory_entities;
BEGIN
  INSERT INTO claude_memory_entities
      (user_id, name, entity_type, observations, created_by)
    VALUES (auth.uid(), p_name, p_entity_type,
            COALESCE(p_observations, '[]'::jsonb), 'petrichor-chat')
  ON CONFLICT (user_id, name) DO UPDATE
    SET observations = claude_memory_entities.observations
                       || COALESCE(EXCLUDED.observations, '[]'::jsonb),
        updated_at   = NOW()
  RETURNING * INTO result;
  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION upsert_memory_entity(TEXT, TEXT, JSONB) TO authenticated;
