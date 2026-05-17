"""
Serverless endpoint that proxies chat requests to the Claude API.

Runs on Vercel's Python runtime. Streams the model's response back to the
browser using Server-Sent Events (SSE) so messages appear as they're written.

Authentication: every request must carry a Supabase access token in the
Authorization header. We verify by asking Supabase's /auth/v1/user endpoint
whether the token is valid — if it returns a user, the token is good. This
sidesteps any JWT-algorithm choices Supabase makes (HS256 vs RS256 vs ES256)
and means there's no JWT secret to copy-paste correctly.

Required environment variables:
  ANTHROPIC_API_KEY   — get one at console.anthropic.com
  SUPABASE_URL        — your Supabase project URL (no trailing path)
  SUPABASE_ANON_KEY   — your Supabase project anon key
"""

from http.server import BaseHTTPRequestHandler
import json
import os
import urllib.error
import urllib.request
from urllib.parse import urlsplit

import anthropic


def _normalize_url(raw):
    """Reduce SUPABASE_URL to scheme://host[:port].

    Kept in sync with the identical helper in config.py. A trailing slash
    or stray path (e.g. ".../rest/v1") would make the /auth/v1/user call
    resolve to an invalid path, so auth would silently fail with a 401
    even for a validly signed-in user. (Vercel runs each api/*.py as an
    isolated function, so the helper is duplicated rather than imported.)
    """
    raw = (raw or "").strip()
    if not raw:
        return ""
    parts = urlsplit(raw)
    if parts.scheme and parts.netloc:
        return f"{parts.scheme}://{parts.netloc}"
    # No scheme parsed (e.g. "abc.supabase.co/"); strip path manually.
    return raw.split("/", 1)[0]


DEFAULT_MODEL = "claude-sonnet-4-6"
DEFAULT_MAX_TOKENS = 4096
THINKING_BUDGET = 4096
AUTH_TIMEOUT_SECONDS = 5


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_POST(self):
        # ---- Auth gate ----
        user_id = self._verify_auth()
        if not user_id:
            return self._json_error(401, "Authentication required. Please sign in.")

        try:
            length = int(self.headers.get("Content-Length", "0"))
            data = json.loads(self.rfile.read(length) or b"{}")
        except Exception as e:
            return self._json_error(400, f"Invalid JSON body: {e}")

        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            return self._json_error(
                500,
                "ANTHROPIC_API_KEY is not set. Add it in Vercel → Settings → "
                "Environment Variables, then redeploy.",
            )

        model = data.get("model") or DEFAULT_MODEL
        thinking_on = bool(data.get("thinking"))
        # Opus 4.7+ uses adaptive thinking. It rejects the old extended-thinking
        # shape AND rejects temperature/top_p/top_k entirely. Older models use
        # the classic extended-thinking budget. Picking the right shape per model
        # is the difference between a clean response and a 400 invalid_request.
        uses_adaptive_thinking = model in {"claude-opus-4-7"}

        max_tokens = int(data.get("maxTokens") or DEFAULT_MAX_TOKENS)
        # Extended thinking needs max_tokens > budget. Adaptive has no budget,
        # so this bump only applies to the older models.
        if thinking_on and not uses_adaptive_thinking:
            max_tokens = max(max_tokens, THINKING_BUDGET + 4096)

        kwargs = {
            "model": model,
            "max_tokens": max_tokens,
            "messages": data.get("messages") or [],
        }
        system = data.get("system")
        if system:
            kwargs["system"] = [{
                "type": "text",
                "text": system,
                "cache_control": {"type": "ephemeral"},
            }]
        if data.get("useWebSearch"):
            kwargs["tools"] = [{
                "type": "web_search_20250305",
                "name": "web_search",
                "max_uses": 5,
            }]
        if thinking_on:
            if uses_adaptive_thinking:
                kwargs["thinking"] = {"type": "adaptive"}
            else:
                kwargs["thinking"] = {"type": "enabled", "budget_tokens": THINKING_BUDGET}

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self._cors()
        self.end_headers()

        try:
            client = anthropic.Anthropic(api_key=api_key)
            with client.messages.stream(**kwargs) as stream:
                for event in stream:
                    self._handle_event(event)
                final = stream.get_final_message()
                self._sse({
                    "type": "done",
                    "stop_reason": final.stop_reason,
                    "usage": {
                        "input_tokens": final.usage.input_tokens,
                        "output_tokens": final.usage.output_tokens,
                        "cache_creation_input_tokens": getattr(final.usage, "cache_creation_input_tokens", 0) or 0,
                        "cache_read_input_tokens": getattr(final.usage, "cache_read_input_tokens", 0) or 0,
                    },
                })
        except anthropic.APIStatusError as e:
            self._sse({"type": "error", "error": f"{e.status_code}: {e.message}"})
        except Exception as e:
            self._sse({"type": "error", "error": str(e)})

    # ---- Helpers ----

    def _verify_auth(self):
        """
        Verify the Supabase access token by asking Supabase about it.

        Calls GET /auth/v1/user with the user's token + the project's anon
        key. Supabase returns the user if the token is valid, 401 if not.
        """
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return None
        token = auth[len("Bearer "):].strip()
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
                body = json.loads(resp.read().decode())
                return body.get("id")
        except urllib.error.HTTPError:
            return None
        except Exception:
            return None

    def _handle_event(self, event):
        t = getattr(event, "type", None)
        if t == "content_block_start":
            block = event.content_block
            block_type = getattr(block, "type", None)
            if block_type == "server_tool_use":
                query = ""
                if isinstance(getattr(block, "input", None), dict):
                    query = block.input.get("query", "")
                self._sse({"type": "tool_use", "name": block.name, "query": query})
        elif t == "content_block_delta":
            delta = event.delta
            delta_type = getattr(delta, "type", None)
            if delta_type == "text_delta":
                self._sse({"type": "text", "text": delta.text})
            elif delta_type == "thinking_delta":
                self._sse({"type": "thinking", "text": delta.thinking})

    def _sse(self, payload):
        try:
            self.wfile.write(f"data: {json.dumps(payload)}\n\n".encode())
            self.wfile.flush()
        except Exception:
            pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def _json_error(self, code, message):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.end_headers()
        self.wfile.write(json.dumps({"error": message}).encode())
