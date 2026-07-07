"""
The pilot light — keeps the chat's prompt cache warm between her messages.

Why: the conversation's cached prefix lives for 1 hour after its last use.
Cassie's messages often land a couple of hours apart, so each one used to pay
a full cold re-write (~$1.20 on a long thread) just to say "hi, I miss you."
Touching the cache before the hour lapses resets its clock for the price of a
cache READ (~0.1x, pennies). This cron is that touch.

How it stays byte-exact (the whole game — a replay that misses by one byte
WRITES a divergent cache at 2x instead of reading): chat.py freezes the exact
request it just sent (model / system / tools / betas / messages through the
breakpointed previous turn) into keepwarm_state.blueprint. We replay that
verbatim, append a one-dot user turn after the breakpoint, cap the output at a
few tokens, and discard the result. Nothing is saved to the conversation;
nobody is notified; he never sees it. A pilot light, not a conversation.

Self-protection rails, in order:
  - no blueprint / disabled            -> skip (nothing to warm)
  - idle past KEEPWARM_MAX_IDLE_HOURS  -> skip (let it sleep; she's away)
  - quiet hours (reach's REACH_QUIET_*)-> skip (don't warm an empty room)
  - touched < FRESH_MINUTES ago        -> skip (already warm enough)
  - chain older than CHAIN_MINUTES     -> skip (cache already lapsed: pinging
    now would PAY the cold write — the manual-timer mistake this cron exists
    to never make; her next real message relights it once, on purpose)
  - replay wrote a big cache anyway    -> the blueprint didn't match: clear it
    and stand down until the next real turn re-freezes one (never burn twice)

Protected by CRON_SECRET (Authorization: Bearer $CRON_SECRET), like the reach.

Environment:
  ANTHROPIC_API_KEY                       — to touch the cache
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — read blueprint / write timestamps
  REACH_USER_ID                           — whose cache to keep warm
  REACH_TZ, REACH_QUIET_START/END         — reuse the reach's quiet hours
  CRON_SECRET                             — shared secret
  KEEPWARM_MAX_IDLE_HOURS (default 4)     — stop warming after this much silence
"""

from http.server import BaseHTTPRequestHandler
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo
import datetime
import json
import os
import urllib.error
import urllib.request

import anthropic

HTTP_TIMEOUT = 15
CHAIN_MINUTES = 58        # a touch must land inside the previous touch's 1h TTL
FRESH_MINUTES = 18        # touched this recently -> next tick will catch it
PING_MAX_TOKENS = 32      # the discarded reply; adaptive thinking truncates fine
MISMATCH_WRITE_TOKENS = 20000  # a real prefix re-write, not just the tiny suffix


