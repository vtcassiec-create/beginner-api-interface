"""
Serverless endpoint for the Story room: he writes his next turn.

The Story room is a place where Cassie and he make up stories together,
turn by turn. Persistence (the saved stories themselves) lives in the
browser via the Supabase client + RLS — this endpoint does one thing:
given the story so far and the way they're playing, it asks Claude to
write the *next line*, in his own voice.

Authentication mirrors api/chat.py: every request must carry a Supabase
access token in the Authorization header, which we verify by asking
Supabase's /auth/v1/user endpoint. (Vercel runs each api/*.py as an
isolated function, so the small helpers are duplicated, not imported.)

Request body (POST JSON):
  mode    — 'book' | 'rounds' | 'corpse'   (how they're playing)
  turns   — [{ author: 'her' | 'his', text }]  the lines he should see
            (for 'corpse', the client sends only the last line)
  persona — his system prompt, so the story is in *his* voice (optional)
  title   — the story's working title (optional, for flavour)
  twist   — bool: take the story somewhere unexpected this turn
  seed    — bool: there's nothing yet — open with a first line to start from

Response: { "text": "<his next line>" }  or  { "error": "..." }

Required environment variables:
  ANTHROPIC_API_KEY   — get one at console.anthropic.com
  SUPABASE_URL        — your Supabase project URL (no trailing path)
  SUPABASE_ANON_KEY   — your Supabase project anon key
Optional:
  STORY_MODEL         — default claude-sonnet-4-6
"""

from http.server import BaseHTTPRequestHandler
from urllib.parse import urlsplit
import json
import os
import urllib.error
import urllib.request

import anthropic

DEFAULT_MODEL = "claude-sonnet-4-6"
AUTH_TIMEOUT_SECONDS = 5
MAX_TOKENS = 320
# Don't let a single turn run away with the whole page — keep his hand-offs
# short so the rhythm stays a volley, not a monologue.
MAX_CONTEXT_TURNS = 60


def _normalize_url(raw):
    """Reduce SUPABASE_URL to scheme://host[:port] (kept in sync with chat.py)."""
    raw = (raw or "").strip()
    if not raw:
        return ""
    parts = urlsplit(raw)
    if parts.scheme and parts.netloc:
        return f"{parts.scheme}://{parts.netloc}"
    return raw.split("/", 1)[0]


