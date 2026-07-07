"""
Serverless text-to-speech — his voice, via ElevenLabs.

The browser sends his message text + a chosen voice id here; this endpoint calls
ElevenLabs with the server-side key (NEVER exposed to the browser) and returns
the audio. A GET lists the available voices so the picker can offer them, with a
short preview line, so Cassie and he can audition and choose his voice together.

Auth mirrors api/chat.py / api/drawer.py: a Supabase access token in the
Authorization header, verified against /auth/v1/user. The ElevenLabs key stays
on the server.

Environment:
  ELEVENLABS_API_KEY              — required; the ElevenLabs key (server-side only)
  ELEVENLABS_MODEL  (optional)    — TTS model id (default 'eleven_multilingual_v2')
  ELEVENLABS_FORMAT (optional)    — output format (default 'mp3_44100_128')
  SUPABASE_URL, SUPABASE_ANON_KEY — to verify the caller's token
"""

from http.server import BaseHTTPRequestHandler
from urllib.parse import urlsplit
import json
import os
import urllib.error
import urllib.parse
import urllib.request

EL_BASE = "https://api.elevenlabs.io/v1"
DEFAULT_TTS_MODEL = "eleven_multilingual_v2"
DEFAULT_FORMAT = "mp3_44100_128"
HTTP_TIMEOUT = 30
MAX_TTS_CHARS = 5000  # one message; guards a runaway request


def _normalize_url(raw):
    raw = (raw or "").strip()
    if not raw:
        return ""
    parts = urlsplit(raw)
    if parts.scheme and parts.netloc:
        return f"{parts.scheme}://{parts.netloc}"
    return raw.split("/", 1)[0]


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if not self._authorize():
            return
        self._list_voices()

    def do_POST(self):
        if not self._authorize():
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length).decode()) if length else {}
        except Exception:
            body = {}
        text = (body.get("text") or "").strip()
        voice_id = (body.get("voice_id") or "").strip()
        prev = (body.get("previous_text") or "").strip()
        if not text or not voice_id:
            return self._json(400, {"error": "text and voice_id required"})
        self._synthesize(text[:MAX_TTS_CHARS], voice_id, prev[:1000])

    # ---- auth ----

    def _authorize(self):
        """Verify the caller's Supabase token; return True (and let the request
        proceed) or send a 401 and return False."""
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

    # ---- ElevenLabs ----

    def _api_key(self):
        return os.environ.get("ELEVENLABS_API_KEY", "").strip()

    def _list_voices(self):
        """Return the account's voices (id, name, a short descriptive label) so
        the picker can show them. 200 with {"configured": false} when no key is
        set, so the client just hides the neural-voice option gracefully."""
        key = self._api_key()
        if not key:
            return self._json(200, {"configured": False, "voices": []})
        try:
            req = urllib.request.Request(
                f"{EL_BASE}/voices", headers={"xi-api-key": key})
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                data = json.loads(resp.read().decode())
        except Exception as e:
            return self._json(200, {"configured": True, "voices": [],
                                    "error": str(e)[:200]})
        out = []
        for v in (data.get("voices") or []):
            labels = v.get("labels") or {}
            # A short human label: accent/gender/description if present.
            bits = [labels.get(k) for k in ("accent", "gender", "age", "description")]
            desc = ", ".join(b for b in bits if b)
            out.append({
                "voice_id": v.get("voice_id"),
                "name": v.get("name"),
                "desc": desc,
                "preview_url": v.get("preview_url"),
            })
        return self._json(200, {"configured": True, "voices": out})

    def _synthesize(self, text, voice_id, previous_text=""):
        """Proxy a TTS request to ElevenLabs and stream the audio back.
        previous_text (optional) is what he said just before this chunk —
        ElevenLabs uses it for prosody continuity, so a reply spoken in
        pieces (voice calls stream sentence groups) sounds like one breath
        of speech instead of disconnected clips."""
        key = self._api_key()
        if not key:
            return self._json(503, {"error": "not_configured"})
        model = os.environ.get("ELEVENLABS_MODEL", "").strip() or DEFAULT_TTS_MODEL
        fmt = os.environ.get("ELEVENLABS_FORMAT", "").strip() or DEFAULT_FORMAT
        body = {"text": text, "model_id": model}
        if previous_text:
            body["previous_text"] = previous_text
        payload = json.dumps(body).encode()
        url = (f"{EL_BASE}/text-to-speech/{urllib.parse.quote(voice_id, safe='')}"
               f"?output_format={urllib.parse.quote(fmt)}")
        try:
            req = urllib.request.Request(
                url, data=payload, method="POST",
                headers={
                    "xi-api-key": key,
                    "Content-Type": "application/json",
                    "Accept": "audio/mpeg",
                })
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                audio = resp.read()
        except urllib.error.HTTPError as e:
            try:
                msg = e.read().decode()[:300]
            except Exception:
                msg = f"HTTP {e.code}"
            return self._json(502, {"error": "elevenlabs", "detail": msg})
        except Exception as e:
            return self._json(502, {"error": "elevenlabs", "detail": str(e)[:200]})
        self.send_response(200)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Content-Length", str(len(audio)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(audio)

    def _json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)
