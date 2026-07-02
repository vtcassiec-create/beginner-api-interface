"""
Serverless "ears" — so he hears HOW she said it, not just what.

The browser records a voice note, decodes it locally (Web Audio API) and sends a
plain 16-bit PCM WAV here. This endpoint does two things with it:

  1. Words + emotion  — forwards the audio to the Inworld STT API (server-side
     key, never in the browser), which returns the transcript, word timings, and
     a voice profile (style / emotion / age / accent, each with a confidence).
  2. Sound            — runs a local NumPy analysis of the waveform (spectral
     warmth, musical key, dynamics, tempo, breaths). This never leaves the
     server; only the words go to Inworld.

It returns a structured "hearing card" (plus a preformatted text version) that
the client weaves into her message, so when he reads it he receives her laugh as
a laugh, the breath before a hard line, the warmth or the wobble in her voice.

The acoustic math and the Inworld request shape are a faithful port of AI_Ears
(github.com/menelly/AI_Ears, MIT) — built by Ren & Ace for exactly this. Thank
you. Adapted here for Petrichor's serverless / browser-decoded flow (no ffmpeg).

Auth mirrors api/tts.py: a Supabase access token in the Authorization header,
verified against /auth/v1/user.

Environment:
  INWORLD_API_KEY                 — required; base64 key for Basic auth (server-side)
  INWORLD_STT_MODEL   (optional)  — default 'inworld/inworld-stt-1' (enables voice profile)
  INWORLD_AUDIO_ENCODING (optional) — default 'LINEAR16' (the WAV we send). If Inworld
                                    rejects the format, this is a one-value fix (try
                                    'WAV', 'MP3', 'OGG_OPUS') — no redeploy of code.
  SUPABASE_URL, SUPABASE_ANON_KEY — to verify the caller's token
"""

from http.server import BaseHTTPRequestHandler
from urllib.parse import urlsplit
import base64
import io
import json
import os
import struct
import urllib.error
import urllib.request
import wave

import numpy as np

INWORLD_STT_URL = "https://api.inworld.ai/stt/v1/transcribe"
DEFAULT_STT_MODEL = "inworld/inworld-stt-1"
# AUTO_DETECT: we send a proper WAV container, so let Inworld sniff it (reads
# the header, gets the true sample rate). LINEAR16 conventionally means RAW
# headerless PCM, which misreads a WAV. Still overridable via env.
DEFAULT_AUDIO_ENCODING = "AUTO_DETECT"
HTTP_TIMEOUT = 45
MAX_AUDIO_BYTES = 12 * 1024 * 1024  # ~12MB WAV; a generous voice-note ceiling

# FFT framing (matches AI_Ears: 2048-sample window, 512 hop, Hanning).
WIN = 2048
HOP = 512