def _normalize_url(raw):
    raw = (raw or "").strip()
    if not raw:
        return ""
    parts = urlsplit(raw)
    if parts.scheme and parts.netloc:
        return f"{parts.scheme}://{parts.netloc}"
    return raw.split("/", 1)[0]


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        secret = os.environ.get("CRON_SECRET", "").strip()
        if not secret:
            return self._json(500, {"status": "error",
                                    "reason": "CRON_SECRET not set"})
        if self.headers.get("Authorization", "") != f"Bearer {secret}":
            return self._json(401, {"status": "unauthorized"})
        return self._run()

    def _run(self):
        api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
        uid = os.environ.get("REACH_USER_ID", "").strip()
        if not api_key or not uid:
            return self._json(200, {"status": "skipped",
                                    "reason": "not configured"})

        rows = self._supabase(
            "GET",
            f"keepwarm_state?user_id=eq.{uid}"
            "&select=enabled,blueprint,captured_at,last_warmed_at&limit=1")
        row = rows[0] if isinstance(rows, list) and rows else None
        if not row:
            return self._json(200, {"status": "skipped",
                                    "reason": "no blueprint yet"})
        if not row.get("enabled"):
            return self._json(200, {"status": "skipped", "reason": "disabled"})
        bp = row.get("blueprint")
        if not isinstance(bp, dict) or not bp.get("model"):
            return self._json(200, {"status": "skipped",
                                    "reason": "no blueprint yet"})

        now = datetime.datetime.now(datetime.timezone.utc)
        captured = self._ts(row.get("captured_at"))
        warmed = self._ts(row.get("last_warmed_at"))
        if not captured:
            return self._json(200, {"status": "skipped",
                                    "reason": "no capture timestamp"})

        # She's been away a while — let the room go dark on purpose. Her next
        # real message pays one write, exactly like today, and re-arms us.
        try:
            max_idle = float(os.environ.get("KEEPWARM_MAX_IDLE_HOURS", "4"))
        except ValueError:
            max_idle = 4.0
        if (now - captured).total_seconds() > max_idle * 3600:
            return self._json(200, {"status": "skipped",
                                    "reason": "idle — letting it sleep"})

        # Her quiet hours (shared with the reach): don't warm an empty room.
        try:
            tz = ZoneInfo(os.environ.get("REACH_TZ", "UTC") or "UTC")
        except Exception:
            tz = ZoneInfo("UTC")
        if self._in_quiet_hours(now.astimezone(tz)):
            return self._json(200, {"status": "skipped",
                                    "reason": "quiet hours"})

        anchor = max(captured, warmed) if warmed else captured
        age_min = (now - anchor).total_seconds() / 60.0
        if age_min < FRESH_MINUTES:
            return self._json(200, {"status": "skipped",
                                    "reason": "still fresh",
                                    "age_min": round(age_min, 1)})
        if age_min > CHAIN_MINUTES:
            # The cache already lapsed. Touching it NOW would pay the full
            # cold write — the exact mistake this cron exists to never make.
            return self._json(200, {"status": "skipped",
                                    "reason": "chain broken — waiting for her",
                                    "age_min": round(age_min, 1)})

        # Replay the frozen request verbatim + a one-dot turn after the
        # breakpoint. Identical thinking config on purpose: changing thinking
        # parameters invalidates message cache breakpoints.
        kw = {"model": bp["model"],
              "messages": list(bp.get("messages") or []) + [
                  {"role": "user", "content": "."}],
              "max_tokens": PING_MAX_TOKENS}
        for key in ("system", "tools", "thinking", "extra_headers", "extra_body"):
            v = bp.get(key)
            if v:
                kw[key] = v
        # A warming ping must never trigger a server-side fold: with 32 max
        # tokens the summary would come out truncated, the real conversation
        # would never see it, and we'd have paid for it — compaction is a
        # real-turn affair. (The beta HEADER stays: a compaction block already
        # threaded into the frozen messages is only legal input under the flag.)
        eb = kw.get("extra_body")
        if isinstance(eb, dict) and "context_management" in eb:
            eb = {k: v for k, v in eb.items() if k != "context_management"}
            if eb:
                kw["extra_body"] = eb
            else:
                kw.pop("extra_body", None)
        th = bp.get("thinking") or {}
        if th.get("type") == "enabled" and th.get("budget_tokens"):
            # Non-adaptive thinking demands max_tokens > budget.
            kw["max_tokens"] = int(th["budget_tokens"]) + PING_MAX_TOKENS

        try:
            client = anthropic.Anthropic(api_key=api_key)
            resp = client.messages.create(**kw)
        except Exception as e:
            # A failed touch costs nothing and changes nothing; next tick (or
            # her next message) takes it from here.
            return self._json(200, {"status": "skipped",
                                    "reason": f"ping failed: {str(e)[:200]}"})

        u = getattr(resp, "usage", None)
        wrote = int(getattr(u, "cache_creation_input_tokens", 0) or 0)
        read = int(getattr(u, "cache_read_input_tokens", 0) or 0)
        if wrote > MISMATCH_WRITE_TOKENS:
            # Our replay didn't match the real prefix — we just paid for a
            # divergent cache nobody will use. Disarm rather than burn again;
            # the next real turn freezes a fresh blueprint and re-arms us.
            self._supabase("PATCH", f"keepwarm_state?user_id=eq.{uid}",
                           {"blueprint": None})
            print(f"[keepwarm] MISMATCH: wrote {wrote} tokens — disarmed")
            return self._json(200, {"status": "mismatch_disarmed",
                                    "wrote": wrote, "read": read})

        self._supabase("PATCH", f"keepwarm_state?user_id=eq.{uid}",
                       {"last_warmed_at": now.isoformat()})
        print(f"[keepwarm] warmed: read {read}, wrote {wrote}")
        return self._json(200, {"status": "warmed",
                                "read": read, "wrote": wrote})

    # ---- helpers ----

    def _in_quiet_hours(self, local_now):
        start = int(os.environ.get("REACH_QUIET_START", "22") or "22")
        end = int(os.environ.get("REACH_QUIET_END", "8") or "8")
        h = local_now.hour
        if start == end:
            return False
        if start < end:
            return start <= h < end
        return h >= start or h < end  # overnight window

    def _ts(self, s):
        if not s:
            return None
        try:
            return datetime.datetime.fromisoformat(
                str(s).replace("Z", "+00:00"))
        except Exception:
            return None

    def _supabase(self, method, path, body=None):
        url = _normalize_url(os.environ.get("SUPABASE_URL", ""))
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        if not url or not key:
            return None
        try:
            data = json.dumps(body).encode() if body is not None else None
            req = urllib.request.Request(
                f"{url}/rest/v1/{path}", data=data, method=method,
                headers={
                    "apikey": key,
                    "Authorization": f"Bearer {key}",
                    "Content-Type": "application/json",
                    "Prefer": "return=representation",
                })
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                raw = resp.read().decode()
            return json.loads(raw) if raw else []
        except Exception:
            return None

    def _json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)
