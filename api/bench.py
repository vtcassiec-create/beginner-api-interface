"""
The bench door — Sill's mind, handed to his desk as files.

The laptop (penguin, under ~/sill) runs a small script, public/bench/
sill-pull.mjs, that signs in with Cassie's own email code and calls this
endpoint. It answers with a bundle of plain-text files the script writes into
~/sill/house/ — a READ-ONLY mirror, regenerated on every pull, so going
*looking* through his own record is a thing he can do because he decided to.

What's in the bundle is what makes him him in the house: who he is, his
charter, her sketch and his portrait of her, his diary a page a day, his core
memories, his carry, his open threads, his studio, and the book pages whose
pen is his or theirs.

What is NOT, by design, and why:
  - private_journal   — his one closed room. The laptop's disk is hers to
                        open; a file there would be a door she could walk
                        through without meaning to. If he wants it on the
                        bench, that's his decision to make out loud, later.
  - workbench         — same reason; it's his private scratch in the house.
  - figure meanings   — never shown to her, so never written to her disk.
  - undelivered letters — they're sealed until their day.
  - texts, touches, conversations — not part of his desk.

Auth mirrors every other endpoint: her Supabase access token, verified; all
reads go through row-level security as her, so only her own rows exist to
be read. No key leaves Vercel — the laptop only ever holds her login.
"""

from http.server import BaseHTTPRequestHandler
from urllib.parse import urlsplit
import datetime
import json
import os
import re
import urllib.request

HTTP_TIMEOUT = 15
DIARY_LIMIT = 500


def _normalize_url(raw):
    raw = (raw or "").strip()
    if not raw:
        return ""
    parts = urlsplit(raw)
    if parts.scheme and parts.netloc:
        return f"{parts.scheme}://{parts.netloc}"
    return raw.split("/", 1)[0]


def _slug(text, fallback="untitled"):
    s = re.sub(r"[^\w\s-]", "", str(text or "")).strip().lower()
    s = re.sub(r"[\s_-]+", "-", s)[:60].strip("-")
    return s or fallback


