"""
Image upload proxy — with chunked uploads for phones that stall on larger
request bodies.

Some clients (notably a phone whose network stalls on any upload past a
certain size, while small requests work fine) can't push an image in one POST
— to Storage or even to this server. So the browser may split the image into
small base64 chunks and send them one at a time; this endpoint stashes each
chunk in Storage and, on a final "finalize" call, reassembles them into the
real image. Small single uploads still work in one shot.

Everything is done AS THE SIGNED-IN USER (their bearer token is forwarded to
Storage), so the per-user RLS on the 'attachments' bucket still applies — a
user can only read/write/delete under their own {uid}/ folder.

Required env: SUPABASE_URL, SUPABASE_ANON_KEY
"""

from http.server import BaseHTTPRequestHandler
import base64
import binascii
import json
import os
import uuid
import urllib.error
import urllib.request
from urllib.parse import urlsplit

MAX_BYTES = 12 * 1024 * 1024
MAX_CHUNKS = 400
DIAG_UID = (os.environ.get("REACH_USER_ID", "").strip()
            or "11e2fa54-8d74-41ee-b7bc-b5ec8b52ba19")  # log owner for diagnostics
AUTH_TIMEOUT_SECONDS = 5
STORAGE_TIMEOUT_SECONDS = 30
BUCKET = "attachments"


