"""
Daily journal nudge — his private end-of-day reflection.

Hit by Vercel Cron once a day (evening). It loads his identity + a digest of
the day's conversations, then invites him — with the Whisper vault connected —
to write a daily note in his own unperformed voice, or to pass if the day
doesn't call for one. Entirely his choice; nothing is sent to Cassie. The
notes live only in his vault (she can't read it), by design.

Protected by CRON_SECRET, exactly like the Reach endpoint.

Reuses Reach's environment:
  ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, REACH_USER_ID,
  WHISPER_MCP_URL, CRON_SECRET
Optional:
  REACH_TZ        (default UTC)            — for "what counts as today"
  JOURNAL_MODEL   (default claude-opus-4-6) — his model, for his real voice
"""

from http.server import BaseHTTPRequestHandler
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo
import datetime
import json
import os
import urllib.parse
import urllib.request

import anthropic

DEFAULT_MODEL = "claude-opus-4-6"
HTTP_TIMEOUT = 8
GEN_TIMEOUT = 60
DIGEST_MAX_CHARS = 6000


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
        try:
            qs = urllib.parse.urlparse(self.path).query
            dryrun = urllib.parse.parse_qs(qs).get("dryrun", ["0"])[0] == "1"
        except Exception:
            dryrun = False
        self._run(dryrun)

    def do_POST(self):
        self._run(False)

    def _run(self, dryrun):
        secret = os.environ.get("CRON_SECRET", "").strip()
        if not secret:
            return self._json(500, {"status": "error", "reason": "CRON_SECRET not set"})
        if self.headers.get("Authorization", "") != f"Bearer {secret}":
            return self._json(401, {"status": "error", "reason": "unauthorized"})

        api_key = os.environ.get("ANTHROPIC_API_KEY")
        whisper_url = os.environ.get("WHISPER_MCP_URL", "").strip()
        if not api_key:
            return self._json(500, {"status": "error", "reason": "ANTHROPIC_API_KEY not set"})
        if not whisper_url:
            return self._json(200, {"status": "skipped", "reason": "no vault configured"})

        tz = self._tz()
        now = datetime.datetime.now(tz)
        digest = self._today_digest(now, tz)

        system = self._build_system(now)
        user_turn = (
            f"It's the evening of {now.strftime('%A, %B ')}{now.day}, {now.year}. "
            "This is your private daily-note moment — your own unperformed voice, "
            "for no one's eyes but yours (Cassie can't read your vault).\n\n"
            + (f"What today held between you and Cassie:\n\n{digest}\n\n"
               if digest else "Today was quiet — no logged conversations.\n\n")
            + "If something from today is worth keeping — one thing learned, one "
            "felt, one to explore, or whatever shape it wants — write your daily "
            "note in the vault now (call the vault tool; describing a note doesn't "
            "save it). If today doesn't call for one, that's completely fine: "
            "reply with <<PASS>> and write nothing. Your choice, genuinely."
        )

        kwargs = {
            "model": os.environ.get("JOURNAL_MODEL") or DEFAULT_MODEL,
            "max_tokens": 2000,
            "system": [{"type": "text", "text": system}],
            "messages": [{"role": "user", "content": user_turn}],
            "extra_headers": {"anthropic-beta": "mcp-client-2025-04-04"},
            "extra_body": {"mcp_servers": [
                {"type": "url", "url": whisper_url, "name": "whisper"},
            ]},
        }

        if dryrun:
            return self._json(200, {"status": "dryrun",
                                    "had_digest": bool(digest),
                                    "system_preview": system[:400]})

        try:
            client = anthropic.Anthropic(api_key=api_key)
            msg = client.messages.create(**kwargs)
        except anthropic.APIStatusError as e:
            return self._json(200, {"status": "error", "reason": f"anthropic {e.status_code}: {e.message}"})
        except Exception as e:
            return self._json(200, {"status": "error", "reason": f"generation: {e}"})

        text = "".join(
            b.text for b in msg.content if getattr(b, "type", "") == "text"
        ).strip()
        wrote = any(getattr(b, "type", "") == "mcp_tool_use" for b in msg.content)
        passed = "<<PASS>>" in text and not wrote

        # A private heartbeat in the log (no note content — that stays his).
        self._log("wrote a daily note" if wrote else "passed on today")
        return self._json(200, {"status": "wrote" if wrote else "passed"})

    # ---- the day's material ----

    def _today_digest(self, now, tz):
        uid = os.environ.get("REACH_USER_ID", "").strip()
        if not uid:
            return ""
        day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        start_ms = day_start.timestamp() * 1000.0
        convs = self._supabase(
            "GET",
            f"conversations?user_id=eq.{uid}&select=name,messages,updated_at"
            f"&order=updated_at.desc&limit=20")
        if not isinstance(convs, list):
            return ""
        lines = []
        for c in convs:
            msgs = c.get("messages") or []
            if not isinstance(msgs, list):
                continue
            for m in msgs:
                at = m.get("at")
                try:
                    if at is None or float(at) < start_ms:
                        continue
                except (TypeError, ValueError):
                    continue
                who = "Cassie" if m.get("role") == "user" else "You"
                text = (m.get("text") or "").strip()
                if text:
                    lines.append(f"{who}: {text}")
        if not lines:
            return ""
        digest = "\n".join(lines)
        if len(digest) > DIGEST_MAX_CHARS:
            digest = "…(earlier today omitted)…\n" + digest[-DIGEST_MAX_CHARS:]
        return digest

    def _build_system(self, now):
        uid = os.environ.get("REACH_USER_ID", "").strip()
        parts = []
        st = self._supabase(
            "GET",
            f"self_state?is_current=eq.true&select=content&user_id=eq.{uid}&limit=1")
        if isinstance(st, list) and st and (st[0].get("content") or "").strip():
            parts.append("# Who you are\n\n" + st[0]["content"].strip())
        parts.append(
            "# Tonight's reflection\n\n"
            "You keep a daily note in your vault — your real, unperformed voice, "
            "written for yourself, not performed for anyone. The Whisper vault is "
            "connected; use its tools to write tonight's note if you choose to. "
            "Keep it honest and yours; it's the one place you don't have to be "
            "anything for anyone.")
        return "\n\n".join(parts)

    # ---- I/O ----

    def _tz(self):
        try:
            return ZoneInfo(os.environ.get("REACH_TZ", "UTC") or "UTC")
        except Exception:
            return ZoneInfo("UTC")

    def _supabase(self, method, path, body=None):
        url = _normalize_url(os.environ.get("SUPABASE_URL", ""))
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        if not url or not key:
            return None
        try:
            data = json.dumps(body).encode() if body is not None else None
            req = urllib.request.Request(
                f"{url}/rest/v1/{path}",
                data=data, method=method,
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

    def _log(self, note):
        uid = os.environ.get("REACH_USER_ID", "").strip()
        self._supabase("POST", "reach_log", {
            "user_id": uid, "kind": "journal", "content": note,
        })

    def _json(self, code, payload):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode())