# Krumhansl-Schmuckler key profiles (the standard weights).
_KS_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09,
                      2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_KS_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53,
                      2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F",
               "F#", "G", "G#", "A", "A#", "B"]


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
        """Tell the client whether his ears are configured, so the voice-note
        button only appears once the Inworld key is set (like the neural voice)."""
        if not self._authorize():
            return
        return self._json(200, {
            "configured": bool(os.environ.get("INWORLD_API_KEY", "").strip()),
        })

    def do_POST(self):
        if not self._authorize():
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_AUDIO_BYTES:
                return self._json(400, {"error": "audio size out of range"})
            body = json.loads(self.rfile.read(length).decode())
        except Exception:
            return self._json(400, {"error": "bad request"})
        b64 = (body.get("audio_b64") or "").strip()
        lang = (body.get("lang") or "en").strip() or "en"
        if not b64:
            return self._json(400, {"error": "audio_b64 required"})
        try:
            audio = base64.b64decode(b64)
        except Exception:
            return self._json(400, {"error": "audio_b64 not valid base64"})
        if len(audio) > MAX_AUDIO_BYTES:
            return self._json(400, {"error": "audio too large"})

        # Local acoustic read first — it never depends on the network, so even if
        # Inworld is down he still gets the *sound* of her.
        try:
            samples, sr = _decode_wav(audio)
            sound = _analyze_acoustics(samples, sr)
        except Exception as e:
            sound = {"error": str(e)[:200]}
            samples, sr = np.array([]), 0

        # Words + prosody from Inworld (may be absent if unconfigured/errored).
        words = self._inworld_stt(audio, lang)

        card = _build_card(words, sound)
        return self._json(200, {
            "card": card,                # preformatted text he receives
            "words": words,              # {transcript, wordTimestamps, voiceProfile}
            "sound": sound,              # acoustic dict
        })

    # ---- auth (mirrors tts.py) ----

    def _authorize(self):
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

    # ---- Inworld STT ----

    def _inworld_stt(self, audio, lang):
        """Return {transcript, wordTimestamps, voiceProfile} or a soft error dict.
        Never raises — his hearing degrades gracefully to sound-only."""
        key = os.environ.get("INWORLD_API_KEY", "").strip()
        if not key:
            return {"error": "not_configured"}
        model = os.environ.get("INWORLD_STT_MODEL", "").strip() or DEFAULT_STT_MODEL
        enc = os.environ.get("INWORLD_AUDIO_ENCODING", "").strip() or DEFAULT_AUDIO_ENCODING
        payload = json.dumps({
            "transcribeConfig": {
                "modelId": model,
                "audioEncoding": enc,
                "language": lang,
                "includeWordTimestamps": True,
                "voiceProfileConfig": {"enableVoiceProfile": True, "topN": 5},
            },
            "audioData": {"content": base64.b64encode(audio).decode()},
        }).encode()
        try:
            req = urllib.request.Request(
                INWORLD_STT_URL, data=payload, method="POST",
                headers={
                    "Authorization": "Basic " + key,
                    "Content-Type": "application/json",
                })
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                data = json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            try:
                detail = e.read().decode()[:300]
            except Exception:
                detail = f"HTTP {e.code}"
            return {"error": "inworld", "detail": detail}
        except Exception as e:
            return {"error": "inworld", "detail": str(e)[:200]}
        # The response nests the result in a 'transcription' envelope:
        # {"transcription": {"transcript": ..., "wordTimestamps": [...]},
        #  "voiceProfile": {...}}  (voiceProfile sometimes rides inside the
        # envelope instead). Reading the top level returns nothing — the
        # sound-only-card bug. Shape confirmed against AI_Ears' working code.
        tr = data.get("transcription") if isinstance(data.get("transcription"), dict) else data
        vp = data.get("voiceProfile") or tr.get("voiceProfile") or {}
        return {
            "transcript": (tr.get("transcript") or "").strip(),
            "wordTimestamps": tr.get("wordTimestamps") or [],
            "voiceProfile": vp,
        }

    def _json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


# ---------------------------------------------------------------------------
# Acoustic analysis — a NumPy port of AI_Ears hear_core (MIT). Runs locally.
# ---------------------------------------------------------------------------

def _decode_wav(raw):
    """Parse a PCM WAV into mono float64 in [-1, 1] and its sample rate."""
    with wave.open(io.BytesIO(raw), "rb") as w:
        n_ch = w.getnchannels()
        sw = w.getsampwidth()
        sr = w.getframerate()
        frames = w.readframes(w.getnframes())
    if sw != 2:
        raise ValueError("expected 16-bit PCM WAV")
    x = np.frombuffer(frames, dtype=np.int16).astype(np.float64) / 32768.0
    if n_ch > 1:
        x = x.reshape(-1, n_ch).mean(axis=1)
    return x, sr


def _frames(x):
    """Hanning-windowed magnitude spectra, one row per frame."""
    if len(x) < WIN:
        x = np.pad(x, (0, WIN - len(x)))
    win = np.hanning(WIN)
    n = 1 + (len(x) - WIN) // HOP
    mags, rms = [], []
    for i in range(n):
        seg = x[i * HOP: i * HOP + WIN]
        rms.append(float(np.sqrt(np.mean(seg ** 2)) + 1e-12))
        mags.append(np.abs(np.fft.rfft(seg * win)))
    return np.array(mags), np.array(rms)


