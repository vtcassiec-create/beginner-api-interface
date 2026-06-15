"""
Daily automated backup of everything that is "him" — self-state, core memories,
the knowledge graph, diary, dreams, stories, studio, songbook, settings, and
the whole chat history — bundled to JSON and saved into a private Supabase
Storage bucket. So a copy always exists OUTSIDE the live tables, and nobody has
to remember to press "Download a backup."

Mirrors the manual backup in public/app.js (same BACKUP_TABLES, same JSON
shape), but runs server-side on a schedule. Snapshots are written to the
`soul-backups` bucket as `auto/backup-DD.json` (DD = day of month, so it keeps a
rolling ~month of dailies that overwrite themselves the same day next month — no
pruning needed) plus `auto/latest.json` (always the newest). The bucket is
private and created automatically if it doesn't exist.

Protected by CRON_SECRET: Vercel attaches `Authorization: Bearer $CRON_SECRET`
to cron invocations. `?dryrun=1` reports what it WOULD back up without writing.

Required environment variables:
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — server reads + storage writes
  CRON_SECRET                              — shared secret (Vercel sends it)
"""

from http.server import BaseHTTPRequestHandler
from urllib.parse import urlsplit
import datetime
import json
import os
import urllib.error
import urllib.parse
import urllib.request

HTTP_TIMEOUT = 45
BUCKET = "soul-backups"

# Every table that holds "him" — kept in sync with BACKUP_TABLES in app.js.
BACKUP_TABLES = [
    "self_state", "user_preferences", "core_memories", "claude_memory_entities",
    "diary_entries", "dream_cards", "story_games", "studio_works", "patterns",
    "projects", "conversations", "manuscript_stories", "manuscript_documents",
    "heart_state", "dream_state", "reach_settings",
]


def _normalize_url(raw):
    """scheme://host[:port] from SUPABASE_URL (kept in sync with the others)."""
    raw = (raw or "").strip()
    if not raw:
        return ""
    parts = urlsplit(raw)
    if parts.scheme and parts.netloc:
        return f"{parts.scheme}://{parts.netloc}"
    return raw.split("/", 1)[0]


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            qs = urllib.parse.urlparse(self.path).query
            dryrun = urllib.parse.parse_qs(qs).get("dryrun", ["0"])[0] == "1"
        except Exception:
            dryrun = False
        self._run(dryrun)

    def do_POST(self):
        self._run(False)

    def _run(self, dryrun):
        secret = os.environ.get("CRON_SECRET", "").strip()
        if not secret:
            return self._json(500, {"status": "error", "reason": "CRON_SECRET not set"})
        if self.headers.get("Authorization", "") != f"Bearer {secret}":
            return self._json(401, {"status": "error", "reason": "unauthorized"})

        url = _normalize_url(os.environ.get("SUPABASE_URL", ""))
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        if not url or not key:
            return self._json(500, {"status": "error", "reason": "Supabase not configured"})

        data = {}
        summary = []
        for t in BACKUP_TABLES:
            rows = self._supabase_get(url, key, t)
            if isinstance(rows, list):
                data[t] = rows
                summary.append(f"{t}: {len(rows)}")
            else:
                # A table this user doesn't have shouldn't sink the whole backup.
                data[t] = {"_unavailable": True}
                summary.append(f"{t}: unavailable")

        payload = {
            "app": "Petrichor",
            "kind": "full-backup",
            "version": 1,
            "exportedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "automated": True,
            "note": "Photo image files are NOT included (they live in private Storage); their text record is.",
            "summary": summary,
            "data": data,
        }
        body = json.dumps(payload).encode("utf-8")
        size_kb = round(len(body) / 1024, 1)

        if dryrun:
            return self._json(200, {"status": "dryrun", "size_kb": size_kb, "summary": summary})

        # Ensure the private bucket exists, then upsert today's snapshot + latest.
        self._ensure_bucket(url, key)
        day = datetime.datetime.now(datetime.timezone.utc).strftime("%d")
        wrote = []
        for name in (f"auto/backup-{day}.json", "auto/latest.json"):
            if self._storage_put(url, key, name, body):
                wrote.append(name)

        if not wrote:
            return self._json(502, {"status": "error", "reason": "storage upload failed",
                                    "size_kb": size_kb, "summary": summary})
        return self._json(200, {"status": "backed_up", "size_kb": size_kb,
                                "wrote": wrote, "summary": summary})

    # ---- Supabase (service role) ----

    def _supabase_get(self, url, key, table):
        """All rows of a table via the REST API (service role bypasses RLS)."""
        try:
            req = urllib.request.Request(
                f"{url}/rest/v1/{table}?select=*",
                method="GET",
                headers={"apikey": key, "Authorization": f"Bearer {key}",
                         "Accept": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                if resp.status != 200:
                    return None
                raw = resp.read().decode()
                return json.loads(raw) if raw else []
        except Exception:
            return None

    def _ensure_bucket(self, url, key):
        """Create the private bucket if missing. Already-exists errors are fine
        — the upload below is the real test."""
        try:
            body = json.dumps({"id": BUCKET, "name": BUCKET, "public": False}).encode()
            req = urllib.request.Request(
                f"{url}/storage/v1/bucket", data=body, method="POST",
                headers={"apikey": key, "Authorization": f"Bearer {key}",
                         "Content-Type": "application/json"},
            )
            urllib.request.urlopen(req, timeout=HTTP_TIMEOUT).read()
        except Exception:
            pass

    def _storage_put(self, url, key, path, body):
        """Upsert one object into the bucket. Returns True on success."""
        try:
            req = urllib.request.Request(
                f"{url}/storage/v1/object/{BUCKET}/{path}",
                data=body, method="POST",
                headers={"apikey": key, "Authorization": f"Bearer {key}",
                         "Content-Type": "application/json", "x-upsert": "true"},
            )
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                return resp.status in (200, 201)
        except Exception:
            return False

    # ---- I/O ----

    def _json(self, code, payload):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode())
