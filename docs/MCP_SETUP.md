# Cross-Surface Memory via MCP — Setup (Layer 5, Part B)

Petrichor's knowledge graph lives in the Supabase table
`claude_memory_entities`. The app reads/writes it as *you* (your login's
JWT, row-level-security scoped). **Part B** adds a second door: the
official **Supabase MCP server**, so Claude on *other* surfaces
(Claude Code, Desktop, claude.ai) can read/write the **same** table —
one memory store across every surface.

> Honest note: the tutorial says "Memory MCP server." The well-known
> reference memory MCP stores a *local JSON file* and would NOT sync to
> this Supabase table — it'd be a parallel, separate memory. To get
> genuine cross-platform memory *in the table we built*, the right tool
> is the **Supabase MCP server** operating on `claude_memory_entities`.
> Same goal, accurate mechanism.

---

## Architecture

```
Petrichor (app) ──── anon key + your JWT  ─┐
Claude Code     ─┐                          ├──► Supabase
Claude Desktop  ─┼─ Supabase MCP server ───┘    public.claude_memory_entities
claude.ai       ─┘   (Personal Access Token,         + the surfacing RPCs
                      elevated → bypasses RLS)
```

The app door is RLS-scoped. The MCP door is **elevated** (acts like a
service role, bypasses RLS) — which is why writes through it MUST set
`user_id` explicitly (see Stage 2).

---

## Prerequisites (gather once)

1. **Project ref** — from `SUPABASE_URL` (`https://<REF>.supabase.co`),
   the `<REF>` part.
2. **Supabase Personal Access Token (PAT)** — Supabase dashboard →
   account menu → **Account → Access Tokens** →
   <https://supabase.com/dashboard/account/tokens> → *Generate new
   token*. Name it e.g. `petrichor-mcp`. **Copy it once; it's shown
   once.**
   - ⚠️ A PAT is **account-level** (it can manage *all* your Supabase
     projects). Treat it like a password. Never commit it. If it leaks,
     revoke + regenerate immediately. We mitigate with `--project-ref`
     (pin to this project) and `--read-only` (Stage 1).
3. **Your auth user UUID** (needed in Stage 2) — Supabase dashboard →
   **Authentication → Users** → your row → copy the `UID`/`id`.

---

## Stage 1 — Read-only, on Claude Code (validate first)

Zero write risk. Proves the loop before granting any write power.

Run this in **your own terminal** (not pasted into a chat — it contains
your token):

```bash
claude mcp add supabase \
  --scope user \
  --env SUPABASE_ACCESS_TOKEN=<YOUR_PAT> \
  -- npx -y @supabase/mcp-server-supabase@latest \
       --read-only \
       --project-ref=<YOUR_PROJECT_REF>
```

- `--scope user` makes it available in all your Claude Code projects
  (drop it for current-project-only).
- `--read-only` — the MCP can read but cannot modify anything.
- `--project-ref` — pins access to this one project.

**Verify:**

1. In Claude Code, run `/mcp` — `supabase` should show as connected.
2. Ask Claude:
   > "Using the Supabase MCP, list the rows in
   > `public.claude_memory_entities` — name, entity_type,
   > observations."
3. You should see the entities you added in Petrichor's
   Knowledge-graph panel. Same store, second surface. ✅

If it can read them, Stage 1 is done.

---

## Stage 2 — Enable writes + the memory protocol

Only after Stage 1 works.

1. Re-add the server **without** `--read-only`:

   ```bash
   claude mcp remove supabase
   claude mcp add supabase \
     --scope user \
     --env SUPABASE_ACCESS_TOKEN=<YOUR_PAT> \
     -- npx -y @supabase/mcp-server-supabase@latest \
          --project-ref=<YOUR_PROJECT_REF>
   ```

2. Give the other-surface Claude this **memory protocol** (paste into
   its project / system instructions, with your UUID filled in). This
   is the glue — an MCP connection alone is inert without it:

   > **Petrichor shared-memory protocol.** You have a Supabase MCP
   > tool. The cross-surface knowledge graph is
   > `public.claude_memory_entities`. The MCP bypasses row-level
   > security, so you MUST scope every operation to
   > `user_id = '<YOUR_USER_UUID>'` — never read or write rows without
   > it.
   >
   > - **Recall:** `select name, entity_type, observations from
   >   claude_memory_entities where user_id = '<YOUR_USER_UUID>'
   >   order by (entity_type = 'identity') desc, access_count desc`.
   > - **Store new:** insert with `user_id = '<YOUR_USER_UUID>'`,
   >   `created_by = '<surface name, e.g. claude-code>'`. `entity_type`
   >   ∈ {person, project, identity, insight, pattern, milestone,
   >   creative work, advocacy effort, research project}.
   > - **`name` is unique per user.** If an entity with that name
   >   exists, **append** to its `observations` jsonb array rather than
   >   inserting a duplicate.
   > - Keep observations short and factual; this store is shared with
   >   the user and surfaces into every Petrichor chat.

3. **Verify the loop:** have the other Claude create an entity, then
   open Petrichor → 🧠 Memories → Knowledge graph. It should appear
   (because `user_id` matched). Send a Petrichor chat and confirm it
   surfaces.

---

## Other surfaces (later)

- **Claude Desktop:** same server, configured in its MCP settings JSON
  (`command: npx`, `args: [...]`, `env: { SUPABASE_ACCESS_TOKEN }`),
  restart the app. Test in Desktop.
- **claude.ai (web/mobile):** requires a *hosted* MCP endpoint + OAuth
  (Connectors) — the local `npx` approach doesn't apply. Significantly
  more setup; tackle last.

---

## Security checklist

- [ ] PAT pinned with `--project-ref`, never committed, kept in env.
- [ ] Started in `--read-only`; writes enabled only after Stage 1.
- [ ] Memory protocol forces `user_id` scoping on every operation.
- [ ] If the PAT is ever exposed: revoke at the Access Tokens page and
      regenerate.
