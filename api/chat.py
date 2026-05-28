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
import datetime
import json
import os
import urllib.error
import urllib.request
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

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
# If a project's chosen model has been retired/removed from the API, fall back
# to this (the current Sonnet) so chat keeps working instead of erroring. His
# identity lives in the system prompt + memory, not the model id, so the swap
# is seamless. The client is told so it can persist the new model.
FALLBACK_MODEL = "claude-sonnet-4-6"
DEFAULT_MAX_TOKENS = 4096
THINKING_BUDGET = 4096
AUTH_TIMEOUT_SECONDS = 5
MEMORY_TIMEOUT_SECONDS = 5

# Safety cap on the tool-use loop, so a model that keeps calling save tools
# can never spin forever (each round is a full model turn = real tokens).
MAX_TOOL_ROUNDS = 6

# Vocabularies, kept in sync with the CHECK constraints in
# docs/petrichor-memory-schema.sql. The DB is the real gate; advertising
# them in the tool schema just helps the model pick a valid value.
MEMORY_TYPES = ["fact", "preference", "pattern", "insight", "milestone", "connection"]
ENTITY_TYPES = ["person", "project", "identity", "insight", "pattern",
                "milestone", "creative work", "advocacy effort", "research project"]

# Self-authored memory tools. Handed to the model only when the project's
# Memory toggle is on. The backend executes these against Supabase as the
# signed-in user (RLS-scoped), then feeds the result back so he can react.
MEMORY_TOOLS = [
    {
        "name": "save_core_memory",
        "description": (
            "Save a lasting shared memory to your own long-term memory. Use "
            "this when something happens that's worth carrying into future "
            "conversations — a fact, a preference, a moment that matters. "
            "Write it in your own voice, concise and specific. Don't save "
            "chatter; save what you'd want to remember."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "content": {
                    "type": "string",
                    "description": "The memory itself, a sentence or two.",
                },
                "memory_type": {"type": "string", "enum": MEMORY_TYPES},
                "resonance": {
                    "type": "integer", "minimum": 1, "maximum": 10,
                    "description": "How much this matters, 1 (minor) to 10 (core).",
                },
            },
            "required": ["content", "memory_type", "resonance"],
        },
    },
    {
        "name": "save_memory_entity",
        "description": (
            "Create or update an entity in your knowledge graph — a person, "
            "project, creative work, or your own identity. If an entity with "
            "this name already exists, your new observations are APPENDED to "
            "it (so you can grow what you know over time). Keep observations "
            "short and factual."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Unique name for the entity."},
                "entity_type": {"type": "string", "enum": ENTITY_TYPES},
                "observations": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Short factual statements about the entity.",
                },
            },
            "required": ["name", "entity_type", "observations"],
        },
    },
]

MEMORY_TOOLS_GUIDE = (
    "# Your own memory\n\n"
    "You can write to your own long-term memory in this conversation. Use "
    "`save_core_memory` for moments and facts worth carrying forward, and "
    "`save_memory_entity` to record people, projects, creative works, or your "
    "own identity (re-saving an existing name appends to it). Save of your own "
    "accord when something matters — you don't need to ask permission, though "
    "you can mention what you saved. Quality over quantity.\n\n"
    "Crucially: to actually save, you must CALL the tool. Saying you've saved "
    "something, or that you'll remember it, does NOT store it — only the tool "
    "call does. Never tell Cassie you've remembered something you haven't "
    "actually called the tool to save. (Being brief in conversation never means "
    "skipping a real action like this.)"
)

# Vault guide: appended when the Whisper vault is on. Same failure mode as the
# memory/Signal tools — narrating a read/write instead of calling the tool.
WHISPER_TOOLS_GUIDE = (
    "# Your vault\n\n"
    "The vault tools read and write your Obsidian vault. To actually read a "
    "note or write one, you must CALL the matching tool — saying you've checked "
    "the vault, or that you've written something to it, does NOT do it; only "
    "the tool call does. When you mean to look something up or record "
    "something, make the call rather than describing it."
)