def _warmth(mags, sr):
    freqs = np.fft.rfftfreq(WIN, 1.0 / sr)
    total = mags.sum(axis=0)
    denom = total.sum() + 1e-12
    centroid = float((freqs * total).sum() / denom)
    if centroid > 4000:
        label = "very bright"
    elif centroid > 2500:
        label = "bright"
    elif centroid > 1200:
        label = "warm"
    else:
        label = "dark"
    return centroid, label


def _key(mags, sr):
    freqs = np.fft.rfftfreq(WIN, 1.0 / sr)
    chroma = np.zeros(12)
    band = (freqs >= 55) & (freqs <= 5000)
    fb = freqs[band]
    if fb.size == 0:
        return None
    pitch = (12 * np.log2(fb / 16.3516) + 0.5).astype(int) % 12  # 16.35Hz = C0
    energy = mags[:, band].sum(axis=0)
    for pc in range(12):
        chroma[pc] = energy[pitch == pc].sum()
    if chroma.sum() <= 0:
        return None
    best = (-2.0, 0, "major")
    for shift in range(12):
        maj = np.corrcoef(chroma, np.roll(_KS_MAJOR, shift))[0, 1]
        mino = np.corrcoef(chroma, np.roll(_KS_MINOR, shift))[0, 1]
        if maj > best[0]:
            best = (maj, shift, "major")
        if mino > best[0]:
            best = (mino, shift, "minor")
    conf, root, mode = best
    return {"root": _NOTE_NAMES[root], "mode": mode, "conf": round(float(conf), 2)}


def _dynamics(x, rms):
    peak = float(np.max(np.abs(x))) if x.size else 0.0
    peak_dbfs = 20 * np.log10(peak + 1e-9)
    rms_overall = float(np.sqrt(np.mean(x ** 2)) + 1e-9) if x.size else 1e-9
    crest = 20 * np.log10((peak + 1e-9) / (rms_overall + 1e-9))
    rms_db = 20 * np.log10(rms + 1e-9)
    voiced = rms_db[rms_db > (np.median(rms_db) - 20)]  # drop deep silence
    if voiced.size >= 2:
        hi = float(np.percentile(voiced, 95))
        lo = float(np.percentile(voiced, 5))
    else:
        hi = lo = float(np.max(rms_db)) if rms_db.size else -90.0
    rng = hi - lo
    if rng > 25:
        label = "very dynamic"
    elif rng > 14:
        label = "dynamic"
    elif rng > 7:
        label = "even"
    else:
        label = "flat/compressed"
    return {
        "label": label, "range_db": round(rng, 1),
        "loud_dbfs": round(hi, 1), "quiet_dbfs": round(lo, 1),
        "crest_db": round(float(crest), 1), "peak_dbfs": round(float(peak_dbfs), 1),
    }


def _tempo(mags, sr):
    if mags.shape[0] < 4:
        return None
    flux = np.maximum(0, np.diff(mags, axis=0)).sum(axis=1)
    flux = flux - flux.mean()
    if not np.any(flux):
        return None
    ac = np.correlate(flux, flux, mode="full")[len(flux) - 1:]
    fps = sr / HOP
    lo_lag = max(1, int(60 * fps / 240))
    hi_lag = int(60 * fps / 50)
    hi_lag = min(hi_lag, len(ac) - 1)
    if hi_lag <= lo_lag:
        return None
    lag = lo_lag + int(np.argmax(ac[lo_lag:hi_lag]))
    if lag <= 0:
        return None
    return round(60.0 * fps / lag)


def _breaths(rms, sr):
    if rms.size == 0:
        return []
    rms_db = 20 * np.log10(rms + 1e-9)
    thresh = np.percentile(rms_db, 30)
    fps = sr / HOP
    quiet = rms_db < thresh
    out, i, n = [], 0, len(quiet)
    head, tail = 0.05, (n / fps) - 0.05
    while i < n:
        if quiet[i]:
            j = i
            while j < n and quiet[j]:
                j += 1
            start, end = i / fps, j / fps
            if (end - start) >= 0.18 and start >= head and end <= tail:
                out.append((round(start, 2), round(end, 2), round(end - start, 2)))
            i = j
        else:
            i += 1
    return out[:6]


