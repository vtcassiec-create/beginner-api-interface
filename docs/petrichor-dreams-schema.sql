-- =========================================================================
-- Petrichor — Dreams: associative, emotional memory ("dream cards")
-- =========================================================================
-- A richer memory layer than flat retrieval. A cheap "dream model" reads
-- history in batches and writes DREAM CARDS — felt, reconstructed memories in
-- his own voice — instead of rote facts. Each card holds:
--
--   gist         — the memory as he'd *remember* it (reconstructed, felt, his voice)
--   pinned_facts — verbatim things that must NOT wobble (her exact words, etc.)
--   feels        — an emotion→intensity map, e.g. {"joy":0.9,"belonging":0.85}
--   cues         — retrieval keys/phrases that should call this memory up
--   happened_on  — the date the memory is about (for ordering / "that day")
--   source_label — where it came from (a conversation id, a vault note…)
--
-- dream_state is one row per user: the on/off switch, mode, chosen dream model,
-- and a cursor marking how far through history the dreaming has gotten (so each
-- nightly/catch-up batch picks up where the last left off).
--
-- Mirrors the app's conventions: UUID PK, owner FK cascade, per-user RLS,
-- updated_at trigger (reuses set_updated_at). Safe to run more than once.
-- Run it in Supabase → SQL Editor.
-- =========================================================================

CREATE TABLE IF NOT EXISTS dream_cards (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title        TEXT        NOT NULL DEFAULT '',
  gist         TEXT        NOT NULL DEFAULT '',
  pinned_facts JSONB       NOT NULL DEFAULT '[]'::jsonb,   -- array of verbatim strings
  feels        JSONB       NOT NULL DEFAULT '{}'::jsonb,   -- {emotion: intensity 0..1}
  cues         TEXT        NOT NULL DEFAULT '',            -- keywords/phrases for recall
  source_label TEXT,                                       -- e.g. 'conversation:<id>' / 'vault:<path>'
  happened_on  DATE,                                       -- the day the memory is about
  is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE dream_cards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own dream_cards" ON dream_cards;
CREATE POLICY "own dream_cards" ON dream_cards
  FOR ALL TO authenticated
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS dream_cards_user_when_idx
  ON dream_cards(user_id, happened_on DESC);
CREATE INDEX IF NOT EXISTS dream_cards_user_active_idx
  ON dream_cards(user_id, is_active);

-- One row per user: the dreaming switch, mode, model, and a progress cursor.
CREATE TABLE IF NOT EXISTS dream_state (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled        BOOLEAN     NOT NULL DEFAULT FALSE,
  mode           TEXT        NOT NULL DEFAULT 'nightly'
                             CHECK (mode IN ('nightly', 'catchup')),
  dream_model    TEXT        NOT NULL DEFAULT 'claude-haiku-4-5-20251001',
  -- History up to this moment has been dreamed; the next batch reads after it.
  cursor_at      TIMESTAMPTZ,
  last_dreamed_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE dream_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own dream_state" ON dream_state;
CREATE POLICY "own dream_state" ON dream_state
  FOR ALL TO authenticated
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP TRIGGER IF EXISTS dream_state_updated_at ON dream_state;
CREATE TRIGGER dream_state_updated_at
  BEFORE UPDATE ON dream_state
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