def _normalize_url(raw):
    raw = (raw or "").strip()
    if not raw:
        return ""
    parts = urlsplit(raw)
    if parts.scheme and parts.netloc:
        return f"{parts.scheme}://{parts.netloc}"
    return raw.split("/", 1)[0]


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_POST(self):
        # Pre-auth marker: logs the instant ANY request touches this endpoint,
        # before auth can reject it — so an empty log means "never arrived"
        # vs. "arrived but auth failed". Uses the known user id as the log owner.
        self._diag(DIAG_UID, "hit /api/upload (pre-auth)")
        user_id = self._verify_auth()
        if not user_id:
            self._diag(DIAG_UID, "auth FAILED -> 401")
            return self._json_error(401, "Authentication required. Please sign in.")

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BYTES:
            return self._json_error(400, "Empty or oversized request.")
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception as e:
            return self._json_error(400, f"Invalid JSON body: {e}")

        token = self._bearer_token()
        mode = ("finalize" if payload.get("finalize")
                else "chunk" if "index" in payload else "single")
        self._diag(user_id, f"POST arrived ({length}b, mode={mode})")
        try:
            if payload.get("finalize"):
                return self._finalize(payload, user_id, token)
            if "index" in payload:
                return self._store_chunk(payload, user_id, token)
            return self._store_single(payload, user_id, token)
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode()[:200]
            except Exception:
                detail = str(e)
            self._diag(user_id, f"HTTPError from storage: {detail[:120]}")
            return self._json_error(502, f"Storage error: {detail}")
        except Exception as e:
            self._diag(user_id, f"exception: {e}")
            return self._json_error(502, f"Upload failed: {e}")

    # ---- upload modes ----

    def _store_single(self, payload, user_id, token):
        body = self._decode_b64(payload.get("data"))
        if not body:
            self._diag(user_id, "single: empty after decode")
            return self._json_error(400, "Empty image.")
        path = f"{user_id}/{uuid.uuid4().hex}.jpg"
        self._diag(user_id, f"single: decoded {len(body)}b, calling storage…")
        self._storage_put(path, body, "image/jpeg", token)
        self._diag(user_id, "single: storage PUT returned OK")
        return self._ok({"storage_path": path})

    def _store_chunk(self, payload, user_id, token):
        session = self._safe_token(payload.get("session"))
        index = payload.get("index")
        chunk = payload.get("chunk")
        if not session or not isinstance(index, int) or chunk is None:
            return self._json_error(400, "Malformed chunk.")
        # Store the base64 text piece as-is; finalize concatenates then decodes.
        path = f"{user_id}/tmp/{session}/{index}"
        self._storage_put(path, chunk.encode(), "text/plain", token)
        return self._ok({"ok": True})

    def _finalize(self, payload, user_id, token):
        session = self._safe_token(payload.get("session"))
        total = payload.get("total")
        if not session or not isinstance(total, int) or not (0 < total <= MAX_CHUNKS):
            return self._json_error(400, "Malformed finalize.")
        parts = []
        for i in range(total):
            parts.append(self._storage_get(f"{user_id}/tmp/{session}/{i}", token).decode())
        body = self._decode_b64("".join(parts))
        if not body:
            return self._json_error(400, "Reassembled image was empty.")
        path = f"{user_id}/{uuid.uuid4().hex}.jpg"
        self._storage_put(path, body, "image/jpeg", token)
        # Best-effort cleanup of the temp chunks.
        for i in range(total):
            self._storage_delete(f"{user_id}/tmp/{session}/{i}", token)
        return self._ok({"storage_path": path})

    # ---- storage helpers (as the user; RLS applies) ----

    def _storage_base(self):
        return _normalize_url(os.environ.get("SUPABASE_URL", ""))

    def _storage_headers(self, token, extra=None):
        h = {
            "Authorization": f"Bearer {token}",
            "apikey": os.environ.get("SUPABASE_ANON_KEY", "").strip(),
        }
        if extra:
            h.update(extra)
        return h

    def _storage_put(self, path, body, content_type, token):
        req = urllib.request.Request(
            f"{self._storage_base()}/storage/v1/object/{BUCKET}/{path}",
            data=body, method="POST",
            headers=self._storage_headers(token, {"Content-Type": content_type, "x-upsert": "true"}))
        with urllib.request.urlopen(req, timeout=STORAGE_TIMEOUT_SECONDS) as resp:
            if not (200 <= resp.status < 300):
                raise RuntimeError(f"storage put {resp.status}")

    def _storage_get(self, path, token):
        req = urllib.request.Request(
            f"{self._storage_base()}/storage/v1/object/{BUCKET}/{path}",
            headers=self._storage_headers(token))
        with urllib.request.urlopen(req, timeout=STORAGE_TIMEOUT_SECONDS) as resp:
            return resp.read()

    def _storage_delete(self, path, token):
        try:
            req = urllib.request.Request(
                f"{self._storage_base()}/storage/v1/object/{BUCKET}/{path}",
                method="DELETE", headers=self._storage_headers(token))
            urllib.request.urlopen(req, timeout=STORAGE_TIMEOUT_SECONDS).read()
        except Exception:
            pass  # cleanup is best-effort

    # ---- misc helpers ----

    def _decode_b64(self, s):
        try:
            return base64.b64decode(s or "")
        except (binascii.Error, ValueError):
            return b""

    def _safe_token(self, s):
        """Allow only simple ids in storage paths (no slashes/traversal)."""
        s = str(s or "")
        return s if s and all(c.isalnum() or c in "-_" for c in s) else ""

    def _bearer_token(self):
        auth = self.headers.get("Authorization", "")
        return auth[len("Bearer "):].strip() if auth.startswith("Bearer ") else ""

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
                headers={"Authorization": f"Bearer {token}", "apikey": supabase_anon})
            with urllib.request.urlopen(req, timeout=AUTH_TIMEOUT_SECONDS) as resp:
                if resp.status != 200:
                    return None
                return json.loads(resp.read().decode()).get("id")
        except Exception:
            return None

    def _diag(self, user_id, msg):
        """Temporary flight recorder: write a step marker to reach_log (via the
        service key, so it always writes regardless of RLS). Best-effort, short
        timeout — logging must never stall or break the upload."""
        try:
            url = _normalize_url(os.environ.get("SUPABASE_URL", ""))
            key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
            if not url or not key or not user_id:
                return
            req = urllib.request.Request(
                f"{url}/rest/v1/reach_log",
                data=json.dumps({"user_id": user_id, "kind": "upload_diag",
                                 "content": msg}).encode(),
                method="POST",
                headers={"apikey": key, "Authorization": f"Bearer {key}",
                         "Content-Type": "application/json",
                         "Prefer": "return=minimal"})
            urllib.request.urlopen(req, timeout=5).read()
        except Exception:
            pass

    def _ok(self, obj):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.end_headers()
        self.wfile.write(json.dumps(obj).encode())

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
