"""
Serverless endpoint for Cassie's Drawer — her own room in the shared vault.

The chat app reaches the Whisper vault only *through the model* (Anthropic's
MCP connector runs the tools). That's right for him — but wrong for a
journaling app: routing her own note-reads through the LLM would cost tokens,
add latency, and put his attention between her and her things. So this endpoint
talks to the vault **directly** over MCP (JSON-RPC), the way api/touch.py talks
to the Signal Bridge — no model, no tokens, just her drawer opening.

Scope is enforced HERE, in code: every path must live under `Cassie/`. The
drawer physically cannot read his Daily Notes or his diary — the "she can't
read his vault" line they drew stays intact by design, even though she owns the
whole thing. Her room, his room, same house.

The Whisper server (whisper-server/index.ts) runs the modern Streamable HTTP
transport in STATELESS mode (`sessionIdGenerator: undefined`) — a fresh MCP
server per request, sharing nothing between POSTs. So a multi-request session
dance can't work here: each tools/call must stand on its own. We send a
self-contained tools/call; if a server ever answers "not initialized" (a
stateful deployment), we fall back to a full initialize handshake and retry.

Authentication mirrors api/chat.py and api/touch.py: a Supabase access token in
the Authorization header, verified against /auth/v1/user.

Request body (POST JSON):
  action — "list" | "read" | "save"
  path   — relative vault path under Cassie/ (read, save)
  content— markdown body (save)

Response: { "ok": true, ... }  or  { "error": "..." }

Required environment variables:
  SUPABASE_URL, SUPABASE_ANON_KEY  — auth verification (as everywhere)
  WHISPER_MCP_URL                  — the vault's /mcp-<secret> endpoint
                                     (the secret is in the URL; no token)
"""

from http.server import BaseHTTPRequestHandler
from urllib.parse import urlsplit
import json
import os
import urllib.error
import urllib.request

AUTH_TIMEOUT_SECONDS = 5
VAULT_TIMEOUT_SECONDS = 15
MCP_PROTOCOL_VERSION = "2025-03-26"

# Her room. Every path the drawer touches must live under here — this is the
# wall between her drawer and his private notes, enforced server-side so no
# client bug (or crafted request) can reach past it.
ROOT = "Cassie/"
MAX_CONTENT_CHARS = 500_000     # a generous note; guards against runaway bodies


def _normalize_url(raw):
    """Reduce SUPABASE_URL to scheme://host[:port] (kept in sync with chat.py)."""
    raw = (raw or "").strip()
    if not raw:
        return ""
    parts = urlsplit(raw)
    if parts.scheme and parts.netloc:
        return f"{parts.scheme}://{parts.netloc}"
    return raw.split("/", 1)[0]


def _safe_path(raw):
    """Return a cleaned vault path if it's a real note inside her room, else
    None. Rejects anything outside Cassie/, path traversal, and non-notes."""
    p = (raw or "").strip().lstrip("/")
    if not p or ".." in p or "\\" in p:
        return None
    if not p.startswith(ROOT):
        return None
    if not p.lower().endswith(".md"):
        return None
    # No empty path segments (e.g. "Cassie//x.md") and a real filename.
    parts = p.split("/")
    if any(not seg.strip() for seg in parts):
        return None
    return p


