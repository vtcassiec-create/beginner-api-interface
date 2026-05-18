# Whisper server — upgraded `index.ts`

This is the upgraded entry file for the **separate** `obsidian-mcp-server`
that runs on the DigitalOcean droplet (`whisper.service`) and serves the
`precipice` Obsidian vault. It is **not** part of the Petrichor web app —
it lives here only so it's version-controlled and deployable without
pasting long blocks into a browser console.

## What changed vs. the original

Adds a modern **Streamable HTTP** MCP transport (`/mcp-<SECRET>`)
*alongside* the existing legacy HTTP+SSE routes (`/sse-<SECRET>` /
`/messages-<SECRET>`), which are left byte-for-byte unchanged.

- **claude.ai** keeps using the legacy `/sse-…` route — untouched.
- **Petrichor** (Anthropic API MCP connector) uses the new
  `/mcp-…` route, which is what it requires.
- Server creation was factored into `buildServer()` so the stateless
  Streamable endpoint can use a fresh server per request (also removes
  the original single-global-connection limitation).

No secrets here: the auth secret comes from `AUTH_TOKEN` in the
droplet's systemd unit, never from this file.

## Deploy onto the droplet

From the droplet console, with the original backed up
(`src/index.ts.bak`):

```
curl -fsSL https://raw.githubusercontent.com/vtcassiec-create/beginner-api-interface/main/whisper-server/index.ts -o ~/obsidian-mcp-server/src/index.ts
cd ~/obsidian-mcp-server && npm run build
systemctl restart whisper
```

Then point Petrichor's `WHISPER_MCP_URL` at the new path:
`https://petrichor-whisper.duckdns.org/mcp-<SECRET>` (was `/sse-<SECRET>`).

Revert if needed: `cp ~/obsidian-mcp-server/src/index.ts.bak
~/obsidian-mcp-server/src/index.ts && cd ~/obsidian-mcp-server && npm
run build && systemctl restart whisper`.
