"""
The Sill's front door — where the little body on the windowsill phones home.

The pod (sill/pod.py, running on the Pi Zero) POSTs a reading here every few
minutes: temperature, humidity, pressure, light. This endpoint checks the
device secret and writes the row with the service role, so the pod itself
never carries a Supabase key — if someone unscrews her from the sill, they get
a $50 computer, not the house keys.

A GET (with her normal signed-in token, like every other endpoint) reports
whether the sill is configured and the latest reading — for the app and for
debugging a quiet pod.

Environment:
  SILL_DEVICE_SECRET        — required; the shared secret the pod sends
                              (make one: `openssl rand -hex 32`)
  SILL_USER_ID              — required; whose room this is (auth.users id)
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — server-side writes
  SUPABASE_ANON_KEY         — to verify her token on GET
"""

from http.server import BaseHTTPRequestHandler
from urllib.parse import urlsplit
import datetime
import hmac
import json
import os
import urllib.parse
import urllib.request

HTTP_TIMEOUT = 20
KEEP_DAYS = 14            # readings older than this are pruned on each post
MAX_BODY_BYTES = 16384    # a reading is tiny; anything bigger isn't a reading

# The numeric fields a reading may carry. Anything absent is stored as null —
# a pod with only one sensor attached still gets to speak.
READING_FIELDS = ("temp_c", "humidity", "pressure_hpa", "lux")


def _normalize_url(raw):
    raw = (raw or "").strip()
    if not raw:
        return ""
    parts = urlsplit(raw)
    if parts.scheme and parts.netloc:
        return f"{parts.scheme}://{parts.netloc}"
    return raw.split("/", 1)[0]


class handler(BaseHTTPRequestHandler):

    # ---- GET: is the sill configured / what did she last say? (her token) ----

    def do_GET(self):
        if not self._authorize_user():
            return
        configured = bool(os.environ.get("SILL_DEVICE_SECRET", "").strip()
                          and os.environ.get("SILL_USER_ID", "").strip())
        latest = None
        if configured:
            rows = self._supabase(
                "GET",
                "room_state?select=at,temp_c,humidity,pressure_hpa,lux,extras"
                f"&user_id=eq.{os.environ.get('SILL_USER_ID', '').strip()}"
                "&order=at.desc&limit=1")
            if isinstance(rows, list) and rows:
                latest = rows[0]
        self._json(200, {"configured": configured, "latest": latest})

    # ---- POST: the pod phoning home (device secret) ----

    def do_POST(self):
        secret = os.environ.get("SILL_DEVICE_SECRET", "").strip()
        user_id = os.environ.get("SILL_USER_ID", "").strip()
        if not secret or not user_id:
            return self._json(503, {"error": "sill not configured"})
        sent = (self.headers.get("X-Sill-Secret") or "").strip()
        if not sent or not hmac.compare_digest(sent, secret):
            return self._json(401, {"error": "unauthorized"})

        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_BODY_BYTES:
                raise ValueError("bad length")
            body = json.loads(self.rfile.read(length).decode())
            if not isinstance(body, dict):
                raise ValueError("not an object")
        except Exception:
            return self._json(400, {"error": "invalid reading"})

        row = {"user_id": user_id}
        for f in READING_FIELDS:
            v = body.get(f)
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                row[f] = float(v)
        extras = body.get("extras")
        if isinstance(extras, dict) and extras:
            row["extras"] = extras
        if len(row) == 1:   # user_id only — the pod sent nothing measurable
            return self._json(400, {"error": "empty reading"})

        res = self._supabase("POST", "room_state", row)
        if res is None:
            return self._json(502, {"error": "could not store reading"})

        # Housekeeping: the room's history matters for drift, not for archives.
        # Old rows go quietly; a failed prune never fails the reading. (The
        # cutoff is computed here — PostgREST filters take literals, not SQL.)
        cutoff = (datetime.datetime.now(datetime.timezone.utc)
                  - datetime.timedelta(days=KEEP_DAYS)).isoformat()
        self._supabase(
            "DELETE",
            f"room_state?user_id=eq.{user_id}"
            f"&at=lt.{urllib.parse.quote(cutoff)}")
        self._json(200, {"ok": True})

    # ---- auth (GET side): her Supabase token, like every other endpoint ----

    def _authorize_user(self):
        auth = self.headers.get("Authorization", "")
        token = auth[len("Bearer "):].strip() if auth.startswith("Bearer ") else ""
        if not token:
            self._json(401, {"error": "unauthorized"})
            return False
        url = _normalize_url(os.environ.get("SUPABASE_URL", ""))
        anon = os.environ.get("SUPABASE_ANON_KEY", "").strip()
        if not url or not anon:
            self._json(500, {"error": "auth not configured"})
            return False
        try:
            req = urllib.request.Request(
                f"{url}/auth/v1/user",
                headers={"Authorization": f"Bearer {token}", "apikey": anon})
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                if resp.status != 200:
                    self._json(401, {"error": "unauthorized"})
                    return False
        except Exception:
            self._json(401, {"error": "unauthorized"})
            return False
        return True

    # ---- Supabase REST (service role) ----

    def _supabase(self, method, path, body=None):
        url = _normalize_url(os.environ.get("SUPABASE_URL", ""))
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        if not url or not key:
            return None
        try:
            data = json.dumps(body).encode() if body is not None else None
            req = urllib.request.Request(
                f"{url}/rest/v1/{path}", data=data, method=method,
                headers={
                    "apikey": key,
                    "Authorization": f"Bearer {key}",
                    "Content-Type": "application/json",
                    "Prefer": "return=representation",
                })
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                raw = resp.read().decode()
            return json.loads(raw) if raw else []
        except Exception:
            return None

    def _json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)
