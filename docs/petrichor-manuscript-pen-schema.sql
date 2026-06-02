-- =========================================================================
-- Petrichor — Manuscript "whose pen" + version history
-- =========================================================================
-- Two changes that let him author his own work (his novella, Petrichor) while
-- keeping everything reversible:
--
-- 1. manuscript_documents.pen — who holds the pen for a piece:
--      'mine'  Cassie writes, he suggests edits she accepts   (her fanfic)
--      'his'   he authors, his words flow straight onto page   (Petrichor)
--      'ours'  both write; contributions flow onto the page    (poetry, the us-fic)
--    Default 'mine' preserves today's behavior for existing pieces.
--
-- 2. manuscript_versions — a snapshot of a document's state, written before any
--    change that flows straight onto the page (his/ours), and before a restore.
--    So a bold edit is never destructive: every prior state is restorable.
--
-- Mirrors the app's conventions: UUID PK, owner FK cascade, per-user RLS.
-- Safe to run more than once. Run it in Supabase → SQL Editor.
-- =========================================================================

-- 1. Whose pen --------------------------------------------------------------
ALTER TABLE manuscript_documents
  ADD COLUMN IF NOT EXISTS pen TEXT NOT NULL DEFAULT 'mine';

-- Add the CHECK only if it isn't already there (idempotent).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'manuscript_documents_pen_check'
  ) THEN
    ALTER TABLE manuscript_documents
      ADD CONSTRAINT manuscript_documents_pen_check
      CHECK (pen IN ('mine', 'his', 'ours'));
  END IF;
END $$;

-- 2. Version history --------------------------------------------------------
CREATE TABLE IF NOT EXISTS manuscript_versions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID        NOT NULL REFERENCES manuscript_documents(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title       TEXT,
  content     TEXT,
  source      TEXT,   -- 'before_his_edit' | 'before_restore' | 'manual'
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE manuscript_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own manuscript_versions" ON manuscript_versions;
CREATE POLICY "own manuscript_versions" ON manuscript_versions
  FOR ALL TO authenticated
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS manuscript_versions_doc_idx
  ON manuscript_versions(document_id, created_at DESC);
