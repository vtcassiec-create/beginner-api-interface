"""
Bring back a deleted project from the nightly backups.

Deleting a project cascades: its conversations, manuscript documents and
manuscript stories go with it. But api/backup.py has been writing a full copy
of every table to the private `soul-backups` bucket each night
(`auto/backup-DD.json`), so the rows still exist there. This endpoint finds
projects that are in a backup but no longer in the live tables, and puts them
back exactly as they were (same ids, same messages).

It only ever ADDS rows. Every insert is "on conflict do nothing", so a restore
can never overwrite or roll back anything that's live, and running it twice is
harmless.

Authentication mirrors api/chat.py: a Supabase access token in the
Authorization header, verified against /auth/v1/user. Only her own rows (by
user_id) are ever looked at or restored.

Request body (POST JSON):
  action     — "scan" | "restore"
  project_id — (restore) the deleted project's id, from scan
  backup     — (restore) the backup file name, from scan

Required environment variables:
  SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
"""

from http.server import BaseHTTPRequestHandler
from urllib.parse import urlsplit
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

HTTP_TIMEOUT = 25
BUCKET = "soul-backups"
MAX_BACKUPS_SCANNED = 4
INSERT_CHUNK = 15
BACKUP_NAME = re.compile(r"^backup-\d{2}\.json$")

# The tables that hang off a project (ON DELETE CASCADE), in insert order:
# stories before documents, because documents may point at a story.
CHILD_TABLES = ["manuscript_stories", "manuscript_documents", "conversations"]


def _normalize_url(raw):
    """scheme://host[:port] from SUPABASE_URL (kept in sync with the others)."""
    raw = (raw or "").strip()
    if not raw:
        return ""
    parts = urlsplit(raw)
    if parts.scheme and parts.netloc:
        return f"{parts.scheme}://{parts.netloc}"
    return raw.split("/", 1)[0]


class _Fail(Exception):
    pass


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        uid = self._verify_auth()
        if not uid:
            return self._json(401, {"error": "unauthorized"})
        self.url = _normalize_url(os.environ.get("SUPABASE_URL", ""))
        self.key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        if not self.url or not self.key:
            return self._json(500, {"error": "Supabase not configured"})
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
            body = json.loads(self.rfile.read(length).decode()) if length else {}
        except Exception:
            return self._json(400, {"error": "bad request body"})

        try:
            action = str(body.get("action") or "")
            if action == "scan":
                return self._json(200, self._scan(uid))
            if action == "restore":
                return self._json(200, self._restore(uid, str(body.get("project_id") or ""),
                                                     str(body.get("backup") or "")))
            return self._json(400, {"error": "unknown action"})
        except _Fail as e:
            return self._json(502, {"error": str(e)})

    # ---- scan: which projects exist in a backup but not live? ----

    def _scan(self, uid):
        live = self._rest("GET", f"projects?user_id=eq.{uid}&select=id")
        live_ids = {r["id"] for r in (live or [])}

        backups = self._list_backups()
        found = {}  # project id -> newest backup that holds it
        scanned = []
        for b in backups[:MAX_BACKUPS_SCANNED]:
            data = self._download(b["name"])
            scanned.append({"name": b["name"], "at": data.get("exportedAt") or b.get("updated_at")})
            tables = data.get("data") or {}
            projects = tables.get("projects")
            convs = tables.get("conversations")
            if not isinstance(projects, list):
                continue
            for p in projects:
                pid = p.get("id")
                if p.get("user_id") != uid or pid in live_ids or pid in found:
                    continue
                conv_rows = [c for c in (convs if isinstance(convs, list) else [])
                             if c.get("project_id") == pid]
                found[pid] = {
                    "project_id": pid,
                    "name": p.get("name") or "Untitled project",
                    "backup": b["name"],
                    "backup_at": data.get("exportedAt") or b.get("updated_at"),
                    "conversations": len(conv_rows),
                    "messages": sum(len(c.get("messages") or []) for c in conv_rows),
                }
        return {"ok": True, "deleted": list(found.values()), "scanned": scanned,
                "backups_available": len(backups)}

    # ---- restore one project, adding rows only ----

    def _restore(self, uid, pid, name):
        if not pid or not BACKUP_NAME.match(name):
            raise _Fail("missing project or backup")
        tables = (self._download(f"auto/{name}").get("data") or {})
        project = next((p for p in (tables.get("projects") or [])
                        if p.get("id") == pid and p.get("user_id") == uid), None)
        if not project:
            raise _Fail("that project isn't in that backup")

        counts = {"projects": self._insert("projects", [project])}
        for t in CHILD_TABLES:
            rows = tables.get(t)
            if not isinstance(rows, list):
                counts[t] = 0
                continue
            mine = [r for r in rows if r.get("project_id") == pid and r.get("user_id") == uid]
            counts[t] = self._insert(t, mine)
        return {"ok": True, "restored": counts, "name": project.get("name")}

    def _insert(self, table, rows):
        done = 0
        for i in range(0, len(rows), INSERT_CHUNK):
            chunk = rows[i:i + INSERT_CHUNK]
            self._rest("POST", f"{table}?on_conflict=id", chunk,
                       prefer="resolution=ignore-duplicates,return=minimal")
            done += len(chunk)
        return done

    # ---- Supabase (service role) ----

    def _headers(self, extra=None):
        h = {"apikey": self.key, "Authorization": f"Bearer {self.key}",
             "Content-Type": "application/json", "Accept": "application/json"}
        h.update(extra or {})
        return h

    def _rest(self, method, path, payload=None, prefer=None):
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(f"{self.url}/rest/v1/{path}", data=data, method=method,
                                     headers=self._headers({"Prefer": prefer} if prefer else None))
        try:
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                raw = resp.read().decode()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            detail = e.read().decode()[:300]
            raise _Fail(f"{path.split('?')[0]}: {e.code} {detail}")

    def _list_backups(self):
        body = json.dumps({"prefix": "auto/", "limit": 100,
                           "sortBy": {"column": "updated_at", "order": "desc"}}).encode()
        req = urllib.request.Request(f"{self.url}/storage/v1/object/list/{BUCKET}", data=body,
                                     method="POST", headers=self._headers())
        try:
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                items = json.loads(resp.read().decode() or "[]")
        except urllib.error.HTTPError as e:
            raise _Fail(f"couldn't list backups: {e.code}")
        items = [i for i in items if BACKUP_NAME.match(i.get("name") or "")]
        items.sort(key=lambda i: i.get("updated_at") or "", reverse=True)
        return [{"name": f"auto/{i['name']}", "updated_at": i.get("updated_at")} for i in items]

    def _download(self, path):
        req = urllib.request.Request(f"{self.url}/storage/v1/object/{BUCKET}/{path}",
                                     headers=self._headers())
        try:
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            raise _Fail(f"couldn't read {path}: {e.code}")

    # ---- auth ----

    def _verify_auth(self):
        auth = self.headers.get("Authorization", "")
        token = auth[len("Bearer "):].strip() if auth.startswith("Bearer ") else ""
        supabase_url = _normalize_url(os.environ.get("SUPABASE_URL", ""))
        anon = os.environ.get("SUPABASE_ANON_KEY", "").strip()
        if not token or not supabase_url or not anon:
            return None
        try:
            req = urllib.request.Request(f"{supabase_url}/auth/v1/user",
                                         headers={"Authorization": f"Bearer {token}", "apikey": anon})
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                if resp.status != 200:
                    return None
                return json.loads(resp.read().decode()).get("id")
        except Exception:
            return None

    # ---- I/O ----

    def _json(self, code, payload):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode())
