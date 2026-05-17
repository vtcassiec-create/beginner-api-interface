"""
Public config endpoint.

Returns the Supabase URL and anon key from server-side environment so the
frontend can initialize its Supabase client without any keys being baked
into the HTML at build time.

Both values returned here are designed to be public — Supabase's anon key
is meant to be shipped to the browser; data access is gated by Row-Level
Security policies, not by hiding the key.
"""

from http.server import BaseHTTPRequestHandler
from urllib.parse import urlsplit
import json
import os


def _normalize_url(raw):
    """Reduce SUPABASE_URL to scheme://host[:port].

    A trailing slash or stray path (e.g. ".../rest/v1") makes the auth
    endpoint resolve to an invalid path and Supabase rejects the request
    with "Invalid path specified in request URL".
    """
    raw = (raw or "").strip()
    if not raw:
        return ""
    parts = urlsplit(raw)
    if parts.scheme and parts.netloc:
        return f"{parts.scheme}://{parts.netloc}"
    # No scheme parsed (e.g. "abc.supabase.co/"); strip path manually.
    return raw.split("/", 1)[0]


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_GET(self):
        url = _normalize_url(os.environ.get("SUPABASE_URL", ""))
        key = os.environ.get("SUPABASE_ANON_KEY", "").strip()

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        self.wfile.write(json.dumps({
            "supabaseUrl": url,
            "supabaseAnonKey": key,
            "configured": bool(url and key),
        }).encode())

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
