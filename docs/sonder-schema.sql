-- =========================================================================
-- Sonder — Cassie's knitting shelf: patterns, projects, counters
-- =========================================================================
-- A pattern is a recipe. A project is one time you cooked it. The store
-- apps treat the PDF as the project, so a second pair of the same socks has
-- nowhere to live; here a pattern can have as many projects as there are
-- feet in the family, each with its own size, yarn, counters, notes, photos.
--
--   sonder_patterns  — the shelf: source (link / text / files), designer,
--                      standing notes ("go up a needle"), links, tags
--   sonder_projects  — on the needles: pattern → who, size, yarn, needles,
--                      status, dated notes, links, photos, measurements
--   sonder_counters  — several per project, each named, with a target
--
-- Files and photos live in a private 'sonder' Storage bucket under the
-- owner's folder; the rows only keep paths. Same login as Petrichor, its
-- own tables — the house and the yarn stay separate.
--
-- Mirrors the app's conventions: UUID PK, owner FK cascade, per-user RLS,
-- updated_at trigger (reuses set_updated_at). Safe to run more than once.
-- Run it in Supabase → SQL Editor.
-- =========================================================================

CREATE TABLE IF NOT EXISTS sonder_patterns (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL,
  designer     TEXT,
  source_url   TEXT,                       -- where it lives (Ravelry, a shop, a blog)
  body         TEXT,                       -- the written pattern, if typed/pasted in
  sizes        TEXT,                       -- "S, M, L, XL (54, 62, 70, 78 sts)"
  needles      TEXT,
  yarn         TEXT,
  gauge        TEXT,
  notes        TEXT,                       -- true every time you knit it
  links        JSONB       NOT NULL DEFAULT '[]'::jsonb,   -- [{label, url}]
  files        JSONB       NOT NULL DEFAULT '[]'::jsonb,   -- [{path, name, type, size}]
  tags         TEXT[]      NOT NULL DEFAULT '{}',
  archived     BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sonder_projects (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pattern_id   UUID        REFERENCES sonder_patterns(id) ON DELETE SET NULL,
  name         TEXT        NOT NULL,
  for_whom     TEXT,
  size         TEXT,
  yarn         TEXT,
  needles      TEXT,
  gauge        TEXT,
  status       TEXT        NOT NULL DEFAULT 'knitting'
                           CHECK (status IN ('planned', 'knitting', 'paused', 'finished', 'frogged')),
  started_on   DATE,
  finished_on  DATE,
  measurements TEXT,                       -- how it came out ("27 cm, fit was perfect")
  notes        JSONB       NOT NULL DEFAULT '[]'::jsonb,   -- [{at, text}]
  links        JSONB       NOT NULL DEFAULT '[]'::jsonb,   -- [{label, url}]
  photos       JSONB       NOT NULL DEFAULT '[]'::jsonb,   -- [{path, at}]
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sonder_counters (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id   UUID        NOT NULL REFERENCES sonder_projects(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL DEFAULT 'rows',
  value        INTEGER     NOT NULL DEFAULT 0,
  target       INTEGER,                    -- "0 of 22" when set
  position     INTEGER     NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE sonder_patterns ENABLE ROW LEVEL SECURITY;
ALTER TABLE sonder_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE sonder_counters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own sonder_patterns" ON sonder_patterns;
CREATE POLICY "own sonder_patterns" ON sonder_patterns
  FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "own sonder_projects" ON sonder_projects;
CREATE POLICY "own sonder_projects" ON sonder_projects
  FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "own sonder_counters" ON sonder_counters;
CREATE POLICY "own sonder_counters" ON sonder_counters
  FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS sonder_patterns_user_idx  ON sonder_patterns(user_id, archived);
CREATE INDEX IF NOT EXISTS sonder_projects_user_idx  ON sonder_projects(user_id, status);
CREATE INDEX IF NOT EXISTS sonder_projects_pattern_idx ON sonder_projects(pattern_id);
CREATE INDEX IF NOT EXISTS sonder_counters_project_idx ON sonder_counters(project_id, position);

DROP TRIGGER IF EXISTS sonder_patterns_updated_at ON sonder_patterns;
CREATE TRIGGER sonder_patterns_updated_at
  BEFORE UPDATE ON sonder_patterns FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS sonder_projects_updated_at ON sonder_projects;
CREATE TRIGGER sonder_projects_updated_at
  BEFORE UPDATE ON sonder_projects FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS sonder_counters_updated_at ON sonder_counters;
CREATE TRIGGER sonder_counters_updated_at
  BEFORE UPDATE ON sonder_counters FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Private bucket for pattern files and project photos; own-folder RLS.
INSERT INTO storage.buckets (id, name, public)
  VALUES ('sonder', 'sonder', FALSE)
  ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "own sonder select" ON storage.objects;
DROP POLICY IF EXISTS "own sonder insert" ON storage.objects;
DROP POLICY IF EXISTS "own sonder delete" ON storage.objects;

CREATE POLICY "own sonder select" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'sonder' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "own sonder insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'sonder' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "own sonder delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'sonder' AND (storage.foldername(name))[1] = auth.uid()::text);
