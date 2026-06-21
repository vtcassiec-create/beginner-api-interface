-- Petrichor: per-project "Email" toggle
--
-- Adds the `gmail` boolean column to the projects table, mirroring the existing
-- `whisper` / `signal` toggles. When on (and GMAIL_MCP_URL + GMAIL_MCP_TOKEN are
-- set in the environment), Claude can read & search his own email inbox via the
-- Zapier MCP server. Idempotent — safe to run more than once.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS gmail boolean NOT NULL DEFAULT false;
