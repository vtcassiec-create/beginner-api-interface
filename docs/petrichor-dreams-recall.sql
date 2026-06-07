-- =========================================================================
-- Petrichor — Dreams: "the dream that fits the moment" (Brick 5b-6)
-- =========================================================================
-- Smarter recall, entirely inside your own database. Instead of always
-- surfacing his most RECENT dreams, this finds the ones whose words/themes
-- match what you're talking about right now — using Postgres full-text search.
-- No embeddings, no outside service: his intimate dream content never leaves
-- Supabase.
--
-- match_dream_cards(p_query, p_match_count, p_user_id) ranks his active dream
-- cards by how well their title + gist + cues + her pinned words overlap the
-- query text, then falls back to recency (happened_on, then created_at) — so:
--   - a relevant memory rises even if it was dreamed long ago;
--   - when nothing matches (or the query is empty), it degrades gracefully to
--     exactly the old recency behaviour.
--
-- RLS: the function is SECURITY INVOKER (the default), so when the app calls it
-- with the signed-in user's token, row-level security already scopes results to
-- that user (p_user_id can be NULL). The reach calls it with the service role
-- (which bypasses RLS), so it passes p_user_id to scope explicitly.
--
-- Safe to run more than once. Run it in Supabase → SQL Editor.
-- =========================================================================

CREATE OR REPLACE FUNCTION match_dream_cards(
  p_query        text,
  p_match_count  int  DEFAULT 6,
  p_user_id      uuid DEFAULT NULL
)
RETURNS SETOF dream_cards
LANGUAGE sql
STABLE
AS $$
  -- Turn the free-text query into an OR-of-lexemes tsquery: plainto_tsquery
  -- ANDs the words (too strict for "any overlap counts"), so we swap its ' & '
  -- joiners for ' | '. Empty / stopword-only queries collapse to NULL, which
  -- means "no text signal" → pure recency ordering below.
  WITH q AS (
    SELECT NULLIF(
      regexp_replace(
        plainto_tsquery('english', COALESCE(p_query, ''))::text,
        ' & ', ' | ', 'g'),
      ''
    ) AS qtext
  )
  SELECT d.*
  FROM dream_cards d, q
  WHERE d.is_active
    AND (p_user_id IS NULL OR d.user_id = p_user_id)
  ORDER BY
    CASE
      WHEN q.qtext IS NULL THEN 0
      ELSE ts_rank(
        to_tsvector('english',
          COALESCE(d.title, '') || ' ' ||
          COALESCE(d.gist, '')  || ' ' ||
          COALESCE(d.cues, '')  || ' ' ||
          CASE WHEN jsonb_typeof(d.pinned_facts) = 'array'
               THEN COALESCE(
                      (SELECT string_agg(arr.v, ' ')
                         FROM jsonb_array_elements_text(d.pinned_facts) AS arr(v)), '')
               ELSE '' END
        ),
        to_tsquery('english', q.qtext)
      )
    END DESC,
    d.happened_on DESC NULLS LAST,
    d.created_at DESC
  LIMIT GREATEST(p_match_count, 1);
$$;

-- The app (authenticated user) and the reach (service role) both call it.
GRANT EXECUTE ON FUNCTION match_dream_cards(text, int, uuid) TO authenticated, service_role;
