-- =========================================================================
-- Petrichor — Manuscript stories (chapters) + the story "bible"
-- =========================================================================
-- Lets a long work live as a STORY made of CHAPTERS, instead of one giant piece:
--
--   manuscript_stories      — a work that holds chapters. Its `synopsis` is the
--                             "bible" (plot so far, characters, voice) that
--                             travels with him in every co-write turn, so he
--                             keeps the whole book in mind even while you're
--                             editing just one chapter.
--   manuscript_documents.story_id — a piece that belongs to a story is a chapter
--                             of it (ordered by the existing `position`). NULL =
--                             a standalone piece (today's behavior, e.g. a short
--                             novella stacked in one piece). ON DELETE SET NULL,
--                             so deleting a story un-groups its chapters rather
--                             than destroying any writing.
--
-- Mirrors the app's conventions: UUID PK, owner FK cascade, per-user RLS,
-- updated_at trigger (reuses set_updated_at).
-- Safe to run more than once. Run it in Supabase → SQL Editor.
-- =========================================================================

CREATE TABLE IF NOT EXISTS manuscript_stories (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID        NOT NULL REFERENCES projects(id)   ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title       TEXT        NOT NULL DEFAULT 'Untitled story',
  synopsis    TEXT        NOT NULL DEFAULT '',
  position    INTEGER     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE manuscript_stories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own manuscript_stories" ON manuscript_stories;
CREATE POLICY "own manuscript_stories" ON manuscript_stories
  FOR ALL TO authenticated
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS manuscript_stories_project_idx
  ON manuscript_stories(project_id, position);

DROP TRIGGER IF EXISTS manuscript_stories_updated_at ON manuscript_stories;
CREATE TRIGGER manuscript_stories_updated_at
  BEFORE UPDATE ON manuscript_stories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Chapters: a document can belong to a story.
ALTER TABLE manuscript_documents
  ADD COLUMN IF NOT EXISTS story_id UUID
  REFERENCES manuscript_stories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS manuscript_documents_story_idx
  ON manuscript_documents(story_id, position);
