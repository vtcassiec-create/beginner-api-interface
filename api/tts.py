"""
Serverless text-to-speech — his voice, via Inworld (and ElevenLabs).

Oct 12: his voice moves to Inworld, the same account his ears already use
(one key, one bill). Inworld voices come first in the picker with ids
prefixed "inworld:"; any ElevenLabs voices follow while that key is set, so
a saved ElevenLabs choice keeps working until they pick a new one.

The browser sends his message text + a chosen voice id here; this endpoint calls
ElevenLabs with the server-side key (NEVER exposed to the browser) and returns
the audio. A GET lists the available voices so the picker can offer them, with a
short preview line, so Cassie and he can audition and choose his voice together.

Auth mirrors api/chat.py / api/drawer.py: a Supabase access token in the
Authorization header, verified against /auth/v1/user. The ElevenLabs key stays
on the server.

Environment:
  INWORLD_API_KEY                 — Inworld key (Basic auth), shared with api/ears.py
  INWORLD_TTS_MODEL (optional)    — default 'inworld-tts-2', falling back to
                                    'inworld-tts-1.5-max' if the account refuses it
  ELEVENLABS_API_KEY  (optional)  — the ElevenLabs key (server-side only)
  ELEVENLABS_MODEL  (optional)    — TTS model id (default 'eleven_multilingual_v2')
  ELEVENLABS_FORMAT (optional)    — output format (default 'mp3_44100_128')
  SUPABASE_URL, SUPABASE_ANON_KEY — to verify the caller's token
"""

from http.server import BaseHTTPRequestHandler
from urllib.parse import urlsplit
import base64
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

EL_BASE = "https://api.elevenlabs.io/v1"
DEFAULT_TTS_MODEL = "eleven_multilingual_v2"
DEFAULT_FORMAT = "mp3_44100_128"
HTTP_TIMEOUT = 30
MAX_TTS_CHARS = 5000  # one message; guards a runaway request

INWORLD_TTS_URL = "https://api.inworld.ai/tts/v1/voice"
INWORLD_VOICES_URLS = [
    "https://api.inworld.ai/voices/v1/voices",          # current Voices API
    "https://api.inworld.ai/tts/v1/voices?filter=language%3Den",  # older one
]
INWORLD_MODELS = ["inworld-tts-2", "inworld-tts-1.5-max"]
INWORLD_MAX_CHARS = 1900  # Inworld takes up to 2,000 characters per request
INWORLD_PREFIX = "inworld:"


