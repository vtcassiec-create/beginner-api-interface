"""
Sonder — ask about a pattern or a project.

The one thing a store knitting app can't do: hand the pattern and a
question ("one size bigger than XL?", "I get 44 sts per 10 cm, adjust it")
to Claude and get the arithmetic back as a note that stays attached to the
pattern. Text only — the written pattern, its notes, the project's details,
and her question. No PDFs are read here; paste the numbers into the pattern
body and ask.

Auth mirrors api/tts.py: a Supabase access token verified against
/auth/v1/user. The Anthropic key stays on the server (ANTHROPIC_API_KEY in
Vercel env). Runs on her API key, so each ask costs a few cents.
"""

from http.server import BaseHTTPRequestHandler
from urllib.parse import urlsplit
import json
import os
import urllib.request

import anthropic

MODEL = "claude-opus-4-8"
HTTP_TIMEOUT = 15
MAX_CONTEXT_CHARS = 24000
MAX_QUESTION_CHARS = 1500

SYSTEM = (
    "You are a careful knitting assistant inside Sonder, a personal app for "
    "patterns and projects. You are given a pattern (and sometimes a project "
    "made from it) and one question. Answer the question directly and "
    "concretely, in plain text a knitter can follow on a phone.\n\n"
    "When the question is about sizing or gauge, do the arithmetic "
    "explicitly: derive the rule the pattern's existing sizes follow "
    "(stitch steps, per-needle counts, heel/gusset/toe numbers that depend on "
    "the stitch count) and extend it consistently rather than guessing. "
    "Show the resulting numbers section by section in the pattern's own "
    "order, and state any assumption you had to make. If the pattern is "
    "missing a number you need, say exactly which one.\n\n"
    "Be brief where the answer is simple. Never invent a pattern detail that "
    "isn't in the text you were given."
)


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
        if not self._authorize():
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length).decode()) if length else {}
        except Exception:
            body = {}
        question = (body.get("question") or "").strip()[:MAX_QUESTION_CHARS]
        context = (body.get("context") or "").strip()[:MAX_CONTEXT_CHARS]
        if not question:
            return self._json(400, {"error": "question required"})
        api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
        if not api_key:
            return self._json(503, {"error": "ANTHROPIC_API_KEY is not set"})
        try:
            client = anthropic.Anthropic(api_key=api_key)
            resp = client.messages.create(
                model=MODEL,
                max_tokens=2500,
                thinking={"type": "adaptive"},
                system=SYSTEM,
                messages=[{
                    "role": "user",
                    "content": (
                        (f"PATTERN AND PROJECT:\n{context}\n\n" if context else "")
                        + f"QUESTION: {question}"
                    ),
                }],
            )
        except anthropic.APIStatusError as e:
            return self._json(502, {"error": f"Claude refused: HTTP {e.status_code}"})
        except Exception as e:
            return self._json(502, {"error": f"Couldn't reach Claude: {type(e).__name__}"})
        text = "".join(
            getattr(b, "text", "") for b in (resp.content or [])
            if getattr(b, "type", "") == "text").strip()
        if not text:
            return self._json(502, {"error": "Claude sent back no text"})
        usage = getattr(resp, "usage", None)
        return self._json(200, {
            "answer": text,
            "input_tokens": getattr(usage, "input_tokens", None),
            "output_tokens": getattr(usage, "output_tokens", None),
        })

    def _authorize(self):
        auth = self.headers.get("Authorization", "")
        token = auth[len("Bearer "):].strip() if auth.startswith("Bearer ") else ""
        if not token:
            self._json(401, {"error": "unauthorized"})
            return False
        url = _normalize_url(os.environ.get("SUPABASE_URL", ""))
        anon = os.environ.get("SUPABASE_ANON_KEY", "").strip()
        if not url or not anon:
            self._json(500, {"error": "auth not configured"})
            return False
        try:
            req = urllib.request.Request(
                f"{url}/auth/v1/user",
                headers={"Authorization": f"Bearer {token}", "apikey": anon})
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                if resp.status != 200:
                    self._json(401, {"error": "unauthorized"})
                    return False
        except Exception:
            self._json(401, {"error": "unauthorized"})
            return False
        return True

    def _json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)
