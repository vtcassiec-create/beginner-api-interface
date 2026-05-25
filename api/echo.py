"""
Network diagnostic echo endpoint.

Accepts a POST of arbitrary size, reads the whole body off the wire, and
returns how many bytes it actually received. No auth, no storage, no model —
its only job is to answer "can this device POST N bytes to our server and get
a response?" Used by /diag.html to find the size where a phone's uploads stall.
"""

from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import json
import time

CAP = 16 * 1024 * 1024  # don't read unboundedly


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        # ?delay=N — wait N seconds (silently) before responding, to test
        # whether a quiet connection gets dropped by the device's network.
        try:
            delay = min(float(parse_qs(urlparse(self.path).query).get("delay", ["0"])[0]), 25.0)
        except (ValueError, TypeError):
            delay = 0.0
        read = 0
        try:
            while read < length and read < CAP:
                buf = self.rfile.read(min(65536, length - read))
                if not buf:
                    break
                read += len(buf)
        except Exception:
            pass
        if delay > 0:
            time.sleep(delay)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.end_headers()
        self.wfile.write(json.dumps({
            "ok": True,
            "received_bytes": read,
            "content_length": length,
            "delayed": delay,
        }).encode())

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
