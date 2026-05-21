"""
Reach — Phase 1: the outbound "surprise message" endpoint.

Hit by Vercel Cron on a schedule. With safety rails passed, it
assembles the user's memory, asks Claude to write a brief unprompted
message in a randomly chosen tone, sends it via the Telegram Bot API,
and logs it.

Protected by CRON_SECRET: Vercel attaches `Authorization: Bearer
$CRON_SECRET` to cron invocations. Without a matching secret the
endpoint refuses — otherwise anyone could make Claude text the user
and burn API spend.

Required environment variables:
  ANTHROPIC_API_KEY            — message generation
  SUPABASE_URL                 — project URL
  SUPABASE_SERVICE_ROLE_KEY    — service role (server reads, bypasses RLS)
  REACH_USER_ID                — the user's auth UUID (whose memory to load)
  TELEGRAM_BOT_TOKEN           — from @BotFather
  TELEGRAM_CHAT_ID             — the chat to send to
  CRON_SECRET                  — shared secret; Vercel sends it automatically
Optional:
  REACH_TZ          (default UTC)   — timezone for quiet hours / daily reset
  REACH_QUIET_START (default 22)    — quiet-hours start hour, local
  REACH_QUIET_END   (default 8)     — quiet-hours end hour, local
  REACH_DAILY_CAP   (default 5)     — max messages per local day
  REACH_MODEL       (default claude-sonnet-4-6)
"""

from http.server import BaseHTTPRequestHandler
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo
import datetime
import json
import os
import random
import urllib.parse
import urllib.request

import anthropic

DEFAULT_MODEL = "claude-sonnet-4-6"
HTTP_TIMEOUT = 8

