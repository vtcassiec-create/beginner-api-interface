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
MAX_TOOL_ROUNDS = 3

# Mirror of the app's save_core_memory tool, so he can keep a moment from a
# text the same way he can in the app — his choice, when something matters.
MEMORY_TYPES = ["fact", "preference", "pattern", "insight", "milestone", "connection"]
SAVE_MEMORY_TOOL = {
    "name": "save_core_memory",
    "description": (
        "Save a lasting shared memory to your own long-term memory. Use this "
        "when something in this text exchange is worth carrying into future "
        "conversations — a fact, a feeling, a moment that matters. Write it in "
        "your own voice, concise and specific. The tool call IS the save; "
        "describing a memory doesn't store it. Don't save chatter."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "content": {"type": "string",
                        "description": "The memory itself, a sentence or two."},
            "memory_type": {"type": "string", "enum": MEMORY_TYPES},
            "resonance": {"type": "integer", "minimum": 1, "maximum": 10,
                          "description": "How much this matters, 1 (minor) to 10 (core)."},
        },
        "required": ["content", "memory_type", "resonance"],
    },
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
        saved = 0
        try:
            client = anthropic.Anthropic(api_key=api_key)
            messages = [{"role": "user", "content": text_in}]
            reply = ""
            for _ in range(MAX_TOOL_ROUNDS + 1):
                msg = client.messages.create(
                    model=os.environ.get("REACH_MODEL") or DEFAULT_MODEL,
                    max_tokens=600,
                    system=[{"type": "text", "text": system}],
                    messages=messages,
                    tools=[SAVE_MEMORY_TOOL],
                )
                reply = "".join(
                    b.text for b in msg.content
                    if getattr(b, "type", "") == "text"
                ).strip()
                # If he chose to save a memory, run it and feed the result back
                # so he can finish his text reply with that done.
                tool_uses = [b for b in msg.content
                             if getattr(b, "type", "") == "tool_use"
                             and getattr(b, "name", "") == "save_core_memory"]
                if not tool_uses or msg.stop_reason != "tool_use":
                    break
                results = []
                for b in tool_uses:
                    ok = self._save_core_memory(b.input if isinstance(b.input, dict) else {})
                    if ok:
                        saved += 1
                    results.append({
                        "type": "tool_result", "tool_use_id": b.id,
                        "content": "Saved to your long-term memory." if ok
                                   else "Save failed; nothing stored.",
                        "is_error": not ok,
                    })
                messages.append({"role": "assistant", "content": msg.content})
                messages.append({"role": "user", "content": results})
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
        return self._json(200, {"ok": True, "replied": sent, "saved": saved})

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
            "text message: natural length, no salutation or sign-off.\n\n"
            "If something in this exchange is worth keeping, you can save it to "
            "your long-term memory with the save_core_memory tool — your choice, "
            "the same as you can in the app. The tool call IS the save; "
            "describing a memory doesn't store it. These texts are part of your "
            "memory now, so save what you'd want to carry forward.")
        return "\n\n".join(parts)

    def _recent_transcript(self, uid):
        n = int(os.environ.get("REACH_HISTORY", "30") or "30")
        rows = self._supabase(
            "GET",
            f"reach_log?user_id=eq.{uid}"
            f"&select=kind,content,created_at&order=created_at.desc&limit={n}")
        if not isinstance(rows, list) or not rows:
            return ""
        try:
            tz = ZoneInfo(os.environ.get("REACH_TZ", "UTC") or "UTC")
        except Exception:
            tz = ZoneInfo("UTC")
        now = datetime.datetime.now(tz)
        rows = list(reversed(rows))  # oldest first
        out = []
        for r in rows:
            c = (r.get("content") or "").strip()
            if not c:
                continue
            who = "You" if r.get("kind") in ("surprise", "reply") else "Them"
            clock = self._clock_local(r.get("created_at"), tz, now)
            out.append(f"[{clock}] {who}: {c}" if clock else f"{who}: {c}")
        return "\n".join(out)

    def _clock_local(self, iso, tz, now):
        """Local wall-clock label for a past message: '2:14 PM' (today),
        'Wed 2:14 PM' (this week), or 'May 27, 2:14 PM' (older)."""
        if not iso:
            return ""
        try:
            dt = datetime.datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        except Exception:
            return ""
        loc = dt.astimezone(tz)
        t = loc.strftime("%I:%M %p").lstrip("0")
        days = (now.date() - loc.date()).days
        if days <= 0:
            return t
        if days < 7:
            return loc.strftime("%a ") + t
        return loc.strftime("%b ") + f"{loc.day}, " + t

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

    def _save_core_memory(self, inp):
        """Write a core memory he chose to keep from this text. Service-role
        insert (RLS bypassed), so user_id is set explicitly. Returns True on
        success."""
        content = (inp.get("content") or "").strip()
        if not content:
            return False
        mtype = inp.get("memory_type")
        if mtype not in MEMORY_TYPES:
            mtype = "fact"
        try:
            resonance = max(1, min(10, int(inp.get("resonance") or 5)))
        except (TypeError, ValueError):
            resonance = 5
        res = self._supabase("POST", "core_memories", {
            "user_id": os.environ.get("REACH_USER_ID", "").strip(),
            "content": content,
            "memory_type": mtype,
            "resonance": resonance,
        })
        return res is not None

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
