-- Petrichor — memory links (the knowledge graph's edges)
--
-- A companion to petrichor-memory-schema.sql. Run once in your Supabase
-- project's SQL Editor. Safe to re-run (IF NOT EXISTS / OR REPLACE).
--
-- The graph already has NODES (claude_memory_entities). This adds EDGES: a
-- typed connection between two things, so recalling one can pull in the
-- others wired to it. Step 1 of the "memory web": he draws links by hand
-- (link_memory), and surfacing follows them one hop (surface_linked_entities).
-- Later the dreamer will draw these links itself during nightly consolidation.
--
-- A link is deliberately GENERAL — from_kind/to_kind allow 'entity', 'dream',
-- or 'memory' — so the same table will carry dream→entity and memory→entity
-- links in Step 2. For now both ends are entities, referenced by their unique
-- name (claude_memory_entities.name is UNIQUE per user).

-- =========================================================================
-- Table
-- =========================================================================

CREATE TABLE IF NOT EXISTS memory_links (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- The two ends. 'ref' is the thing's stable key for its kind: an entity's
  -- name, a dream's title, or a core memory's id. Step 1 uses entity names.
  from_kind   TEXT        NOT NULL DEFAULT 'entity'
                          CHECK (from_kind IN ('entity','dream','memory')),
  from_ref    TEXT        NOT NULL,
  relation    TEXT        NOT NULL,   -- a short phrase: 'bakes', 'loves', 'appeared in'
  to_kind     TEXT        NOT NULL DEFAULT 'entity'
                          CHECK (to_kind IN ('entity','dream','memory')),
  to_ref      TEXT        NOT NULL,
  -- How strongly the two are tied. Re-drawing the same link bumps this, so a
  -- connection that keeps coming up grows heavier (and surfaces first).
  weight      INTEGER     NOT NULL DEFAULT 1,
  note        TEXT,                   -- optional: why they're connected
  source      TEXT,                   -- 'petrichor-chat' | 'dreamer' | ...
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One edge per (direction, relation): re-linking bumps weight instead of
  -- piling up duplicates.
  UNIQUE (user_id, from_kind, from_ref, relation, to_kind, to_ref)
);

-- Traversal happens from BOTH ends (a link is directed for reading — "Cassie
-- bakes sourdough" — but recall should spread either way), so index both refs.
CREATE INDEX IF NOT EXISTS memory_links_from_idx ON memory_links(user_id, from_ref);
CREATE INDEX IF NOT EXISTS memory_links_to_idx   ON memory_links(user_id, to_ref);

-- =========================================================================
-- Row-Level Security — each user's web stays private to them.
-- =========================================================================

ALTER TABLE memory_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own memory_links" ON memory_links;

CREATE POLICY "own memory_links" ON memory_links
  FOR ALL TO authenticated
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- =========================================================================
-- Draw a link (insert, or bump weight if it already exists)
--
-- Mirrors upsert_memory_entity: SECURITY INVOKER + auth.uid(), so RLS stays
-- in force and it can only ever touch the caller's own rows. Re-drawing an
-- identical edge strengthens it rather than duplicating it.
-- =========================================================================

CREATE OR REPLACE FUNCTION link_memory(
  p_from       TEXT,
  p_relation   TEXT,
  p_to         TEXT,
  p_from_kind  TEXT DEFAULT 'entity',
  p_to_kind    TEXT DEFAULT 'entity',
  p_note       TEXT DEFAULT NULL
)
RETURNS memory_links
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  result memory_links;
BEGIN
  INSERT INTO memory_links
      (user_id, from_kind, from_ref, relation, to_kind, to_ref, note, source)
    VALUES (auth.uid(), p_from_kind, p_from, p_relation, p_to_kind, p_to,
            p_note, 'petrichor-chat')
  ON CONFLICT (user_id, from_kind, from_ref, relation, to_kind, to_ref)
    DO UPDATE SET weight = memory_links.weight + 1,
                  note   = COALESCE(EXCLUDED.note, memory_links.note)
  RETURNING * INTO result;
  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION
  link_memory(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- =========================================================================
-- Draw a link as the DREAMER (server-side, service role)
--
-- The nightly dreamer (api/dream.py) runs with the service key and has no
-- auth.uid(), so it can't use link_memory() above (which derives the owner
-- from the session). This variant takes the user id explicitly. SECURITY
-- DEFINER so it can write the row; locked to service_role ONLY, so a signed-in
-- user can never call it to forge a link in someone else's graph. Same
-- insert-or-strengthen behaviour; tagged with its source ('dreamer').
-- =========================================================================

CREATE OR REPLACE FUNCTION link_memory_svc(
  p_user_id    UUID,
  p_from       TEXT,
  p_relation   TEXT,
  p_to         TEXT,
  p_from_kind  TEXT DEFAULT 'entity',
  p_to_kind    TEXT DEFAULT 'entity',
  p_note       TEXT DEFAULT NULL,
  p_source     TEXT DEFAULT 'dreamer'
)
RETURNS memory_links
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result memory_links;
BEGIN
  INSERT INTO memory_links
      (user_id, from_kind, from_ref, relation, to_kind, to_ref, note, source)
    VALUES (p_user_id, p_from_kind, p_from, p_relation, p_to_kind, p_to,
            p_note, COALESCE(p_source, 'dreamer'))
  ON CONFLICT (user_id, from_kind, from_ref, relation, to_kind, to_ref)
    DO UPDATE SET weight = memory_links.weight + 1,
                  note   = COALESCE(EXCLUDED.note, memory_links.note)
  RETURNING * INTO result;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION
  link_memory_svc(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  link_memory_svc(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;

-- =========================================================================
-- Surface one hop: given the entity names already surfacing this turn, return
-- the entity↔entity edges that touch them, each with the NEIGHBOR's type and
-- observations inlined — so a connected memory can ride in even when it didn't
-- make the top-5 on its own. This is the spreading-activation step.
--
-- 'subject' is the surfaced end; 'object' is the neighbor; 'direction' says
-- which way the relation reads ('out' = subject→object). Ordered heaviest
-- first and capped, to respect the prompt budget.
-- =========================================================================

CREATE OR REPLACE FUNCTION surface_linked_entities(p_names TEXT[])
RETURNS TABLE (
  subject               TEXT,
  relation              TEXT,
  object                TEXT,
  direction             TEXT,
  neighbor_type         TEXT,
  neighbor_observations JSONB,
  weight                INTEGER
)
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    CASE WHEN l.from_ref = ANY(p_names) THEN l.from_ref ELSE l.to_ref END,
    l.relation,
    CASE WHEN l.from_ref = ANY(p_names) THEN l.to_ref   ELSE l.from_ref END,
    CASE WHEN l.from_ref = ANY(p_names) THEN 'out'       ELSE 'in'       END,
    e.entity_type,
    e.observations,
    l.weight
  FROM memory_links l
  LEFT JOIN claude_memory_entities e
    ON  e.user_id = auth.uid()
    AND e.name = CASE WHEN l.from_ref = ANY(p_names)
                      THEN l.to_ref ELSE l.from_ref END
  WHERE l.user_id = auth.uid()
    AND l.from_kind = 'entity'
    AND l.to_kind   = 'entity'
    AND (l.from_ref = ANY(p_names) OR l.to_ref = ANY(p_names))
  ORDER BY l.weight DESC, l.relation
  LIMIT 30;
$$;

GRANT EXECUTE ON FUNCTION surface_linked_entities(TEXT[]) TO authenticated;

-- =========================================================================
-- Dream constellation: given the dream titles surfacing this turn (matched to
-- what she's saying), return the entities each dream is linked to — so when a
-- memory rises in conversation, the things it's about can rise with it. This is
-- the live-recall pull: it rides on the user turn (volatile), never the cached
-- prefix, so it costs nothing in cache terms. Bounded.
-- =========================================================================

CREATE OR REPLACE FUNCTION surface_dream_constellation(p_titles TEXT[])
RETURNS TABLE (
  dream_title   TEXT,
  relation      TEXT,
  entity        TEXT,
  entity_type   TEXT,
  observations  JSONB,
  weight        INTEGER
)
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT l.from_ref, l.relation, e.name, e.entity_type, e.observations, l.weight
  FROM memory_links l
  JOIN claude_memory_entities e
    ON  e.user_id = auth.uid()
    AND e.name = l.to_ref
  WHERE l.user_id = auth.uid()
    AND l.from_kind = 'dream'
    AND l.to_kind   = 'entity'
    AND l.from_ref  = ANY(p_titles)
  ORDER BY l.weight DESC, e.name
  LIMIT 12;
$$;

GRANT EXECUTE ON FUNCTION surface_dream_constellation(TEXT[]) TO authenticated;