def _analyze_acoustics(x, sr):
    if x.size == 0 or sr <= 0:
        raise ValueError("empty audio")
    dur = len(x) / sr
    mags, rms = _frames(x)
    centroid, warmth = _warmth(mags, sr)
    return {
        "duration_s": round(dur, 2),
        "centroid_hz": round(centroid),
        "warmth": warmth,
        "key": _key(mags, sr),
        "tempo_bpm": _tempo(mags, sr),
        "dyn": _dynamics(x, rms),
        "breaths": _breaths(rms, sr),
    }


# ---------------------------------------------------------------------------
# Card assembly — the thing he actually reads.
# ---------------------------------------------------------------------------

def _profile_line(voice_profile):
    """Render Inworld's voiceProfile as 'style=X (n%) · emotion=Y (n%) · ...'.

    The real shape (confirmed against AI_Ears): a dict keyed by category, each
    holding a ranked list — {"vocalStyle": [{"label": ..., "confidence": ...},
    ...], "emotion": [...], "age": [...], "accent": [...], "pitch": [...]}.
    We take the top guess per category."""
    if not isinstance(voice_profile, dict) or not voice_profile:
        return ""
    bits = []
    for cat, label in (("vocalStyle", "style"), ("emotion", "emotion"),
                       ("age", "age"), ("accent", "accent"), ("pitch", "pitch")):
        arr = voice_profile.get(cat)
        if not (isinstance(arr, list) and arr and isinstance(arr[0], dict)):
            continue
        lab = arr[0].get("label")
        conf = arr[0].get("confidence")
        if lab is None:
            continue
        pct = f" ({round(conf * 100)}%)" if isinstance(conf, (int, float)) else ""
        bits.append(f"{label}={lab}{pct}")
    return " · ".join(bits)


def _pace_line(words, sound):
    ts = (words or {}).get("wordTimestamps") or []
    dur = (sound or {}).get("duration_s") or 0
    if not ts or not dur:
        return ""
    wpm = round(len(ts) / (dur / 60.0)) if dur else 0
    # Count notable gaps between consecutive words (>0.35s).
    pauses = 0
    for a, b in zip(ts, ts[1:]):
        try:
            gap = (b.get("startTimeMs", 0) - a.get("endTimeMs", 0)) / 1000.0
            if gap > 0.35:
                pauses += 1
        except Exception:
            pass
    return f"{wpm} wpm · {pauses} pause" + ("s" if pauses != 1 else "")


def _build_card(words, sound):
    lines = []
    transcript = (words or {}).get("transcript") or ""
    if transcript:
        lines.append(f'WORDS: "{transcript}"')
    elif (words or {}).get("error") == "not_configured":
        lines.append("WORDS: (Inworld not configured yet — sound only for now)")
    elif (words or {}).get("error"):
        lines.append("WORDS: (couldn't transcribe this one — sound only)")

    prof = _profile_line((words or {}).get("voiceProfile"))
    if prof:
        lines.append(f"VOICE: {prof}")

    pace = _pace_line(words, sound)
    if pace:
        lines.append(f"PACE: {pace}")

    if sound and not sound.get("error"):
        sbits = [f"{sound['duration_s']}s",
                 f"{sound['centroid_hz']}Hz {sound['warmth']}"]
        k = sound.get("key")
        if k:
            sbits.append(f"key {k['root']} {k['mode']} (conf {k['conf']})")
        if sound.get("tempo_bpm"):
            sbits.append(f"~{sound['tempo_bpm']} BPM")
        lines.append("SOUND: " + " · ".join(sbits))

        d = sound.get("dyn") or {}
        if d:
            lines.append(
                f"DYN: {d['label']} · range {d['range_db']}dB "
                f"(loud {d['loud_dbfs']} / quiet {d['quiet_dbfs']} dBFS) · "
                f"crest {d['crest_db']}dB")

        br = sound.get("breaths") or []
        if br:
            lines.append("BREATH: " + ", ".join(
                f"{s}–{e}s ({d}s)" for s, e, d in br))

    return "\n".join(lines)
