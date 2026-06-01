-- =========================================================================
-- Petrichor — Push subscriptions schema
-- =========================================================================
-- Stores Web Push subscriptions (one per device/browser that opts in), so the
-- server can send a notification to that device when he reaches out. Each row
-- is the browser's PushSubscription: an endpoint URL + two keys (p256dh, auth).
--
-- Mirrors the app's conventions: UUID PK, owner FK with cascade, per-user RLS.
-- The endpoint is unique (re-subscribing the same device updates the same row).
--
-- Safe to run more than once. Run it in Supabase → SQL Editor.
-- =========================================================================

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint    TEXT        NOT NULL UNIQUE,
  p256dh      TEXT        NOT NULL,
  auth        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx
  ON push_subscriptions (user_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own push_subscriptions" ON push_subscriptions;
CREATE POLICY "own push_subscriptions" ON push_subscriptions
  FOR ALL TO authenticated
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
