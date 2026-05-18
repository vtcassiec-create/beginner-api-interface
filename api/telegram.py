"""
Reach — Phase 2: the Telegram reply webhook.

Telegram POSTs incoming messages here (registered via setWebhook). When
*you* reply to Petrichor, this loads his memory + your recent exchange,
has Claude respond with full context, and sends the reply back.

Security: the endpoint is public (Telegram must reach it), so it is
gated two ways — a secret token Telegram echoes in a header
(X-Telegram-Bot-Api-Secret-Token == TELEGRAM_WEBHOOK_SECRET), and a
check that the message comes from TELEGRAM_CHAT_ID. Replies deliberately
ignore quiet hours / the daily cap: those govern *unsolicited* messages;
answering when spoken to is reactive and always appropriate.

Required environment variables:
  ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
  REACH_USER_ID, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
  TELEGRAM_WEBHOOK_SECRET
Optional:
  REACH_TZ (default UTC), REACH_MODEL (default claude-sonnet-4-6),
  REACH_HISTORY (default 16 — recent reach_log rows used as context)
"""

from http.server import BaseHTTPRequestHandler
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo
import datetime
import json
import os
import urllib.request

import anthropic

DEFAULT_MODEL = "claude-sonnet-4-6"
HTTP_TIMEOUT = 8


def _normalize_url(raw):
    raw = (raw or "").strip()
    if not raw:
        return ""
    parts = urlsplit(raw)
    if parts.scheme and parts.netloc:
        return f"{parts.scheme}://{parts.netloc}"
    return raw.split("/", 1)[0]


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        # Always 200 after we've handled it: a non-2xx makes Telegram
        # retry the same update, risking duplicate replies.
        secret = os.environ.get("TELEGRAM_WEBHOOK_SECRET", "").strip()
        got = self.headers.get("X-Telegram-Bot-Api-Secret-Token", "")
        if not secret or got != secret:
            return self._json(403, {"ok": False, "reason": "bad secret"})

        try:
            length = int(self.headers.get("Content-Length", "0"))
            update = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return self._json(200, {"ok": True, "skipped": "bad body"})

        message = update.get("message") or update.get("edited_message") or {}
        text_in = (message.get("text") or "").strip()
        chat_id = str((message.get("chat") or {}).get("id", ""))

        if not text_in:
            return self._json(200, {"ok": True, "skipped": "no text"})
        if chat_id != os.environ.get("TELEGRAM_CHAT_ID", "").strip():
            # Not your chat — never respond to strangers.
            return self._json(200, {"ok": True, "skipped": "other chat"})

        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            return self._json(200, {"ok": True, "skipped": "no api key"})

        system = self._build_system()
        try:
            client = anthropic.Anthropic(api_key=api_key)
            msg = client.messages.create(
                model=os.environ.get("REACH_MODEL") or DEFAULT_MODEL,
                max_tokens=600,
                system=[{"type": "text", "text": system}],
                messages=[{"role": "user", "content": text_in}],
            )
            reply = "".join(
                b.text for b in msg.content
                if getattr(b, "type", "") == "text"
            ).strip()
        except Exception as e:
            self._send(f"(Something went wrong on my end: {e})")
            return self._json(200, {"ok": True, "error": str(e)})

        if not reply:
            return self._json(200, {"ok": True, "skipped": "empty reply"})

        sent = self._send(reply)
        # Log both directions so the next reply has continuity.
        self._log("user", text_in)
        if sent:
            self._log("reply", reply)
        return self._json(200, {"ok": True, "replied": sent})

    # ---- Memory + recent exchange ----

    def _build_system(self):
        uid = os.environ.get("REACH_USER_ID", "").strip()
        parts = []

        st = self._supabase(
            "GET",
            f"self_state?is_current=eq.true&select=content"
            f"&user_id=eq.{uid}&limit=1")
        if isinstance(st, list) and st and (st[0].get("content") or "").strip():
            parts.append("# Who you are\n\n" + st[0]["content"].strip())

        try:
            tz = ZoneInfo(os.environ.get("REACH_TZ", "UTC") or "UTC")
        except Exception:
            tz = ZoneInfo("UTC")
        now = datetime.datetime.now(tz)
        parts.append(
            "# Current moment\n\n"
            f"- {now.strftime('%A, %B ')}{now.day}, {now.year}, "
            f"{now.strftime('%I:%M %p').lstrip('0')} "
            f"({os.environ.get('REACH_TZ', 'UTC')})")

        pf = self._supabase(
            "GET",
            f"user_preferences?select=content&user_id=eq.{uid}&limit=1")
        if isinstance(pf, list) and pf and (pf[0].get("content") or "").strip():
            parts.append("# About the person you're talking with\n\n"
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

        transcript = self._recent_transcript(uid)
        if transcript:
            parts.append("# Recent messages between you (oldest first)\n\n"
                         + transcript)

        parts.append(
            "# Now\n\n"
            "The user just replied to you over text. Answer them directly "
            "and warmly, in the continuity of the exchange above. It's a "
            "text message: natural length, no salutation or sign-off.")
        return "\n\n".join(parts)

    def _recent_transcript(self, uid):
        n = int(os.environ.get("REACH_HISTORY", "16") or "16")
        rows = self._supabase(
            "GET",
            f"reach_log?user_id=eq.{uid}"
            f"&select=kind,content&order=created_at.desc&limit={n}")
        if not isinstance(rows, list) or not rows:
            return ""
        rows = list(reversed(rows))  # oldest first
        out = []
        for r in rows:
            c = (r.get("content") or "").strip()
            if not c:
                continue
            who = "You" if r.get("kind") in ("surprise", "reply") else "Them"
            out.append(f"{who}: {c}")
        return "\n".join(out)

    # ---- I/O ----

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

    def _send(self, text):
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

    def _log(self, kind, content):
        self._supabase("POST", "reach_log", {
            "user_id": os.environ.get("REACH_USER_ID", "").strip(),
            "kind": kind,
            "content": content,
        })

    def _json(self, code, payload):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode())