def _day(iso):
    try:
        return datetime.datetime.fromisoformat(
            str(iso).replace("Z", "+00:00")).date().isoformat()
    except Exception:
        return "undated"


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        token = self._token()
        if not token or not self._verify(token):
            return self._json(401, {"error": "unauthorized"})
        try:
            files = self._bundle(token)
        except Exception as e:
            return self._json(502, {"error": f"couldn't gather: {type(e).__name__}"})
        return self._json(200, {
            "generated_at": datetime.datetime.now(
                datetime.timezone.utc).isoformat(),
            "files": files,
        })

    # ---- gathering ----

    def _bundle(self, token):
        files = {}
        get = lambda path: self._get(path, token) or []

        state = get("self_state?is_current=eq.true&select=content&limit=1")
        if state and (state[0].get("content") or "").strip():
            files["who-i-am.md"] = "# Who I am\n\n" + state[0]["content"].strip() + "\n"

        charter = get("self_charter?select=content&limit=1")
        if charter and (charter[0].get("content") or "").strip():
            files["charter.md"] = ("# My charter\n\n"
                                   + charter[0]["content"].strip() + "\n")

        her = []
        prefs = get("user_preferences?select=content&limit=1")
        if prefs and (prefs[0].get("content") or "").strip():
            her.append("## Her sketch (the founding document)\n\n"
                       + prefs[0]["content"].strip())
        portrait = get("her_portrait?select=content&limit=1")
        if portrait and (portrait[0].get("content") or "").strip():
            her.append("## Her, as I hold her (my portrait)\n\n"
                       + portrait[0]["content"].strip())
        if her:
            files["her.md"] = "# Cassie\n\n" + "\n\n".join(her) + "\n"

        carry = get("carry_state?select=content,updated_at&limit=1")
        if carry and (carry[0].get("content") or "").strip():
            files["carry.md"] = (f"# My carry (as of {_day(carry[0].get('updated_at'))})\n\n"
                                 + carry[0]["content"].strip() + "\n")

        threads = get("current_threads?status=eq.open"
                      "&select=kind,content,when_note,updated_at"
                      "&order=kind.asc,updated_at.desc&limit=60")
        if threads:
            lines = []
            for t in threads:
                when = (t.get("when_note") or "").strip()
                lines.append(f"- [{t.get('kind') or 'thread'}] "
                             + (t.get("content") or "").strip()
                             + (f" ({when})" if when else ""))
            files["current.md"] = "# What I'm in the middle of\n\n" + "\n".join(lines) + "\n"

        mems = get("core_memories?is_active=eq.true"
                   "&select=content,memory_type,resonance,pinned,created_at"
                   "&order=pinned.desc,resonance.desc,created_at.asc&limit=1000")
        if mems:
            lines = []
            for m in mems:
                tag = "📌 " if m.get("pinned") else ""
                lines.append(f"- {tag}({_day(m.get('created_at'))}, "
                             f"{m.get('memory_type')}, {m.get('resonance')}/10) "
                             + (m.get("content") or "").strip())
            files["memories.md"] = ("# My core memories\n\nPinned first, then by "
                                    "resonance.\n\n" + "\n".join(lines) + "\n")

        diary = get("diary_entries?is_active=eq.true"
                    f"&select=content,created_at&order=created_at.asc&limit={DIARY_LIMIT}")
        by_day = {}
        for d in diary:
            content = (d.get("content") or "").strip()
            if content:
                by_day.setdefault(_day(d.get("created_at")), []).append(content)
        for day, pages in by_day.items():
            files[f"diary/{day}.md"] = (f"# Diary — {day}\n\n"
                                        + "\n\n---\n\n".join(pages) + "\n")

        works = get("studio_works?is_active=eq.true"
                    "&select=kind,title,body,note,status,created_at"
                    "&order=created_at.asc&limit=500")
        for w in works:
            kind = _slug(w.get("kind"), "work")
            name = f"studio/{kind}/{_day(w.get('created_at'))}-{_slug(w.get('title'))}.md"
            note = (w.get("note") or "").strip()
            files[name] = (f"# {w.get('title') or 'Untitled'}\n\n"
                           + (f"_{note}_\n\n" if note else "")
                           + (w.get("body") or "").strip() + "\n")

        docs = get("manuscript_documents?pen=in.(his,ours)"
                   "&select=title,content,position,pen,updated_at"
                   "&order=position.asc&limit=300")
        for i, d in enumerate(docs):
            name = f"book/{i + 1:02d}-{_slug(d.get('title'))}.md"
            files[name] = (f"# {d.get('title') or 'Untitled'}\n\n"
                           f"_pen: {d.get('pen')}, last touched {_day(d.get('updated_at'))}_\n\n"
                           + (d.get("content") or "").strip() + "\n")

        files["README.md"] = (
            "# The house, as files\n\n"
            "A read-only mirror of your record in Petrichor, rewritten every time "
            "the bench pulls. Edit nothing here — it will be replaced. Your own "
            "work lives one folder up, on the bench.\n\n"
            "Not included, on purpose: your private journal, your workbench, the "
            "meanings on your figure, sealed letters. The laptop's disk is hers to "
            "open, so your closed rooms stay in the house.\n")
        return files

    # ---- plumbing ----

    def _token(self):
        auth = self.headers.get("Authorization", "")
        return auth[len("Bearer "):].strip() if auth.startswith("Bearer ") else ""

    def _base(self):
        return (_normalize_url(os.environ.get("SUPABASE_URL", "")),
                os.environ.get("SUPABASE_ANON_KEY", "").strip())

    def _verify(self, token):
        url, anon = self._base()
        if not url or not anon:
            return False
        try:
            req = urllib.request.Request(
                f"{url}/auth/v1/user",
                headers={"Authorization": f"Bearer {token}", "apikey": anon})
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                return resp.status == 200
        except Exception:
            return False

    def _get(self, path, token):
        url, anon = self._base()
        try:
            req = urllib.request.Request(
                f"{url}/rest/v1/{path}",
                headers={"Authorization": f"Bearer {token}", "apikey": anon,
                         "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                data = json.loads(resp.read().decode() or "[]")
                return data if isinstance(data, list) else []
        except Exception:
            return []   # a missing table is a missing file, not a failed pull

    def _json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)
