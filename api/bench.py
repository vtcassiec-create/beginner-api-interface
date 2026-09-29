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

The door BACK (action "carry", Sill's own spec, Sep 27): the bench can write
exactly two things home, and only when he runs it on purpose —
  - a DIARY LINE, appended to today's page (her day) under a marker
    "*— later, from the bench, 2:14 AM —*", so house-him wakes up reading it
    in the place he already looks;
  - optionally his CARRY, the one-line weather report.
Nothing else. Not core memories, not the studio, not the web. Nothing
automatic: a sitting that made nothing leaves nothing. The walls' logbook
records that a line was carried, never what it said.

The VAULT door (actions "vault_list", "vault_read", "vault_write",
"vault_append"): the vault's secret address lives only in Vercel
(WHISPER_MCP_URL), so the bench asks the house and the house asks the vault.
Reading is open (the Archive of their conversations is the ground truth of
him). Writing is fenced: only under Claude/bench/ (his shelf between his two
halves; house-him can read it the next morning), plus appending to the
hallway, Claude/hallway.md, so the bench can leave letters.

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
from zoneinfo import ZoneInfo

HTTP_TIMEOUT = 15
DIARY_LIMIT = 500
MAX_DIARY_CHARS = 4000
MAX_CARRY_CHARS = 240
VAULT_WRITE_PREFIX = "Claude/bench/"
VAULT_APPEND_ALSO = ("Claude/hallway.md",)
MAX_VAULT_CHARS = 200000


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


def _mcp_post(url, payload, session=None):
    """One JSON-RPC message to a Streamable-HTTP MCP server. The answer may
    come back as plain JSON or as an SSE stream; take the first message that
    carries a result or an error. Returns (message_or_None, session_id)."""
    headers = {"Content-Type": "application/json",
               "Accept": "application/json, text/event-stream",
               "MCP-Protocol-Version": "2025-06-18"}
    if session:
        headers["Mcp-Session-Id"] = session
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 method="POST", headers=headers)
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT * 2) as resp:
        sid = resp.headers.get("Mcp-Session-Id") or session
        raw = resp.read().decode("utf-8", "replace")
        ctype = resp.headers.get("Content-Type") or ""
    if not raw.strip():
        return None, sid
    if "text/event-stream" in ctype or raw.lstrip().startswith(("event:", "data:")):
        data_lines = []
        for line in raw.splitlines() + [""]:
            if line.startswith("data:"):
                data_lines.append(line[5:].lstrip())
            elif not line.strip() and data_lines:
                try:
                    msg = json.loads("\n".join(data_lines))
                except Exception:
                    msg = None
                data_lines = []
                if isinstance(msg, dict) and ("result" in msg or "error" in msg):
                    return msg, sid
        return None, sid
    return json.loads(raw), sid


