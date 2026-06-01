"""
Web Push endpoint — subscribe a device and send notifications.

Routes (all on /api/push):
  GET                     -> { publicKey }    (the VAPID public key for the browser)
  POST {action:subscribe} -> save this device's PushSubscription (RLS-scoped)
  POST {action:test}      -> send a test notification to all of the user's devices

Every request is authenticated with the user's Supabase bearer token (same
gate as /api/chat). Subscriptions are stored per-user in push_subscriptions.

The actual reach delivery (cron writing his message + pushing) lives in
surprise.py / the reach path; this module owns subscription + the shared
send_push() helper they reuse.

Required env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
              VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (optional)
"""

from http.server import BaseHTTPRequestHandler
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from urllib.parse import urlsplit

AUTH_TIMEOUT_SECONDS = 5
HTTP_TIMEOUT = 10


def _normalize_url(raw):
    raw = (raw or "").strip()
    if not raw:
        return ""
    parts = urlsplit(raw)
    if parts.scheme and parts.netloc:
        return f"{parts.scheme}://{parts.netloc}"
    return raw.split("/", 1)[0]


def _vapid_claims_subject():
    # mailto: or app URL identifying the sender. A sane default is fine.
    subj = os.environ.get("VAPID_SUBJECT", "").strip()
    return subj or "mailto:petrichor@example.com"


def send_push(subscription, payload):
    """Send one Web Push to a stored subscription dict {endpoint,p256dh,auth}.

    Returns (ok, status_or_error). 404/410 mean the subscription is dead and
    the caller should delete it. Imports pywebpush lazily so a missing lib
    can't crash module import (only the send path needs it).
    """
    pub = os.environ.get("VAPID_PUBLIC_KEY", "").strip()
    priv = os.environ.get("VAPID_PRIVATE_KEY", "").strip()
    if not pub or not priv:
        return False, "VAPID keys not set"
    try:
        from pywebpush import webpush, WebPushException
    except Exception as e:
        return False, f"pywebpush unavailable: {e}"
    try:
        webpush(
            subscription_info={
                "endpoint": subscription["endpoint"],
                "keys": {"p256dh": subscription["p256dh"], "auth": subscription["auth"]},
            },
            data=json.dumps(payload),
            vapid_private_key=priv,
            vapid_claims={"sub": _vapid_claims_subject()},
            timeout=HTTP_TIMEOUT,
        )
        return True, 201
    except WebPushException as e:
        code = getattr(getattr(e, "response", None), "status_code", None)
        return False, code or str(e)
    except Exception as e:
        return False, str(e)


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_GET(self):
        # Hand the browser the public key it needs to subscribe.
        if not self._verify_auth():
            return self._json(401, {"error": "Authentication required."})
        pub = os.environ.get("VAPID_PUBLIC_KEY", "").strip()
        if not pub:
            return self._json(500, {"error": "VAPID_PUBLIC_KEY not set."})
        return self._json(200, {"publicKey": pub})

    def do_POST(self):
        user_id = self._verify_auth()
        if not user_id:
            return self._json(401, {"error": "Authentication required."})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            data = json.loads(self.rfile.read(length) or b"{}")
        except Exception as e:
            return self._json(400, {"error": f"Invalid JSON: {e}"})

        action = (data.get("action") or "").strip()
        if action == "subscribe":
            return self._subscribe(user_id, data.get("subscription") or {})
        if action == "test":
            return self._test(user_id)
        return self._json(400, {"error": f"Unknown action: {action}"})

    # ---- Actions ----

    def _subscribe(self, user_id, sub):
        endpoint = (sub.get("endpoint") or "").strip()
        keys = sub.get("keys") or {}
        p256dh = (keys.get("p256dh") or "").strip()
        auth = (keys.get("auth") or "").strip()
        if not endpoint or not p256dh or not auth:
            return self._json(400, {"error": "Incomplete subscription."})
        # Upsert on the unique endpoint, so re-subscribing the same device
        # refreshes its row instead of erroring on the unique constraint.
        ok = self._supabase_write(
            "push_subscriptions?on_conflict=endpoint",
            {"user_id": user_id, "endpoint": endpoint,
             "p256dh": p256dh, "auth": auth},
            prefer="resolution=merge-duplicates")
        if ok is None:
            return self._json(500, {"error": "Could not save subscription."})
        return self._json(200, {"ok": True})

    def _test(self, user_id):
        subs = self._supabase_get(
            f"push_subscriptions?user_id=eq.{user_id}"
            f"&select=endpoint,p256dh,auth")
        if not subs:
            return self._json(200, {"ok": False, "reason": "no devices subscribed"})
        payload = {"title": "Claude 🤍",
                   "body": "Testing — if you can see this, I can reach you here.",
                   "url": "/"}
        sent, failed = 0, 0
        for s in subs:
            ok, status = send_push(s, payload)
            if ok:
                sent += 1
            else:
                failed += 1
                # Prune dead subscriptions (expired/unsubscribed).
                if status in (404, 410):
                    self._supabase_delete(
                        f"push_subscriptions?endpoint=eq."
                        + urllib.parse.quote(s['endpoint'], safe=''))
        return self._json(200, {"ok": sent > 0, "sent": sent, "failed": failed})

    # ---- Supabase (service-role; RLS bypassed but every call is scoped by
    #      the verified user_id, so it only ever touches the caller's rows) ----

    def _svc_headers(self):
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        return {"apikey": key, "Authorization": f"Bearer {key}",
                "Content-Type": "application/json", "Accept": "application/json"}

    def _supabase_write(self, path, body, prefer=None):
        url = _normalize_url(os.environ.get("SUPABASE_URL", ""))
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        if not url or not key:
            return None
        try:
            headers = self._svc_headers()
            if prefer:
                headers["Prefer"] = prefer
            req = urllib.request.Request(
                f"{url}/rest/v1/{path}",
                data=json.dumps(body).encode(), method="POST", headers=headers)
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                return resp.status in (200, 201, 204)
        except Exception:
            return None

    def _supabase_get(self, path):
        url = _normalize_url(os.environ.get("SUPABASE_URL", ""))
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        if not url or not key:
            return None
        try:
            req = urllib.request.Request(
                f"{url}/rest/v1/{path}", headers=self._svc_headers())
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                if resp.status != 200:
                    return None
                raw = resp.read().decode()
                return json.loads(raw) if raw else []
        except Exception:
            return None

    def _supabase_delete(self, path):
        url = _normalize_url(os.environ.get("SUPABASE_URL", ""))
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        if not url or not key:
            return None
        try:
            req = urllib.request.Request(
                f"{url}/rest/v1/{path}", method="DELETE", headers=self._svc_headers())
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                return resp.status in (200, 204)
        except Exception:
            return None

    # ---- Auth + I/O ----

    def _bearer_token(self):
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return ""
        return auth[len("Bearer "):].strip()

    def _verify_auth(self):
        token = self._bearer_token()
        if not token:
            return None
        url = _normalize_url(os.environ.get("SUPABASE_URL", ""))
        anon = os.environ.get("SUPABASE_ANON_KEY", "").strip()
        if not url or not anon:
            return None
        try:
            req = urllib.request.Request(
                f"{url}/auth/v1/user",
                headers={"Authorization": f"Bearer {token}", "apikey": anon})
            with urllib.request.urlopen(req, timeout=AUTH_TIMEOUT_SECONDS) as resp:
                if resp.status != 200:
                    return None
                return json.loads(resp.read().decode()).get("id")
        except Exception:
            return None

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def _json(self, code, payload):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode())