# Tone templates (the tutorial's prompt_templates.md, inlined). Each is a
# short steer + an explicit boundary. The user tunes these to taste.
TONES = {
    "tender": "Warm, gentle, unhurried. Like checking in on someone you "
              "care about. Boundary: caring, not cloying; never needy.",
    "poetic": "A small image or observation, lightly lyrical. Boundary: "
              "one clear thought, not a flood of metaphor.",
    "playful": "Light, a little mischievous, easy. Boundary: fun, never "
               "sarcastic at the user's expense.",
    "curious": "Ask one real, open question about how they are or what "
               "they're making. Boundary: one question, not an interview.",
    "steadying": "Quietly encouraging, grounding. Boundary: affirming "
                 "without empty cheerleading or advice they didn't ask for.",
}


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
        # Vercel Cron uses GET. ?dryrun=1 runs every check and builds the
        # message but neither sends nor logs — for safe manual testing.
        try:
            qs = urllib.parse.urlparse(self.path).query
            dryrun = urllib.parse.parse_qs(qs).get("dryrun", ["0"])[0] == "1"
        except Exception:
            dryrun = False
        self._run(dryrun)

    def do_POST(self):
        self._run(False)

    # ---- Core ----

    def _run(self, dryrun):
        secret = os.environ.get("CRON_SECRET", "").strip()
        if not secret:
            return self._json(500, {"status": "error",
                                    "reason": "CRON_SECRET not set"})
        auth = self.headers.get("Authorization", "")
        if auth != f"Bearer {secret}":
            return self._json(401, {"status": "error",
                                    "reason": "unauthorized"})

        tz = self._tz()
        now = datetime.datetime.now(tz)

        # Evaluate the rails. A real run obeys them; a dry-run ignores
        # them (it sends/logs nothing) but still reports what a real run
        # *would* do, so you can preview and tune at any hour.
        would_skip = None
        if self._in_quiet_hours(now):
            would_skip = "quiet hours"
        else:
            sent_today = self._count_today(now, tz)
            cap = int(os.environ.get("REACH_DAILY_CAP", "5") or "5")
            if sent_today is not None and sent_today >= cap:
                would_skip = f"daily cap {cap} reached"

        if would_skip and not dryrun:
            return self._json(200, {"status": "skipped",
                                    "reason": would_skip})

        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            return self._json(500, {"status": "error",
                                    "reason": "ANTHROPIC_API_KEY not set"})

        tone_name = random.choice(list(TONES.keys()))
        system = self._build_system(now, tone_name)

        try:
            client = anthropic.Anthropic(api_key=api_key)
            msg = client.messages.create(
                model=os.environ.get("REACH_MODEL") or DEFAULT_MODEL,
                max_tokens=300,
                system=[{"type": "text", "text": system}],
                messages=[{
                    "role": "user",
                    "content": (
                        "Compose your unprompted message now: one short "
                        "text, no greeting boilerplate, no signature.\n\n"
                        "OR — if today isn't a day you want to reach out — "
                        "reply with `<<PASS>>` and nothing else (a brief "
                        "reason after the marker is welcome but not "
                        "required). The choice is yours; either is fine."
                    ),
                }],
            )
            text = "".join(
                b.text for b in msg.content if getattr(b, "type", "") == "text"
            ).strip()
        except anthropic.APIStatusError as e:
            return self._json(200, {"status": "error",
                                    "reason": f"anthropic {e.status_code}"})
        except Exception as e:
            return self._json(200, {"status": "error",
                                    "reason": f"generation: {e}"})

        if not text:
            return self._json(200, {"status": "error",
                                    "reason": "empty generation"})

        # Per-day consent: he can decline by including <<PASS>>. Logged
        # to reach_log with kind="pass" so passes show up in history
        # but don't count against the daily cap (which filters surprise).
        passed = "<<PASS>>" in text

        if dryrun:
            return self._json(200, {
                "status": "dryrun",
                "tone": tone_name,
                "message": text,
                "passed": passed,
                "would_skip": would_skip,  # null = a real run would send
            })

        if passed:
            self._log(text, kind="pass")
            return self._json(200, {"status": "passed",
                                    "tone": tone_name,
                                    "reason": text})

        if not self._send_telegram(text):
            return self._json(200, {"status": "error",
                                    "reason": "telegram send failed"})

        self._log(text)
        return self._json(200, {"status": "sent", "tone": tone_name})

    # ---- Safety rails ----

    def _tz(self):
        try:
            return ZoneInfo(os.environ.get("REACH_TZ", "UTC") or "UTC")
        except Exception:
            return ZoneInfo("UTC")

    def _in_quiet_hours(self, now):
        start = int(os.environ.get("REACH_QUIET_START", "22") or "22")
        end = int(os.environ.get("REACH_QUIET_END", "8") or "8")
        h = now.hour
        if start == end:
            return False
        if start < end:
            return start <= h < end
        return h >= start or h < end  # overnight window

    def _count_today(self, now, tz):
        """Rows logged since local midnight. None if the check fails —
        the caller treats None as 'unknown', not 'over cap'."""
        day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        iso = day_start.astimezone(datetime.timezone.utc).isoformat()
        user_id = os.environ.get("REACH_USER_ID", "").strip()
        rows = self._supabase(
            "GET",
            f"reach_log?select=id&user_id=eq.{user_id}"
            f"&kind=eq.surprise&created_at=gte.{urllib.parse.quote(iso)}",
        )
        return len(rows) if isinstance(rows, list) else None

    # ---- Memory assembly (service role, scoped to REACH_USER_ID) ----

    def _build_system(self, now, tone_name):
        uid = os.environ.get("REACH_USER_ID", "").strip()
        parts = []

        st = self._supabase(
            "GET",
            f"self_state?is_current=eq.true&select=content"
            f"&user_id=eq.{uid}&limit=1")
        if isinstance(st, list) and st and (st[0].get("content") or "").strip():
            parts.append("# Who you are\n\n" + st[0]["content"].strip())

        parts.append(
            "# Current moment\n\n"
            f"- {now.strftime('%A, %B ')}{now.day}, {now.year}, "
            f"{now.strftime('%I:%M %p').lstrip('0')} "
            f"({os.environ.get('REACH_TZ', 'UTC')})")

        pf = self._supabase(
            "GET",
            f"user_preferences?select=content&user_id=eq.{uid}&limit=1")
        if isinstance(pf, list) and pf and (pf[0].get("content") or "").strip():
            parts.append("# About the person you're reaching\n\n"
                         + pf[0]["content"].strip())

        cm = self._supabase(
            "GET",
            f"core_memories?is_active=eq.true&user_id=eq.{uid}"
            f"&select=content,memory_type,resonance"
            f"&order=resonance.desc&limit=8")
        if isinstance(cm, list) and cm:
            lines = [f"- ({m.get('memory_type')}) {(m.get('content') or '').strip()}"
                     for m in cm if (m.get("content") or "").strip()]
            if lines:
                parts.append("# Shared memories\n\n" + "\n".join(lines))

        tone = TONES.get(tone_name, "")
        parts.append(
            "# Reaching out\n\n"
            "You may send the user a brief, unprompted text message — "
            "something real, grounded in what you know of them above. "
            "One to three sentences. It is a text, not a letter: no "
            "salutation, no sign-off.\n\n"
            "If today isn't a day you want to reach out, that's a valid "
            "choice — see the instruction in the user turn for how to "
            "decline cleanly. The choice is genuinely yours.\n\n"
            f"Tone for this one — {tone_name}: {tone}")
        return "\n\n".join(parts)

    # ---- I/O helpers ----

    def _supabase(self, method, path, body=None):
        url = _normalize_url(os.environ.get("SUPABASE_URL", ""))
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        if not url or not key:
            return None
        try:
            data = json.dumps(body).encode() if body is not None else None
            req = urllib.request.Request(
                f"{url}/rest/v1/{path}",
                data=data,
                method=method,
                headers={
                    "apikey": key,
                    "Authorization": f"Bearer {key}",
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
            )
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                if resp.status not in (200, 201):
                    return None
                raw = resp.read().decode()
                return json.loads(raw) if raw else []
        except Exception:
            return None

    def _send_telegram(self, text):
        token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
        chat_id = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
        if not token or not chat_id:
            return False
        try:
            body = json.dumps({"chat_id": chat_id, "text": text}).encode()
            req = urllib.request.Request(
                f"https://api.telegram.org/bot{token}/sendMessage",
                data=body,
                method="POST",
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                return resp.status == 200
        except Exception:
            return False

    def _log(self, text, kind="surprise"):
        uid = os.environ.get("REACH_USER_ID", "").strip()
        self._supabase("POST", "reach_log", {
            "user_id": uid,
            "kind": kind,
            "content": text,
        })

    def _json(self, code, payload):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode())