class _VaultError(Exception):
    pass


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if not self._verify_auth():
            return self._json(401, {"error": "unauthorized"})

        url = os.environ.get("WHISPER_MCP_URL", "").strip()
        if not url:
            return self._json(500, {"error": "vault not configured"})

        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
            body = json.loads(self.rfile.read(length).decode()) if length else {}
        except Exception:
            return self._json(400, {"error": "bad request body"})

        action = str(body.get("action") or "").strip()
        try:
            if action == "list":
                return self._do_list(url)
            if action == "read":
                return self._do_read(url, body)
            if action == "save":
                return self._do_save(url, body)
        except _VaultError as e:
            return self._json(502, {"error": str(e)})
        except Exception as e:
            return self._json(502, {"error": f"vault: {e}"})
        return self._json(400, {"error": "unknown action"})

    # ---- Actions ----

    def _do_list(self, url):
        """Everything in her room, newest first."""
        data = self._vault_tool(url, "list_notes", {
            "folder": ROOT.rstrip("/"), "recursive": True, "limit": 500,
        })
        notes = data.get("notes") if isinstance(data, dict) else None
        return self._json(200, {"ok": True, "notes": notes or []})

    def _do_read(self, url, body):
        path = _safe_path(body.get("path"))
        if not path:
            return self._json(400, {"error": "path must be a note under Cassie/"})
        data = self._vault_tool(url, "read_note", {"path": path})
        if not isinstance(data, dict):
            return self._json(502, {"error": "unexpected vault response"})
        # read_note normally answers with JSON (content/frontmatter/...); if a
        # build of the tool ever returns the raw markdown instead, _tool_payload
        # hands it back under "text" — accept either so the note still opens.
        content = data.get("content")
        if content is None:
            content = data.get("text", "")
        return self._json(200, {
            "ok": True,
            "path": path,
            "content": content,
            "frontmatter": data.get("frontmatter") or {},
            "wordCount": data.get("wordCount"),
            "lastModified": data.get("lastModified"),
        })

    def _do_save(self, url, body):
        path = _safe_path(body.get("path"))
        if not path:
            return self._json(400, {"error": "path must be a note under Cassie/"})
        content = body.get("content")
        if not isinstance(content, str):
            return self._json(400, {"error": "content must be text"})
        if len(content) > MAX_CONTENT_CHARS:
            return self._json(400, {"error": "note is too long"})
        # overwrite=True so editing an existing note saves; creating a new one
        # works the same way (the tool makes intermediate folders as needed).
        self._vault_tool(url, "write_note", {
            "path": path, "content": content, "overwrite": True,
        })
        return self._json(200, {"ok": True, "path": path})

    # ---- MCP client (streamable HTTP, stdlib only) ----

    def _vault_tool(self, url, name, arguments):
        """Call one vault tool and return its parsed JSON payload. Primary path
        is a self-contained tools/call (correct for the stateless server). If a
        server reports it isn't initialized, do the full handshake and retry."""
        call = {
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        }
        msg = self._post(url, None, call)
        if self._needs_init(msg):
            session_id = self._handshake(url)
            msg = self._post(url, session_id, dict(call, id=2))
        return self._tool_payload(msg, name)

    @staticmethod
    def _needs_init(msg):
        """Did the server reject the call because no session was initialized?
        (Stateful deployments answer with a JSON-RPC error around -32002/-32600
        or a message mentioning initialize.)"""
        err = msg.get("error") if isinstance(msg, dict) else None
        if not isinstance(err, dict):
            return False
        text = f"{err.get('code', '')} {err.get('message', '')}".lower()
        return "initiali" in text or "session" in text

    def _handshake(self, url):
        """Full initialize → initialized handshake (the stateful fallback).
        Returns the Mcp-Session-Id if the server issued one, else None."""
        init = self._post(url, None, {
            "jsonrpc": "2.0", "id": 100, "method": "initialize",
            "params": {
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "petrichor-drawer", "version": "1.0"},
            },
        })
        session_id = init.get("_session_id")
        try:
            self._post(url, session_id, {
                "jsonrpc": "2.0", "method": "notifications/initialized",
            }, expect_response=False)
        except Exception:
            pass
        return session_id

    def _tool_payload(self, msg, name):
        """Unwrap a tools/call result into the JSON the tool returned. Vault
        tools answer with content:[{type:text, text:<json or message>}]; we
        json-parse the text when we can, else hand back the raw string."""
        if "error" in msg:
            raise _VaultError(msg["error"].get("message", f"{name} failed"))
        res = msg.get("result") or {}
        if res.get("isError"):
            blocks = res.get("content") or []
            text = " ".join(
                b.get("text", "") for b in blocks if isinstance(b, dict)
            ).strip()
            raise _VaultError(text or f"{name} reported an error")
        blocks = res.get("content") or []
        text = "".join(
            b.get("text", "") for b in blocks if isinstance(b, dict)
        ).strip()
        if not text:
            return {}
        try:
            return json.loads(text)
        except Exception:
            return {"text": text}

    def _post(self, url, session_id, payload, expect_response=True):
        """POST one JSON-RPC message. Returns the parsed response (handling both
        application/json and text/event-stream replies), with the
        Mcp-Session-Id (if any) tucked in under `_session_id`."""
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if session_id:
            headers["Mcp-Session-Id"] = session_id
        req = urllib.request.Request(
            url, data=json.dumps(payload).encode(), method="POST", headers=headers)
        try:
            resp = urllib.request.urlopen(req, timeout=VAULT_TIMEOUT_SECONDS)
        except urllib.error.HTTPError as e:
            # Surface the server's JSON-RPC error body if it sent one.
            raw = e.read().decode("utf-8", "replace") if e.fp else ""
            try:
                obj = json.loads(raw)
                if isinstance(obj, dict):
                    return obj
            except Exception:
                pass
            raise _VaultError(f"vault HTTP {e.code}")
        with resp:
            sid = resp.headers.get("Mcp-Session-Id")
            if not expect_response or resp.status == 202:
                return {"_session_id": sid}
            ctype = (resp.headers.get("Content-Type") or "").lower()
            raw = resp.read().decode("utf-8", "replace")
            if "text/event-stream" in ctype:
                msg = self._last_sse_json(raw, payload.get("id"))
            else:
                msg = json.loads(raw) if raw.strip() else {}
            if isinstance(msg, dict):
                msg["_session_id"] = sid
                return msg
            return {"_session_id": sid}

    @staticmethod
    def _last_sse_json(raw, want_id):
        """Pick the JSON-RPC response matching `want_id` out of an SSE body
        (falling back to the last data line that parses)."""
        last = None
        for line in raw.splitlines():
            line = line.strip()
            if not line.startswith("data:"):
                continue
            try:
                obj = json.loads(line[len("data:"):].strip())
            except Exception:
                continue
            last = obj
            if isinstance(obj, dict) and want_id is not None and obj.get("id") == want_id:
                return obj
        return last or {}

    # ---- Auth (mirrors chat.py / touch.py) ----

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