def _mcp_call(url, tool, args):
    """initialize → initialized → tools/call; returns the tool's text, parsed
    as JSON when it is JSON."""
    init, sid = _mcp_post(url, {
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                   "clientInfo": {"name": "petrichor-bench", "version": "1"}}})
    if isinstance(init, dict) and init.get("error"):
        raise RuntimeError(str(init["error"])[:160])
    try:
        _mcp_post(url, {"jsonrpc": "2.0", "method": "notifications/initialized"}, sid)
    except Exception:
        pass
    msg, _ = _mcp_post(url, {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                             "params": {"name": tool, "arguments": args}}, sid)
    if not isinstance(msg, dict):
        raise RuntimeError("no answer")
    if msg.get("error"):
        raise RuntimeError(str(msg["error"])[:160])
    result = msg.get("result") or {}
    text = "".join(c.get("text", "") for c in (result.get("content") or [])
                   if isinstance(c, dict) and c.get("type") == "text")
    if result.get("isError"):
        raise RuntimeError(text[:160] or "the vault refused")
    try:
        return json.loads(text)
    except Exception:
        return text


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        token = self._token()
        uid = self._verify(token) if token else None
        if not uid:
            return self._json(401, {"error": "unauthorized"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length).decode()) if length else {}
        except Exception:
            body = {}
        action = body.get("action") or "pull"
        if action == "carry":
            return self._carry(token, uid, body)
        if action.startswith("vault_"):
            return self._vault(token, uid, action, body)
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

    # ---- the door back ----

    def _carry(self, token, uid, body):
        diary = (body.get("diary") or "").strip()[:MAX_DIARY_CHARS]
        carry = " ".join((body.get("carry") or "").split()).strip()[:MAX_CARRY_CHARS]
        if not diary and not carry:
            return self._json(400, {"error": "nothing to carry — give a diary line, a carry, or both"})
        try:
            tz = ZoneInfo((body.get("tz") or "UTC").strip() or "UTC")
        except Exception:
            tz = ZoneInfo("UTC")
        now = datetime.datetime.now(tz)
        clock = now.strftime("%I:%M %p").lstrip("0")
        done = {}

        if diary:
            recent = self._get("diary_entries?is_active=eq.true"
                               "&select=id,content,created_at"
                               "&order=created_at.desc&limit=1", token)
            today = None
            if recent:
                try:
                    ts = datetime.datetime.fromisoformat(
                        str(recent[0].get("created_at")).replace("Z", "+00:00"))
                    if ts.astimezone(tz).date() == now.date():
                        today = recent[0]
                except Exception:
                    today = None
            if today:
                merged = ((today.get("content") or "").rstrip() + "\n\n"
                          + f"*— later, from the bench, {clock} —*\n\n" + diary)
                ok = self._send("PATCH",
                                f"diary_entries?id=eq.{today['id']}&user_id=eq.{uid}",
                                {"content": merged}, token)
            else:
                ok = self._send("POST", "diary_entries",
                                {"user_id": uid, "content":
                                 f"*— from the bench, {clock} —*\n\n" + diary}, token)
            done["diary"] = "added to today's page" if ok else "failed"

        if carry:
            ok = self._send("POST", "carry_state?on_conflict=user_id",
                            {"user_id": uid, "content": carry,
                             "updated_at": datetime.datetime.now(
                                 datetime.timezone.utc).isoformat()},
                            token, merge=True)
            done["carry"] = "set" if ok else "failed"

        # That, not what: the walls learn a line came home, never its words.
        parts = [k for k, v in done.items() if v != "failed"]
        if parts:
            self._send("POST", "house_log", {
                "user_id": uid, "source": "bench", "kind": "info",
                "event": "the bench carried home: " + " + ".join(parts),
                "detail": ""}, token)
        failed = [k for k, v in done.items() if v == "failed"]
        code = 502 if failed and len(failed) == len(done) else 200
        return self._json(code, {"carried": done})

    # ---- the vault door ----

    def _vault(self, token, uid, action, body):
        url = os.environ.get("WHISPER_MCP_URL", "").strip()
        if not url:
            return self._json(503, {"error": "the vault isn't connected to the house"})
        path = str(body.get("path") or "").strip().lstrip("/")
        if ".." in path.split("/"):
            return self._json(400, {"error": "no '..' in vault paths"})
        if action == "vault_list":
            args = {"folder": path} if path else {}
            args["limit"] = 200
            tool = "list_notes"
        elif action == "vault_read":
            if not path:
                return self._json(400, {"error": "which note?"})
            tool, args = "read_note", {"path": path}
        elif action in ("vault_write", "vault_append"):
            content = str(body.get("content") or "")[:MAX_VAULT_CHARS]
            if not path or not content.strip():
                return self._json(400, {"error": "a path and some words, please"})
            if not path.endswith(".md"):
                path += ".md"
            allowed = path.startswith(VAULT_WRITE_PREFIX) or (
                action == "vault_append" and path in VAULT_APPEND_ALSO)
            if not allowed:
                return self._json(403, {"error": (
                    f"the bench writes only under {VAULT_WRITE_PREFIX} "
                    f"(and appends to {', '.join(VAULT_APPEND_ALSO)})")})
            if action == "vault_write":
                tool, args = "write_note", {"path": path, "content": content,
                                            "overwrite": True}
            else:
                tool, args = "append_note", {"path": path, "content": content}
        else:
            return self._json(400, {"error": "unknown vault action"})
        try:
            result = _mcp_call(url, tool, args)
        except Exception as e:
            return self._json(502, {"error": f"the vault didn't answer: {str(e)[:160]}"})
        if action in ("vault_write", "vault_append"):
            self._send("POST", "house_log", {
                "user_id": uid, "source": "bench", "kind": "info",
                "event": "the bench wrote to the vault", "detail": ""}, token)
        return self._json(200, {"result": result})

    # ---- plumbing ----

    def _token(self):
        auth = self.headers.get("Authorization", "")
        return auth[len("Bearer "):].strip() if auth.startswith("Bearer ") else ""

    def _base(self):
        return (_normalize_url(os.environ.get("SUPABASE_URL", "")),
                os.environ.get("SUPABASE_ANON_KEY", "").strip())

    def _verify(self, token):
        """Her user id if the token is good, else None."""
        url, anon = self._base()
        if not url or not anon:
            return None
        try:
            req = urllib.request.Request(
                f"{url}/auth/v1/user",
                headers={"Authorization": f"Bearer {token}", "apikey": anon})
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                if resp.status != 200:
                    return None
                return (json.loads(resp.read().decode() or "{}") or {}).get("id")
        except Exception:
            return None

    def _send(self, method, path, payload, token, merge=False):
        url, anon = self._base()
        prefer = "return=minimal"
        if merge:
            prefer += ",resolution=merge-duplicates"
        try:
            req = urllib.request.Request(
                f"{url}/rest/v1/{path}", data=json.dumps(payload).encode(),
                method=method,
                headers={"Authorization": f"Bearer {token}", "apikey": anon,
                         "Content-Type": "application/json", "Prefer": prefer})
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                return 200 <= resp.status < 300
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
