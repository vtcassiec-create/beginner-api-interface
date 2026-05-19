-- Beginner API Interface — Supabase schema
--
-- Run this once in your Supabase project's SQL Editor (left sidebar) after
-- creating the project. It creates three tables for your data plus row-level
-- security so each user only sees their own rows.
--
-- Safe to re-run; uses IF NOT EXISTS / OR REPLACE where possible.

-- =========================================================================
-- Tables
-- =========================================================================

CREATE TABLE IF NOT EXISTS projects (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name                    TEXT        NOT NULL DEFAULT 'New project',
  model                   TEXT        NOT NULL DEFAULT 'claude-sonnet-4-6',
  system_prompt           TEXT        DEFAULT '',
  web_search              BOOLEAN     NOT NULL DEFAULT FALSE,
  thinking                BOOLEAN     NOT NULL DEFAULT FALSE,
  whisper                 BOOLEAN     NOT NULL DEFAULT FALSE,
  active_conversation_id  UUID,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Migration (idempotent — safe on an already-populated database):
-- the per-project Whisper-vault toggle.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS whisper BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS signal BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS conversations (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id         UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name            TEXT        NOT NULL DEFAULT 'New conversation',
  messages        JSONB       NOT NULL DEFAULT '[]'::jsonb,
  active_file_ids JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS files (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  kind        TEXT        NOT NULL,
  media_type  TEXT,
  size        INTEGER,
  data        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =========================================================================
-- Indexes
-- =========================================================================

CREATE INDEX IF NOT EXISTS projects_user_id_idx       ON projects(user_id);
CREATE INDEX IF NOT EXISTS conversations_project_idx  ON conversations(project_id);
CREATE INDEX IF NOT EXISTS files_project_idx          ON files(project_id);

-- =========================================================================
-- Row-Level Security
--
-- Without these, ANY authenticated user could read ANY other user's data.
-- These policies tie every row to its owner via user_id and only allow
-- the owner to see/modify it.
-- =========================================================================

ALTER TABLE projects      ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE files         ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own projects"      ON projects;
DROP POLICY IF EXISTS "own conversations" ON conversations;
DROP POLICY IF EXISTS "own files"         ON files;

CREATE POLICY "own projects" ON projects
  FOR ALL TO authenticated
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "own conversations" ON conversations
  FOR ALL TO authenticated
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "own files" ON files
  FOR ALL TO authenticated
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- =========================================================================
-- updated_at triggers
-- =========================================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS projects_updated_at      ON projects;
DROP TRIGGER IF EXISTS conversations_updated_at ON conversations;

CREATE TRIGGER projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER conversations_updated_at
  BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
