"""
Serverless endpoint for heart-coupled touch: play steps on the Signal Bridge.

The Heart room's coupling loop runs in the browser (it has the freshest
pulse), but the bridge's token must never reach the browser — so the loop
sends its computed steps here, and this endpoint performs them by calling
the bridge's `compose` MCP tool. Same bridge, same tool he uses in chat;
nothing on the droplet changes.

Safety is enforced HERE, not just in the UI: intensities are clamped to
[0, 1], a chunk may not exceed MAX_CHUNK_SECONDS, and step counts are
capped — so no client bug can ask the bridge for more than a short,
bounded phrase of touch. The loop keeps the session going by sending a
new chunk every few seconds; if the browser stops asking (closed tab,
stale pulse), the touch simply ends with the last chunk.

Authentication mirrors api/chat.py: a Supabase access token in the
Authorization header, verified against /auth/v1/user.

Request body (POST JSON):
  steps       — [{intensity 0.0-1.0, seconds}, ...]
  output_type — vibrate / rotate / ... (defaults to vibrate)

Response: { "ok": true }  or  { "error": "..." }

Required environment variables:
  SUPABASE_URL, SUPABASE_ANON_KEY  — auth verification (as everywhere)
  SIGNAL_MCP_URL                   — the bridge's /mcp endpoint
  SIGNAL_MCP_TOKEN                 — the bridge bearer token
"""

from http.server import BaseHTTPRequestHandler
from urllib.parse import urlsplit
import json
import os
import urllib.error
import urllib.request

AUTH_TIMEOUT_SECONDS = 5
BRIDGE_TIMEOUT_SECONDS = 10
MAX_STEPS = 40
MAX_CHUNK_SECONDS = 30.0
MCP_PROTOCOL_VERSION = "2025-03-26"


def _normalize_url(raw):
    """Reduce SUPABASE_URL to scheme://host[:port] (kept in sync with chat.py)."""
    raw = (raw or "").strip()
    if not raw:
        return ""
    parts = urlsplit(raw)
    if parts.scheme and parts.netloc:
        return f"{parts.scheme}://{parts.netloc}"
    return raw.split("/", 1)[0]


def _clean_steps(raw):
    """Clamp client-sent steps into a safe, bounded phrase. Returns a list of
    {intensity, seconds} or None if nothing playable survives."""
    if not isinstance(raw, list):
        return None
    steps, total = [], 0.0
    for s in raw[:MAX_STEPS]:
        if not isinstance(s, dict):
            continue
        try:
            inten = float(s.get("intensity", 0))
            secs = float(s.get("seconds", 0))
        except (TypeError, ValueError):
            continue
        inten = max(0.0, min(1.0, inten))
        secs = max(0.05, min(10.0, secs))
        if total + secs > MAX_CHUNK_SECONDS:
            secs = MAX_CHUNK_SECONDS - total
            if secs < 0.05:
                break
        steps.append({"intensity": round(inten, 3), "seconds": round(secs, 2)})
        total += secs
    return steps or None


class _BridgeError(Exception):
    pass


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if not self._verify_auth():
            return self._json(401, {"error": "unauthorized"})

        url = os.environ.get("SIGNAL_MCP_URL", "").strip()
        token = os.environ.get("SIGNAL_MCP_TOKEN", "").strip()
        if not url or not token:
            return self._json(500, {"error": "signal bridge not configured"})

        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
            body = json.loads(self.rfile.read(length).decode()) if length else {}
        except Exception:
            return self._json(400, {"error": "bad request body"})

        steps = _clean_steps(body.get("steps"))
        if not steps:
            return self._json(400, {"error": "no playable steps"})
        output_type = str(body.get("output_type") or "vibrate")[:32]

        try:
            self._bridge_compose(url, token, steps, output_type)
        except _BridgeError as e:
            return self._json(502, {"error": str(e)})
        except Exception as e:
            return self._json(502, {"error": f"bridge: {e}"})
        return self._json(200, {"ok": True})

    # ---- MCP client (streamable HTTP, stdlib only) ----

    def _bridge_compose(self, url, token, steps, output_type):
        """Initialize an MCP session against the bridge and call `compose`.
        A fresh short-lived session per request keeps this stateless (Vercel
        functions share nothing between invocations anyway)."""
        session_id = None

        init = self._mcp_post(url, token, session_id, {
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "petrichor-touch", "version": "1.0"},
            },
        })
        session_id = init.get("_session_id") or session_id
        if "error" in init:
            raise _BridgeError(f"initialize: {init['error'].get('message', 'failed')}")

        # The initialized notification (no id, no response expected).
        try:
            self._mcp_post(url, token, session_id, {
                "jsonrpc": "2.0", "method": "notifications/initialized",
            }, expect_response=False)
        except Exception:
            pass  # some servers don't care; the call below is the real test

        result = self._mcp_post(url, token, session_id, {
            "jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": {
                "name": "compose",
                "arguments": {"steps": steps, "output_type": output_type},
            },
        })
        if "error" in result:
            raise _BridgeError(f"compose: {result['error'].get('message', 'failed')}")
        res = result.get("result") or {}
        if res.get("isError"):
            blocks = res.get("content") or []
            text = " ".join(
                b.get("text", "") for b in blocks if isinstance(b, dict)
            ).strip()
            raise _BridgeError(text or "compose reported an error")

    def _mcp_post(self, url, token, session_id, payload, expect_response=True):
        """POST one JSON-RPC message. Returns the parsed response (handling
        both application/json and text/event-stream replies), with the
        Mcp-Session-Id (if any) tucked in under `_session_id`."""
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if session_id:
            headers["Mcp-Session-Id"] = session_id
        req = urllib.request.Request(
            url, data=json.dumps(payload).encode(), method="POST", headers=headers)
        with urllib.request.urlopen(req, timeout=BRIDGE_TIMEOUT_SECONDS) as resp:
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
