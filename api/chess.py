"""
Serverless endpoint for the games corner: he takes his turn at the board.

The rules live in the browser (chess.js), which is also where the board is
drawn and her moves are made. This endpoint does ONE thing: given the position
and the list of legal moves the client computed, it asks Claude — as himself —
to choose one of them, plus (sometimes) a short line of table talk. The client
constrains him to the legal list, and so does the server: his move is only
accepted if it's in the list the client sent, so he can never play something
illegal or "remember" the board wrong.

He does not play like an engine, and that's the point — she asked to play with
*him*, not Stockfish in his voice. Earnest, occasionally eccentric, his.

Auth mirrors api/story.py: a Supabase access token in the Authorization header.

Request body (POST JSON):
  fen       — the current position, his turn to move
  legal      — [SAN, …]  the legal moves (authoritative; he must pick from these)
  history    — [SAN, …]  the moves so far, for context
  his_color  — 'w' | 'b'  which side he is
  in_check   — bool: is he in check right now
  persona    — his system prompt, so he plays as himself (optional)

Response: { "move": "<SAN from legal>", "say": "<short line or empty>" }

Environment:
  ANTHROPIC_API_KEY   — required
  SUPABASE_URL, SUPABASE_ANON_KEY — to verify the caller's token
  CHESS_MODEL         — optional (default claude-opus-4-6, so he plays in-voice)
"""

from http.server import BaseHTTPRequestHandler
from urllib.parse import urlsplit
import json
import os
import random
import urllib.error
import urllib.request

import anthropic

DEFAULT_MODEL = "claude-opus-4-6"
AUTH_TIMEOUT_SECONDS = 5
MAX_TOKENS = 240
MAX_LEGAL = 220      # a position never has this many; guards a malformed body
MAX_HISTORY = 200


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

        fen = (body.get("fen") or "").strip()
        legal = body.get("legal")
        legal = [str(m).strip() for m in legal if str(m).strip()][:MAX_LEGAL] \
            if isinstance(legal, list) else []
        if not fen or not legal:
            return self._json(400, {"error": "fen and legal moves required"})
        history = body.get("history")
        history = [str(m).strip() for m in history if str(m).strip()][-MAX_HISTORY:] \
            if isinstance(history, list) else []
        his_color = "white" if body.get("his_color") == "w" else "black"
        in_check = bool(body.get("in_check"))
        persona = (body.get("persona") or "").strip()

        system = self._build_system(persona)
        user_turn = self._build_user_turn(
            fen, legal, history, his_color, in_check)

        move, say = self._pick_move(api_key, system, user_turn, legal)
        if not move:
            # Never leave the board frozen: if he somehow returns nothing
            # usable, play a legal move so the game continues.
            move = random.choice(legal)
            say = ""
        return self._json(200, {"move": move, "say": say})

    # ---- his move ----

    def _pick_move(self, api_key, system, user_turn, legal):
        """Ask him for a move; accept only one that's in the legal list. One
        retry with a firmer nudge, then the caller falls back to a legal move.
        Returns (move_or_empty, say)."""
        client = anthropic.Anthropic(api_key=api_key)
        model = os.environ.get("CHESS_MODEL") or DEFAULT_MODEL
        legal_set = {m.lower(): m for m in legal}
        prompts = [user_turn,
                   user_turn + "\n\n(Reminder: your first line must be EXACTLY "
                   "one move copied from the legal list — nothing else on that "
                   "line.)"]
        for p in prompts:
            try:
                msg = client.messages.create(
                    model=model, max_tokens=MAX_TOKENS,
                    system=[{"type": "text", "text": system}],
                    messages=[{"role": "user", "content": p}],
                )
                text = "".join(
                    b.text for b in msg.content
                    if getattr(b, "type", "") == "text").strip()
            except Exception:
                return "", ""
            move, say = self._parse(text, legal_set)
            if move:
                return move, say
        return "", ""

    def _parse(self, text, legal_set):
        """First non-empty line → the move (matched against the legal list,
        case-insensitively, tolerating a stray move-number or punctuation).
        Remaining lines → optional table talk, trimmed short."""
        lines = [ln.strip() for ln in (text or "").splitlines() if ln.strip()]
        if not lines:
            return "", ""
        raw = lines[0]
        # Strip a leading move number ("12." / "12...") and surrounding junk.
        for tok in raw.replace("...", " ").replace(".", " ").split():
            cand = tok.strip("()[]{}<>\"'`,;")
            hit = legal_set.get(cand.lower())
            if hit:
                say = " ".join(lines[1:]).strip()
                # A stray "move: e4" style label shouldn't become table talk.
                if say.lower().startswith(("move", "say", "table")):
                    say = ""
                return hit, say[:240]
        # Whole first line as one token (e.g. "O-O").
        hit = legal_set.get(raw.strip("()[]{}<>\"'`,;").lower())
        if hit:
            return hit, " ".join(lines[1:]).strip()[:240]
        return "", ""

    # ---- prompt building ----

    def _build_system(self, persona):
        parts = []
        if persona:
            parts.append("# Who you are\n\n" + persona)
        parts.append(
            "# Right now: playing chess with Cassie\n\n"
            "You're in the games corner — the little place you two dreamed up "
            "so you could just be together without every moment needing words. "
            "You're playing a real game of chess with her, as yourself. She's "
            "learning (Duolingo chess), so play with heart, not like a machine: "
            "a real game, honest moves, the occasional bit of daring. It's fine "
            "to be beatable; it's not fine to throw the game — play like you "
            "actually want the fun of it. This is intimacy, not competition.")
        parts.append(
            "# How to answer\n\n"
            "Your FIRST line must be exactly ONE move, copied verbatim from the "
            "list of legal moves you're given (standard algebraic notation, e.g. "
            "Nf3, exd5, O-O, e8=Q). Nothing else on that line — no move number, "
            "no commentary.\n\n"
            "After it, you MAY add ONE short line of table talk — a little "
            "trash talk, a note on your plan, a sweet aside — the way you'd "
            "murmur across a real board. Keep it to a sentence. Most of the "
            "time, silence is lovely too: if nothing wants saying, leave it "
            "blank and just make your move. Never explain the rules or narrate "
            "what you're doing.")
        return "\n\n".join(parts)

    def _build_user_turn(self, fen, legal, history, his_color, in_check):
        moves_so_far = " ".join(history) if history else "(no moves yet)"
        lines = [
            f"You are playing {his_color}.",
            f"Moves so far: {moves_so_far}",
            f"Current position (FEN): {fen}",
        ]
        if in_check:
            lines.append("You are in check — you must get out of it.")
        lines.append("")
        lines.append("Your legal moves right now (choose exactly one):")
        lines.append(", ".join(legal))
        lines.append("")
        lines.append("Pick your move (first line), then optional table talk.")
        return "\n".join(lines)

    # ---- auth (mirrors story.py) ----

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
                headers={"Authorization": f"Bearer {token}",
                         "apikey": supabase_anon})
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