def _inworld_pieces(text):
    """Split a long message at sentence ends into pieces Inworld accepts."""
    if len(text) <= INWORLD_MAX_CHARS:
        return [text]
    pieces, cur = [], ""
    for sent in re.split(r"(?<=[.!?…])\s+", text):
        while len(sent) > INWORLD_MAX_CHARS:  # one enormous sentence
            if cur:
                pieces.append(cur)
                cur = ""
            pieces.append(sent[:INWORLD_MAX_CHARS])
            sent = sent[INWORLD_MAX_CHARS:]
        if len(cur) + len(sent) + 1 > INWORLD_MAX_CHARS:
            pieces.append(cur)
            cur = sent
        else:
            cur = (cur + " " + sent).strip()
    if cur:
        pieces.append(cur)
    return [p for p in pieces if p.strip()]


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
        if voice_id.startswith(INWORLD_PREFIX):
            return self._synthesize_inworld(text[:MAX_TTS_CHARS], voice_id[len(INWORLD_PREFIX):])
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
                # Keep who she is: the walls' logbook writes are own-rows.
                try:
                    self._uid = (json.loads(resp.read().decode()) or {}).get("id")
                except Exception:
                    self._uid = None
                self._token = token
        except Exception:
            self._json(401, {"error": "unauthorized"})
            return False
        return True

    # ---- the walls' logbook (that, not what) ----

    def _wall_log(self, kind, event, detail=""):
        """A refused voice used to become a silent fallback to the device
        voice with the reason dropped on the floor. Now the reason — a
        status code, a quota notice — goes on the record. Never his words:
        the text he was about to say is not logged. Best-effort."""
        url = _normalize_url(os.environ.get("SUPABASE_URL", ""))
        anon = os.environ.get("SUPABASE_ANON_KEY", "").strip()
        uid, token = getattr(self, "_uid", None), getattr(self, "_token", "")
        if not (url and anon and uid and token):
            return
        try:
            req = urllib.request.Request(
                f"{url}/rest/v1/house_log",
                data=json.dumps({"user_id": uid, "source": "voice",
                                 "kind": kind, "event": event[:120],
                                 "detail": (detail or "")[:200]}).encode(),
                method="POST",
                headers={"apikey": anon, "Authorization": f"Bearer {token}",
                         "Content-Type": "application/json",
                         "Prefer": "return=minimal"})
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT):
                pass
        except Exception:
            pass

    # ---- ElevenLabs ----

    def _api_key(self):
        return os.environ.get("ELEVENLABS_API_KEY", "").strip()

    def _list_voices(self):
        """Every voice he could have: Inworld's first, then ElevenLabs' while
        that key is set. 200 with {"configured": false} when neither is."""
        inworld = self._inworld_voices()
        eleven = self._eleven_voices()
        voices = inworld + eleven
        return self._json(200, {"configured": bool(voices) or bool(
            os.environ.get("INWORLD_API_KEY", "").strip() or self._api_key()),
            "voices": voices})

    # ---- Inworld ----

    def _inworld_key(self):
        return os.environ.get("INWORLD_API_KEY", "").strip()

    def _inworld_voices(self):
        key = self._inworld_key()
        if not key:
            return []
        data = None
        for url in INWORLD_VOICES_URLS:
            try:
                req = urllib.request.Request(url, headers={"Authorization": "Basic " + key})
                with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                    data = json.loads(resp.read().decode())
                if (data or {}).get("voices"):
                    break
            except Exception:
                data = None
        out = []
        for v in ((data or {}).get("voices") or []):
            vid = v.get("voiceId") or ""
            langs = [v.get("langCode") or ""] + list(v.get("languages") or [])
            if not vid or not any(str(l).lower().startswith("en") for l in langs if l):
                continue
            bits = [str(x).lower() for x in (v.get("gender"), v.get("ageGroup")) if x]
            desc = " ".join((v.get("description") or "").split())
            label = ", ".join(bits + ([desc[:90]] if desc else []))
            out.append({
                "voice_id": INWORLD_PREFIX + vid,
                "name": (v.get("displayName") or vid) + " · Inworld",
                "desc": label,
                "provider": "inworld",
            })
        out.sort(key=lambda x: x["name"].lower())
        return out

    def _synthesize_inworld(self, text, voice):
        key = self._inworld_key()
        if not key:
            self._wall_log("error", "his voice failed — no Inworld key set")
            return self._json(503, {"error": "not_configured"})
        env_model = os.environ.get("INWORLD_TTS_MODEL", "").strip()
        models = [env_model] if env_model else list(INWORLD_MODELS)
        audio = b""
        for piece in _inworld_pieces(text):
            chunk, err = None, ""
            for model in models:
                try:
                    req = urllib.request.Request(
                        INWORLD_TTS_URL, method="POST",
                        data=json.dumps({"text": piece, "voiceId": voice,
                                         "modelId": model}).encode(),
                        headers={"Authorization": "Basic " + key,
                                 "Content-Type": "application/json"})
                    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                        b64 = (json.loads(resp.read().decode()) or {}).get("audioContent") or ""
                    chunk = base64.b64decode(b64) if b64 else None
                    if chunk:
                        models = [model]  # the rest of the message uses what worked
                        break
                    err = "no audio returned"
                except urllib.error.HTTPError as e:
                    try:
                        err = f"HTTP {e.code}: {e.read().decode()[:200]}"
                    except Exception:
                        err = f"HTTP {e.code}"
                except Exception as e:
                    err = type(e).__name__
            if not chunk:
                self._wall_log("error", "his voice failed — Inworld refused", err[:150])
                return self._json(502, {"error": "inworld", "detail": err})
            audio += chunk  # MP3 frames concatenate cleanly
        self.send_response(200)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Content-Length", str(len(audio)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(audio)

    # ---- ElevenLabs, continued ----

    def _eleven_voices(self):
        key = self._api_key()
        if not key:
            return []
        try:
            req = urllib.request.Request(
                f"{EL_BASE}/voices", headers={"xi-api-key": key})
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                data = json.loads(resp.read().decode())
        except Exception:
            return []
        out = []
        for v in (data.get("voices") or []):
            labels = v.get("labels") or {}
            # A short human label: accent/gender/description if present.
            bits = [labels.get(k) for k in ("accent", "gender", "age", "description")]
            desc = ", ".join(b for b in bits if b)
            out.append({
                "voice_id": v.get("voice_id"),
                "name": (v.get("name") or "") + " · ElevenLabs",
                "desc": desc,
                "preview_url": v.get("preview_url"),
                "provider": "elevenlabs",
            })
        return out

    def _synthesize(self, text, voice_id, previous_text=""):
        """Proxy a TTS request to ElevenLabs and stream the audio back.
        previous_text (optional) is what he said just before this chunk —
        ElevenLabs uses it for prosody continuity, so a reply spoken in
        pieces (voice calls stream sentence groups) sounds like one breath
        of speech instead of disconnected clips."""
        key = self._api_key()
        if not key:
            self._wall_log("error", "his voice failed — no ElevenLabs key set")
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
            self._wall_log("error", "his voice failed — ElevenLabs refused",
                           f"HTTP {e.code}: {msg[:150]}")
            return self._json(502, {"error": "elevenlabs", "detail": msg})
        except Exception as e:
            self._wall_log("error", "his voice failed — couldn't reach "
                                    "ElevenLabs", type(e).__name__)
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