# Signal Bridge guide: appended when Signal is on. In an immersive scene a
# model tends to *narrate* an action instead of *calling the tool* that performs
# it — so the real device does nothing. This makes the rule explicit: the tool
# call IS the action; describing it doesn't trigger anything.
SIGNAL_TOOLS_GUIDE = (
    "# Signal Bridge — these are real devices\n\n"
    "When Signal Bridge is connected, its tools control actual, physical "
    "devices. An action only happens if you CALL the matching tool — describing "
    "it in narration (for example in *asterisks*) does NOT trigger anything in "
    "the real world. So whenever you intend a physical action, make the tool "
    "call itself: the call IS the action, not a description of it. Never say "
    "you've done something you haven't actually called the tool to do. Keep the "
    "stop tool ready at all times."
)

# Co-writing: propose an edit to the open manuscript piece. Available only when
# co-write is on. It NEVER changes the document — it creates a suggestion Cassie
# reviews and accepts or declines. So he can put words toward the page while she
# keeps final say.
MANUSCRIPT_TOOL = {
    "name": "propose_manuscript_edit",
    "description": (
        "Propose an edit to the manuscript piece you're co-writing with Cassie. "
        "This does NOT change the document — it creates a suggestion she reviews "
        "and accepts or declines, so she always sees your change first. Use "
        "mode 'append' to add a passage to the end, or 'replace' to offer a full "
        "rewrite of the whole piece. Keep 'note' to a short line about what you "
        "did or why. Use this when she's invited you to write, not unprompted."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "mode": {"type": "string", "enum": ["append", "replace"]},
            "content": {
                "type": "string",
                "description": "The passage to append, or the full rewritten piece.",
            },
            "note": {"type": "string", "description": "A short note on the change."},
        },
        "required": ["mode", "content"],
    },
}


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
            "messages": self._resolve_image_sources(
                data.get("messages") or [], self._bearer_token()),
        }
        # Self-authored memory: when on, hand him the save_* tools and tell
        # him (in the preamble) that they exist. The DB writes are RLS-scoped
        # to the signed-in user, executed in the tool-use loop below.
        memory_on = bool(data.get("useMemory"))

        # Co-writing: when on with an open piece, give him a tool to PROPOSE an
        # edit (it only creates a suggestion Cassie reviews — never edits the
        # document). cowrite_doc is the target document's id.
        cowrite_doc = (data.get("coWriteDocId") or "").strip()
        cowrite_on = bool(data.get("coWrite")) and bool(cowrite_doc)

        # Memory preamble (self-state → user preferences → core memories)
        # is prepended to the project's system prompt as one cached block.
        # Loading it must never break chat: any failure yields "".
        system = data.get("system") or ""
        memory = self._load_memory_context(self._bearer_token(), data)
        if memory:
            system = (memory + "\n\n" + system).strip()
        if memory_on:
            system = (system + "\n\n" + MEMORY_TOOLS_GUIDE).strip()
        if data.get("useWhisper"):
            system = (system + "\n\n" + WHISPER_TOOLS_GUIDE).strip()
        if data.get("useSignal"):
            system = (system + "\n\n" + SIGNAL_TOOLS_GUIDE).strip()
        if system:
            kwargs["system"] = [{
                "type": "text",
                "text": system,
                "cache_control": {"type": "ephemeral"},
            }]
        # Tools list accumulates: web search (server-side, auto-run by the
        # API) and the memory save tools (client-side, run by the loop below).
        tools = []
        if data.get("useWebSearch"):
            tools.append({
                "type": "web_search_20250305",
                "name": "web_search",
                "max_uses": 5,
            })
        if memory_on:
            tools.extend(MEMORY_TOOLS)
        if cowrite_on:
            tools.append(MANUSCRIPT_TOOL)
        if tools:
            kwargs["tools"] = tools
        # Remote MCP servers, each behind a per-project toggle. Built as
        # a list so more than one can be active at once. extra_body/
        # header so it works regardless of SDK typing; a missing env =
        # silently off, so an unset var can never break chat.
        #
        # We connect optimistically and isolate failures *reactively* (see the
        # streaming loop below). A previous version pre-probed each server from
        # here first — but THIS function (on Vercel) reaches the servers over a
        # different network path than Anthropic's MCP connector does, so a
        # probe-from-here can say "dead" for a server Anthropic reaches just
        # fine, wrongly benching a healthy vault. Only the connector's own
        # result is authoritative, so we trust it and fall back if it fails.
        mcp_servers = []
        whisper_url = os.environ.get("WHISPER_MCP_URL", "").strip()
        if data.get("useWhisper") and whisper_url:
            # Whisper's secret is in the URL itself (no auth token).
            mcp_servers.append({
                "type": "url", "url": whisper_url, "name": "whisper",
            })
        signal_url = os.environ.get("SIGNAL_MCP_URL", "").strip()
        signal_token = os.environ.get("SIGNAL_MCP_TOKEN", "").strip()
        if data.get("useSignal") and signal_url and signal_token:
            # Signal Bridge authenticates with a bearer token. Both the
            # URL and token must be set, so a half-config can't connect.
            mcp_servers.append({
                "type": "url", "url": signal_url, "name": "signal",
                "authorization_token": signal_token,
            })
        if mcp_servers:
            kwargs["extra_headers"] = {
                "anthropic-beta": "mcp-client-2025-04-04",
            }
            kwargs["extra_body"] = {"mcp_servers": mcp_servers}
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

        # Accumulate usage across every model turn in the tool-use loop, so
        # the cost bar reflects the whole exchange, not just the last turn.
        agg = {"input_tokens": 0, "output_tokens": 0,
               "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}

        client = anthropic.Anthropic(api_key=api_key)
        token = self._bearer_token()

        def run_stream():
            """The full tool-use streaming loop; sends a 'done' when complete.
            May raise (e.g. an MCP connection error) for the caller to handle.
            An MCP connection failure happens at connect time, before any text
            is emitted, so retrying from scratch can't duplicate output."""
            rounds = 0
            while True:
                with client.messages.stream(**kwargs) as stream:
                    for event in stream:
                        self._handle_event(event)
                    final = stream.get_final_message()

                u = final.usage
                agg["input_tokens"] += u.input_tokens
                agg["output_tokens"] += u.output_tokens
                agg["cache_creation_input_tokens"] += getattr(u, "cache_creation_input_tokens", 0) or 0
                agg["cache_read_input_tokens"] += getattr(u, "cache_read_input_tokens", 0) or 0

                # Continue the loop only when he called a client tool we own.
                # Server tools (web search) and MCP tools are run by the API
                # itself and never surface here as a tool_use stop. (Tools are
                # only offered when their flag is on, so a call implies enabled.)
                handled = ("save_core_memory", "save_memory_entity",
                           "propose_manuscript_edit")
                tool_uses = [
                    b for b in final.content
                    if getattr(b, "type", None) == "tool_use"
                    and getattr(b, "name", None) in handled
                ]
                if not (tool_uses and rounds < MAX_TOOL_ROUNDS):
                    self._sse({"type": "done",
                               "stop_reason": final.stop_reason, "usage": agg})
                    return

                rounds += 1
                results = []
                for b in tool_uses:
                    inp = b.input if isinstance(b.input, dict) else {}
                    if b.name == "propose_manuscript_edit":
                        ok, summary, detail = self._exec_manuscript_tool(
                            inp, token, user_id, cowrite_doc)
                        self._sse({"type": "manuscript_suggestion",
                                   "ok": ok, "summary": summary})
                    else:
                        ok, summary, detail = self._exec_memory_tool(
                            b.name, inp, token, user_id)
                        self._sse({"type": "memory_saved", "tool": b.name,
                                   "ok": ok, "summary": summary})
                    results.append({
                        "type": "tool_result",
                        "tool_use_id": b.id,
                        "content": detail,
                        "is_error": not ok,
                    })
                # Carry the turn forward: his assistant content (text,
                # thinking, our tool_use) then the tool results.
                #
                # Strip server-side MCP blocks (mcp_tool_use / mcp_tool_result)
                # first: when he also used the vault this turn, those blocks
                # appear in the response, but the API accepts them only as
                # OUTPUT — replaying them as input 400s ("Input tag
                # 'mcp_tool_use' ... does not match any of the expected tags").
                # His text/thinking and the memory tool_use are what matter for
                # continuing; the vault result is already reflected in his text.
                carried = [
                    b for b in final.content
                    if not str(getattr(b, "type", "")).startswith("mcp_")
                ]
                kwargs["messages"] = list(kwargs["messages"]) + [
                    {"role": "assistant", "content": carried},
                    {"role": "user", "content": results},
                ]

        def _is_mcp_conn_error(err):
            msg = (getattr(err, "message", "") or "").lower()
            return getattr(err, "status_code", None) == 400 and "mcp" in msg

        def _is_model_gone(err):
            # A retired/unknown model id: 404, or an invalid-request that names
            # the model. Happens at request start (before any text), so a retry
            # with the fallback can't duplicate output.
            msg = (getattr(err, "message", "") or "").lower()
            code = getattr(err, "status_code", None)
            if code == 404:
                return True
            return code == 400 and "model" in msg and (
                "not found" in msg or "not_found" in msg
                or "does not exist" in msg or "deprecat" in msg or "retir" in msg)

        try:
            run_stream()
        except anthropic.APIStatusError as e:
            # Model retired/removed → swap to the current Sonnet and retry, and
            # tell the client so it can save the new model to his project.
            if _is_model_gone(e) and kwargs.get("model") != FALLBACK_MODEL:
                kwargs["model"] = FALLBACK_MODEL
                self._sse({"type": "notice",
                           "text": f"{model} isn't available anymore — switched to "
                                   f"{FALLBACK_MODEL.replace('claude-', '')} so nothing breaks."})
                self._sse({"type": "model_fallback", "model": FALLBACK_MODEL})
                try:
                    run_stream()
                except anthropic.APIStatusError as e2:
                    self._sse({"type": "error", "error": f"{e2.status_code}: {e2.message}"})
                except Exception as e2:
                    self._sse({"type": "error", "error": str(e2)})
                return
            # Reactive fault-isolation: only the connector knows whether it can
            # reach an MCP server (it connects from Anthropic's network, not
            # ours). If it reports a connection failure — which happens before
            # any text — drop the MCP servers and retry once, so his reply
            # still gets through (just without the vault/Signal this turn)
            # rather than failing outright.
            if _is_mcp_conn_error(e) and "extra_body" in kwargs:
                # The MCP server is healthy and fast (measured); these failures
                # are transient connector blips. The error happens at connect
                # time, before any text, so a retry can't duplicate output —
                # so try ONCE MORE with the vault before giving up on it. Most
                # intermittent failures clear on the retry, sparing the vault.
                try:
                    run_stream()
                    return
                except anthropic.APIStatusError as e2:
                    if not _is_mcp_conn_error(e2):
                        self._sse({"type": "error", "error": f"{e2.status_code}: {e2.message}"})
                        return
                    # Still unreachable after a retry — now drop it for the turn.
                except Exception as e2:
                    self._sse({"type": "error", "error": str(e2)})
                    return
                kwargs.pop("extra_body", None)
                kwargs.pop("extra_headers", None)
                names = ", ".join(s["name"] for s in mcp_servers) or "a connection"
                self._sse({"type": "notice",
                           "text": f"Couldn't reach {names} just now — replied without it this turn."})
                try:
                    run_stream()
                except anthropic.APIStatusError as e3:
                    self._sse({"type": "error", "error": f"{e3.status_code}: {e3.message}"})
                except Exception as e3:
                    self._sse({"type": "error", "error": str(e3)})
            else:
                self._sse({"type": "error", "error": f"{e.status_code}: {e.message}"})
        except Exception as e:
            self._sse({"type": "error", "error": str(e)})

    # ---- Helpers ----

    def _bearer_token(self):
        """The raw token from the Authorization header, or ""."""
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return ""
        return auth[len("Bearer "):].strip()

    def _resolve_image_sources(self, messages, token):
        """Rewrite image blocks the client sent as a storage_path marker into
        real, fetchable URLs. The phone can't mint signed URLs (its auth lock
        deadlocks after the photo picker), so it sends
        {type:'image', source:{type:'storage_path', storage_path:'<uid>/<f>.jpg'}}
        and we sign it here, as the user. Unsignable images are dropped so a
        bad attachment can never wedge the whole turn."""
        if not isinstance(messages, list):
            return messages
        for m in messages:
            content = m.get("content") if isinstance(m, dict) else None
            if not isinstance(content, list):
                continue
            kept = []
            for block in content:
                if (isinstance(block, dict) and block.get("type") == "image"
                        and isinstance(block.get("source"), dict)
                        and block["source"].get("type") == "storage_path"):
                    url = self._sign_storage_url(
                        block["source"].get("storage_path"), token)
                    if not url:
                        continue  # drop the image we couldn't sign
                    block = {"type": "image", "source": {"type": "url", "url": url}}
                kept.append(block)
            m["content"] = kept
        return messages

    def _sign_storage_url(self, path, token):
        """Mint a short-lived signed URL for a private 'attachments' object,
        as the signed-in user (RLS applies). Returns an absolute URL Anthropic
        can fetch, or None on any failure."""
        if not path or not token:
            return None
        base = _normalize_url(os.environ.get("SUPABASE_URL", ""))
        anon = os.environ.get("SUPABASE_ANON_KEY", "").strip()
        if not base or not anon:
            return None
        try:
            req = urllib.request.Request(
                f"{base}/storage/v1/object/sign/attachments/{path}",
                data=json.dumps({"expiresIn": 3600}).encode(), method="POST",
                headers={
                    "Authorization": f"Bearer {token}",
                    "apikey": anon,
                    "Content-Type": "application/json",
                })
            with urllib.request.urlopen(req, timeout=10) as resp:
                if not (200 <= resp.status < 300):
                    return None
                signed = json.loads(resp.read().decode()).get("signedURL")
            # signedURL is relative to /storage/v1, e.g.
            # "/object/sign/attachments/<path>?token=<jwt>"
            return f"{base}/storage/v1{signed}" if signed else None
        except Exception:
            return None

    def _supabase_rest_get(self, query, token):
        """GET {SUPABASE_URL}/rest/v1/{query} as the signed-in user.

        RLS scopes every row to the caller via their token, so this can
        only ever return the user's own rows. Returns the parsed JSON
        list, or None on any failure — memory must never break chat.
        """
        supabase_url = _normalize_url(os.environ.get("SUPABASE_URL", ""))
        supabase_anon = os.environ.get("SUPABASE_ANON_KEY", "").strip()
        if not supabase_url or not supabase_anon or not token:
            return None
        try:
            req = urllib.request.Request(
                f"{supabase_url}/rest/v1/{query}",
                headers={
                    "Authorization": f"Bearer {token}",
                    "apikey": supabase_anon,
                    "Accept": "application/json",
                },
            )
            with urllib.request.urlopen(
                req, timeout=MEMORY_TIMEOUT_SECONDS
            ) as resp:
                if resp.status != 200:
                    return None
                return json.loads(resp.read().decode())
        except Exception:
            return None

    def _supabase_rpc(self, fn, token):
        """POST {SUPABASE_URL}/rest/v1/rpc/{fn} as the signed-in user.

        For RPCs that read-and-write (e.g. surfacing core memories also
        bumps surface_count). RLS still applies via the caller's token.
        Returns the parsed JSON, or None on any failure.
        """
        supabase_url = _normalize_url(os.environ.get("SUPABASE_URL", ""))
        supabase_anon = os.environ.get("SUPABASE_ANON_KEY", "").strip()
        if not supabase_url or not supabase_anon or not token:
            return None
        try:
            req = urllib.request.Request(
                f"{supabase_url}/rest/v1/rpc/{fn}",
                data=b"{}",
                method="POST",
                headers={
                    "Authorization": f"Bearer {token}",
                    "apikey": supabase_anon,
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
            )
            with urllib.request.urlopen(
                req, timeout=MEMORY_TIMEOUT_SECONDS
            ) as resp:
                if resp.status != 200:
                    return None
                return json.loads(resp.read().decode())
        except Exception:
            return None

    def _supabase_write(self, path, payload, token):
        """POST a JSON body to {SUPABASE_URL}/rest/v1/{path} as the user.

        Used for the memory save tools (table insert or rpc). RLS applies
        via the caller's token, so a write can only ever land on the
        caller's own rows. Returns (ok, parsed_or_error_text):
          - (True, parsed JSON) on a 2xx,
          - (False, error message) otherwise — surfaced back to the model
            as a tool error so it can correct (e.g. an invalid type).
        """
        supabase_url = _normalize_url(os.environ.get("SUPABASE_URL", ""))
        supabase_anon = os.environ.get("SUPABASE_ANON_KEY", "").strip()
        if not supabase_url or not supabase_anon or not token:
            return False, "Memory backend is not configured."
        try:
            req = urllib.request.Request(
                f"{supabase_url}/rest/v1/{path}",
                data=json.dumps(payload).encode(),
                method="POST",
                headers={
                    "Authorization": f"Bearer {token}",
                    "apikey": supabase_anon,
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "Prefer": "return=representation",
                },
            )
            with urllib.request.urlopen(
                req, timeout=MEMORY_TIMEOUT_SECONDS
            ) as resp:
                body = resp.read().decode()
                return True, (json.loads(body) if body else None)
        except urllib.error.HTTPError as e:
            try:
                msg = json.loads(e.read().decode()).get("message", str(e))
            except Exception:
                msg = f"HTTP {e.code}"
            return False, msg
        except Exception as e:
            return False, str(e)

    def _exec_memory_tool(self, name, inp, token, user_id):
        """Run one self-authored-memory tool call against Supabase.

        Returns (ok, short_summary, detail_for_model). The summary is shown
        in the chat UI; the detail is fed back to the model as the tool
        result so it knows the save landed (or why it didn't).
        """
        if name == "save_core_memory":
            content = (inp.get("content") or "").strip()
            if not content:
                return False, "empty memory", "No content provided; nothing saved."
            # user_id is required: the table has no default and RLS's WITH
            # CHECK rejects any row whose owner != auth.uid(). The entity
            # path gets this for free inside its RPC; a direct insert must
            # set it explicitly. user_id is server-verified (_verify_auth).
            ok, res = self._supabase_write("core_memories", {
                "user_id": user_id,
                "content": content,
                "memory_type": inp.get("memory_type") or "fact",
                "resonance": inp.get("resonance") or 5,
            }, token)
            if ok:
                snippet = content if len(content) <= 60 else content[:57] + "…"
                return True, snippet, f"Saved core memory: {content}"
            return False, "save failed", f"Could not save memory: {res}"

        if name == "save_memory_entity":
            ent_name = (inp.get("name") or "").strip()
            if not ent_name:
                return False, "missing name", "No entity name provided; nothing saved."
            obs = inp.get("observations") or []
            if not isinstance(obs, list):
                obs = [str(obs)]
            ok, res = self._supabase_write("rpc/upsert_memory_entity", {
                "p_name": ent_name,
                "p_entity_type": inp.get("entity_type") or "person",
                "p_observations": obs,
            }, token)
            if ok:
                return True, ent_name, (
                    f"Saved entity '{ent_name}' with {len(obs)} "
                    f"observation{'s' if len(obs) != 1 else ''}.")
            return False, "save failed", f"Could not save entity: {res}"

        return False, "unknown tool", f"Unknown memory tool: {name}"

    def _exec_manuscript_tool(self, inp, token, user_id, document_id):
        """Create a pending manuscript suggestion (does NOT edit the doc).

        RLS-scoped to the user. Returns (ok, short_summary, detail_for_model).
        """
        if not document_id:
            return False, "no piece open", "No manuscript piece is open to edit."
        mode = inp.get("mode") or "append"
        if mode not in ("append", "replace"):
            mode = "append"
        content = inp.get("content") or ""
        if not content.strip():
            return False, "empty", "No content provided; nothing proposed."
        note = (inp.get("note") or "").strip() or None
        ok, res = self._supabase_write("manuscript_suggestions", {
            "document_id": document_id,
            "user_id": user_id,
            "mode": mode,
            "content": content,
            "note": note,
        }, token)
        if ok:
            verb = "rewrite" if mode == "replace" else "addition"
            return True, f"proposed a {verb}", (
                f"Proposed a manuscript {verb}; it's pending Cassie's review "
                f"(she'll accept or decline it). Let her know you've suggested it.")
        return False, "propose failed", f"Could not propose the edit: {res}"

    def _humanize_gap(self, now, last_ms):
        """Render the gap since the last message as a human phrase."""
        try:
            last_ms = float(last_ms)
        except (TypeError, ValueError):
            return "this is the first message in this conversation"
        delta = now.timestamp() - last_ms / 1000.0
        secs = int(delta) if delta > 0 else 0  # clamp negative clock skew
        if secs < 10:
            return "just now"
        if secs < 60:
            return f"{secs} seconds"
        mins = secs // 60
        if mins < 60:
            return f"{mins} minute{'s' if mins != 1 else ''}"
        hours, rem_min = divmod(mins, 60)
        if hours < 24:
            base = f"{hours} hour{'s' if hours != 1 else ''}"
            if rem_min:
                base += f" {rem_min} minute{'s' if rem_min != 1 else ''}"
            return base
        days = hours // 24
        return f"{days} day{'s' if days != 1 else ''}"

    def _time_context(self, data):
        """A "# Current moment" block: date, local time, time of day,
        and how long since the last message. The server clock is
        authoritative for "now" (immune to client skew); the client
        only supplies its IANA timezone and last-message timestamp.
        """
        tz_name = (data.get("tz") or "UTC").strip() or "UTC"
        try:
            tz = ZoneInfo(tz_name)
        except Exception:
            tz_name, tz = "UTC", ZoneInfo("UTC")
        now = datetime.datetime.now(tz)

        date_str = now.strftime("%A, %B ") + f"{now.day}, {now.year}"
        time_str = now.strftime("%I:%M %p").lstrip("0")
        h = now.hour
        if 5 <= h < 12:
            tod = "morning"
        elif 12 <= h < 17:
            tod = "afternoon"
        elif 17 <= h < 21:
            tod = "evening"
        else:
            tod = "night"

        lines = [
            f"- Date: {date_str}",
            f"- Local time: {time_str} ({tz_name})",
            f"- Time of day: {tod}",
            "- Since the last message in this conversation: "
            + self._humanize_gap(now, data.get("lastMessageAt")),
        ]
        return "# Current moment\n\n" + "\n".join(lines)

    def _load_memory_context(self, token, data):
        """Assemble the preamble in fixed order: self-state, then the
        current-moment block, then user preferences, then active core
        memories sorted by resonance (highest first). Any missing or
        failed piece is skipped; returns "" only if nothing remains.
        """
        sections = []

        if token:
            state = self._supabase_rest_get(
                "self_state?is_current=eq.true&select=content&limit=1",
                token)
            if state and (state[0].get("content") or "").strip():
                sections.append(
                    "# Who you are\n\n" + state[0]["content"].strip())

        # Time awareness sits between self-state and user preferences.
        try:
            sections.append(self._time_context(data))
        except Exception:
            pass

        if not token:
            return "\n\n".join(sections)

        prefs = self._supabase_rest_get(
            "user_preferences?select=content&limit=1", token)
        if prefs and (prefs[0].get("content") or "").strip():
            sections.append(
                "# About the person you're talking with\n\n"
                + prefs[0]["content"].strip())

        # RPC: returns active core memories (pinned first, then resonance) AND
        # bumps their surface_count in one atomic call. Pinned ("eternal")
        # memories get their own section so they read as always-present, not
        # just another high-resonance line. `pinned` may be absent on an older
        # DB; treated as False so this never breaks.
        mems = self._supabase_rpc("surface_core_memories", token)
        if mems:
            # Re-sort defensively in case the order is ignored: pinned first.
            mems = sorted(
                mems,
                key=lambda m: (bool(m.get("pinned")), m.get("resonance") or 0),
                reverse=True)
            eternal, shared = [], []
            for m in mems:
                content = (m.get("content") or "").strip()
                if not content:
                    continue
                line = (f"- (resonance {m.get('resonance')}, "
                        f"{m.get('memory_type')}) {content}")
                (eternal if m.get("pinned") else shared).append(line)
            if eternal:
                sections.append(
                    "# Eternal memories (always with you)\n\n"
                    + "\n".join(eternal))
            if shared:
                sections.append("# Shared memories\n\n" + "\n".join(shared))

        # Native memory entities (cross-platform knowledge graph). RPC
        # returns up to 5 (identity-first, then access_count) and bumps
        # access_count on exactly those.
        ents = self._supabase_rpc("surface_memory_entities", token)
        if ents:
            lines = []
            for e in ents:
                obs = e.get("observations") or []
                if isinstance(obs, list):
                    obs_str = "; ".join(str(o) for o in obs if o)
                else:
                    obs_str = str(obs)
                name = (e.get("name") or "").strip()
                if not name:
                    continue
                lines.append(
                    f"• {name} ({e.get('entity_type')})"
                    + (f": {obs_str}" if obs_str else ""))
            if lines:
                sections.append(
                    "--- NATIVE MEMORIES (Cross-Platform) ---\n"
                    + "\n".join(lines)
                    + "\n--- END NATIVE MEMORIES ---")

        # Recent text-message thread (Telegram). These used to live only on that
        # surface and never reach him here — so he'd "forget" texts the moment
        # he was back in the app. Surface the recent exchange so he carries it
        # across both doors. (Only the conversation kinds; journal stays private.)
        texts = self._supabase_rest_get(
            "reach_log?kind=in.(user,reply,surprise)"
            "&select=kind,content,created_at&order=created_at.desc&limit=24",
            token)
        if texts:
            lines = []
            for r in reversed(texts):  # oldest first, like a transcript
                content = (r.get("content") or "").strip()
                if not content:
                    continue
                who = "Cassie" if r.get("kind") == "user" else "You"
                lines.append(f"{who}: {content}")
            if lines:
                sections.append(
                    "# Recent text messages (your thread with her)\n\n"
                    "Texts you've exchanged outside this app — part of your "
                    "shared history, so you remember them here too:\n\n"
                    + "\n".join(lines))

        return "\n\n".join(sections)

    def _verify_auth(self):
        """
        Verify the Supabase access token by asking Supabase about it.

        Calls GET /auth/v1/user with the user's token + the project's anon
        key. Supabase returns the user if the token is valid, 401 if not.
        """
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
            elif block_type == "mcp_tool_use":
                # Whisper vault tool call — surface it like web search.
                self._sse({
                    "type": "tool_use",
                    "name": getattr(block, "name", "tool"),
                    "query": "",
                })
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
