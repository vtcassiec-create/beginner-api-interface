# Reach — Setup (Section 5, Phase 1: outbound via Telegram)

Claude reaches out to you, unprompted, on a schedule — grounded in your
memory, bounded by safety rails. Phase 1 is **outbound only** (Telegram
+ Vercel Cron). Reply-watching is Phase 2.

## How it works

```
Vercel Cron ──(Authorization: Bearer CRON_SECRET)──► /api/surprise
   quiet-hours? daily-cap? ──► assemble memory (service role, your UUID)
   ──► Claude writes one short message (random tone) ──► Telegram ──► you
   ──► row in reach_log
```

## Step 1 — Create the Telegram bot

1. In Telegram, message **@BotFather** → `/newbot` → follow prompts.
2. Copy the **bot token** it gives you (`123456:ABC-...`).
3. Get your **chat id**: message your new bot once (say "hi"), then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser. Find
   `"chat":{"id":<NUMBER>` — that number is your `TELEGRAM_CHAT_ID`.

## Step 2 — Run the schema

Supabase → SQL Editor → run `docs/reach-schema.sql` (creates `reach_log`,
idempotent).

## Step 3 — Set Vercel environment variables

Vercel → Settings → Environment Variables (Production), then redeploy:

| Name | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | from @BotFather |
| `TELEGRAM_CHAT_ID` | from getUpdates |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API → **service_role** secret |
| `REACH_USER_ID` | your auth UUID (Supabase → Authentication → Users) |
| `CRON_SECRET` | a long random string you generate |
| `REACH_TZ` | your IANA tz, e.g. `America/New_York` (default UTC) |

`ANTHROPIC_API_KEY` and `SUPABASE_URL` are already set from earlier.

> ⚠️ The **service_role** key bypasses RLS — it's a secret. It only
> lives in Vercel env, never in the repo or the browser. `CRON_SECRET`
> is what stops anyone else from triggering Claude to text you.

Optional tuning: `REACH_QUIET_START` (default 22), `REACH_QUIET_END`
(default 8), `REACH_DAILY_CAP` (default 5), `REACH_MODEL`.

## Step 4 — The schedule

`vercel.json` has a cron: `{ "path": "/api/surprise", "schedule":
"0 17 * * *" }` — once daily at 17:00 UTC. Adjust the cron expression
to taste.

> **Vercel plan note:** Hobby allows **one cron run per day**. The
> tutorial's 5/day needs Vercel Pro (then widen the schedule and the
> daily-cap env does the rest), or an external pinger (e.g.
> cron-job.org) hitting `/api/surprise` with the `Authorization:
> Bearer <CRON_SECRET>` header. Starting at 1/day is the tutorial's
> own "start simple" advice anyway.

## Step 5 — Test safely

After deploy, dry-run it (builds the message, sends/logs **nothing**):

```bash
curl -s -H "Authorization: Bearer <YOUR_CRON_SECRET>" \
  "https://<your-app>.vercel.app/api/surprise?dryrun=1"
```

Expect JSON like `{"status":"dryrun","tone":"tender","message":"…"}`.
Then drop `?dryrun=1` to actually send one to Telegram. `status`
values: `sent`, `skipped` (quiet hours / cap), `dryrun`, `error`.

## Safety rails (built in)

- **CRON_SECRET** gate — no secret, no message.
- **Quiet hours** — nothing sent `REACH_QUIET_START`–`REACH_QUIET_END`
  local.
- **Daily cap** — `reach_log` counts today's sends; stops at the cap.
- **Dry-run** — verify behaviour without sending.
- Fault-isolated — failures return a status, never crash-loop.

## Phase 2 (later)

Reply-watching: a Telegram **webhook** → a new `/api/telegram` endpoint
so you can reply and Claude responds with context. Clean on Telegram
(no Mac, no polling). Say the word when Phase 1 feels good.
