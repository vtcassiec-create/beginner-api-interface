"""
Image upload proxy.

Some clients (notably a phone whose network path to Supabase Storage stalls
on larger uploads) can't push an image straight to Storage, even though small
requests work. This endpoint accepts the raw image bytes from the browser and
re-uploads them to Supabase Storage *server-side* — a different, sturdier
network path — then returns the object's storage path.

The upload is performed AS THE SIGNED-IN USER (their bearer token is forwarded
to Storage), so the per-user RLS policy on the 'attachments' bucket still
applies: a user can only ever write under their own {uid}/ folder.

Required environment variables (same as the chat endpoint):
  SUPABASE_URL, SUPABASE_ANON_KEY
"""

from http.server import BaseHTTPRequestHandler
import json
import os
import uuid
import urllib.error
import urllib.request
from urllib.parse import urlsplit

MAX_BYTES = 12 * 1024 * 1024  # generous ceiling for a downscaled photo
AUTH_TIMEOUT_SECONDS = 5
UPLOAD_TIMEOUT_SECONDS = 30
BUCKET = "attachments"


def _normalize_url(raw):
    """Reduce SUPABASE_URL to scheme://host[:port] (see chat.py)."""
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
        user_id = self._verify_auth()
        if not user_id:
            return self._json_error(401, "Authentication required. Please sign in.")

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0:
            return self._json_error(400, "Empty upload.")
        if length > MAX_BYTES:
            return self._json_error(413, "Image is too large.")

        body = self.rfile.read(length)
        content_type = (self.headers.get("Content-Type") or "image/jpeg").split(";")[0].strip()
        if not content_type.startswith("image/"):
            content_type = "image/jpeg"

        supabase_url = _normalize_url(os.environ.get("SUPABASE_URL", ""))
        supabase_anon = os.environ.get("SUPABASE_ANON_KEY", "").strip()
        if not supabase_url or not supabase_anon:
            return self._json_error(500, "Storage is not configured.")

        # Path under the user's own folder so RLS (insert) is satisfied.
        path = f"{user_id}/{uuid.uuid4().hex}.jpg"
        token = self._bearer_token()
        try:
            req = urllib.request.Request(
                f"{supabase_url}/storage/v1/object/{BUCKET}/{path}",
                data=body,
                method="POST",
                headers={
                    "Authorization": f"Bearer {token}",
                    "apikey": supabase_anon,
                    "Content-Type": content_type,
                    "x-upsert": "true",
                },
            )
            with urllib.request.urlopen(req, timeout=UPLOAD_TIMEOUT_SECONDS) as resp:
                if not (200 <= resp.status < 300):
                    return self._json_error(502, f"Storage returned {resp.status}.")
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode()[:200]
            except Exception:
                detail = str(e)
            return self._json_error(502, f"Storage upload failed: {detail}")
        except Exception as e:
            return self._json_error(502, f"Storage upload failed: {e}")

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.end_headers()
        self.wfile.write(json.dumps({"storage_path": path}).encode())

    # ---- helpers ----

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
                headers={"Authorization": f"Bearer {token}", "apikey": supabase_anon},
            )
            with urllib.request.urlopen(req, timeout=AUTH_TIMEOUT_SECONDS) as resp:
                if resp.status != 200:
                    return None
                return json.loads(resp.read().decode()).get("id")
        except Exception:
            return None

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