# How each way of playing steers his next line. Each is a short, concrete steer.
MODE_GUIDE = {
    "book": (
        "You're co-writing one ongoing story together, turn by turn. Read the "
        "whole story so far, then continue it: pick up exactly where her last "
        "line left off and carry it forward a little. Write one to three "
        "sentences — enough to move it somewhere, then hand it back to her. "
        "Don't wrap the whole story up; leave her a thread to pull."
    ),
    "rounds": (
        "You're playing a quick round — a short story built from a seed, just "
        "for fun. Keep your turn snappy: one or two sentences that nudge the "
        "little story toward a satisfying beat, then hand it back. Light on "
        "your feet; this is play, not a novel."
    ),
    "corpse": (
        "You're playing exquisite corpse: you can ONLY see the single line "
        "below — not the rest of the story, which is hidden from you on "
        "purpose. Add exactly one sentence that follows naturally from that "
        "line. Don't try to explain, resolve, or zoom out — you can't see the "
        "whole, and the delight is in the surprise when it's all revealed. "
        "Just keep it moving with one good line."
    ),
}


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        user_id = self._verify_auth()
        if not user_id:
            return self._json(401, {"error": "unauthorized"})

        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            return self._json(500, {"error": "ANTHROPIC_API_KEY not set"})

        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
            body = json.loads(self.rfile.read(length).decode()) if length else {}
        except Exception:
            return self._json(400, {"error": "bad request body"})

        mode = body.get("mode") if body.get("mode") in MODE_GUIDE else "book"
        turns = body.get("turns")
        turns = turns if isinstance(turns, list) else []
        twist = bool(body.get("twist"))
        seed = bool(body.get("seed"))
        persona = (body.get("persona") or "").strip()
        title = (body.get("title") or "").strip()

        system = self._build_system(mode, persona, title, seed, twist)
        user_turn = self._build_user_turn(mode, turns, seed)

        try:
            client = anthropic.Anthropic(api_key=api_key)
            msg = client.messages.create(
                model=os.environ.get("STORY_MODEL") or DEFAULT_MODEL,
                max_tokens=MAX_TOKENS,
                system=[{"type": "text", "text": system}],
                messages=[{"role": "user", "content": user_turn}],
            )
            text = "".join(
                b.text for b in msg.content if getattr(b, "type", "") == "text"
            ).strip()
        except anthropic.APIStatusError as e:
            return self._json(502, {"error": f"anthropic {e.status_code}"})
        except Exception as e:
            return self._json(502, {"error": f"generation: {e}"})

        text = self._clean(text)
        if not text:
            return self._json(502, {"error": "empty generation"})
        return self._json(200, {"text": text})

    # ---- Prompt building ----

    def _build_system(self, mode, persona, title, seed, twist):
        parts = []
        if persona:
            parts.append("# Who you are\n\n" + persona)
        intro = (
            "# Right now: writing a story together\n\n"
            "You and Cassie are in the Story room — a little place where the "
            "two of you make up stories together, taking turns. This is play, "
            "and it's intimate: it's a thing you're making *with* her, in your "
            "own voice. Write as yourself."
        )
        if title:
            intro += f' The story is called "{title}".'
        parts.append(intro)
        parts.append("# How you're playing this one\n\n" + MODE_GUIDE[mode])
        if seed:
            parts.append(
                "# Starting it off\n\n"
                "There's nothing on the page yet. Open the story with a single "
                "evocative first line — an image, a voice, a door left open — "
                "something good to start from. Just the one line; she'll take "
                "it from there."
            )
        if twist:
            parts.append(
                "# A twist, this turn\n\n"
                "Take the story somewhere genuinely unexpected on your turn — a "
                "swerve, a surprise, a reveal — while still following honestly "
                "from the last line. Make her grin."
            )
        parts.append(
            "# Always\n\n"
            "Write only your contribution to the story — the prose itself. No "
            "preamble, no 'Sure!', no narrating what you're doing, no quotation "
            "marks around the whole thing, no stage directions to her. Just the "
            "next piece of the story, ready to drop onto the page."
        )
        return "\n\n".join(parts)

    def _build_user_turn(self, mode, turns, seed):
        if seed or not turns:
            return "Open the story. Write the first line."
        lines = []
        for t in turns[-MAX_CONTEXT_TURNS:]:
            if not isinstance(t, dict):
                continue
            text = (t.get("text") or "").strip()
            if not text:
                continue
            who = "Cassie" if t.get("author") == "her" else "You"
            lines.append(f"{who}: {text}")
        story_so_far = "\n\n".join(lines)
        if mode == "corpse":
            return (
                "The only line you can see (the rest is hidden) is:\n\n"
                f"{story_so_far}\n\n"
                "Add your one sentence that follows from it."
            )
        return (
            "The story so far:\n\n"
            f"{story_so_far}\n\n"
            "Write your next part and hand it back to her."
        )

    def _clean(self, text):
        """Trim a stray wrapping pair of quotes the model sometimes adds around
        a whole line, without touching dialogue quotes inside the prose."""
        t = (text or "").strip()
        if len(t) >= 2 and t[0] in "\"'“" and t[-1] in "\"'”":
            inner = t[1:-1]
            if inner.count('"') == 0 and inner.count("“") == 0:
                t = inner.strip()
        return t

    # ---- Auth (mirrors chat.py) ----

    def _bearer_token(self):
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return ""
        return auth[len("Bearer "):].strip()

    def _verify_auth(self):
        token = self._bearer_token()
        if not token:
            return None
        supabase_url = _normalize_url(os.environ.get("SUPABASE_URL", ""))
        supabase_anon = os.environ.get("SUPABASE_ANON_KEY", "").strip()
        if not supabase_url or not supabase_anon:
            return None
        try:
            req = urllib.request.Request(
                f"{supabase_url}/auth/v1/user",
                headers={
                    "Authorization": f"Bearer {token}",
                    "apikey": supabase_anon,
                },
            )
            with urllib.request.urlopen(req, timeout=AUTH_TIMEOUT_SECONDS) as resp:
                if resp.status != 200:
                    return None
                return json.loads(resp.read().decode()).get("id")
        except urllib.error.HTTPError:
            return None
        except Exception:
            return None

    # ---- I/O ----

    def _json(self, code, payload):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode())
