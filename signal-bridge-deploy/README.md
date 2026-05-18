# signal-bridge-deploy

A one-shot bootstrap for self-hosting **Signal Bridge** (the
`AletheiaVox/signal_bridge_remote` relay) on a fresh Ubuntu VPS, so it
can be reached by Petrichor's MCP connector behind a per-project
toggle. This is **separate infrastructure** — not part of the Petrichor
web app; it lives here only so it deploys via a short `curl` instead of
pasting long commands into a browser console.

## Why

The upstream README's deploy is ~a dozen long shell commands (Caddy apt
repo setup, tar/scp, etc.) — fragile to paste into a VPS web console.
`bootstrap.sh` collapses it to: download, run with your domain.

## What it does (nothing hidden — read the script)

1. installs `git`
2. clones `signal_bridge_remote`
3. writes `.env` with a freshly generated `SB_SECRET_KEY`
   (`SB_REGISTRATION_OPEN=true` initially; `SB_TOKEN_EXPIRY_HOURS=8760`)
4. `docker compose up -d --build` (the repo's own compose/Dockerfile)
5. runs **Caddy** in Docker (host network) for automatic Let's Encrypt
   HTTPS, reverse-proxying `https://<domain>/` → `localhost:8420`
6. health-checks `:8420/health`

## Run (on the droplet, after DuckDNS points at it)

```
B=https://raw.githubusercontent.com
R=/vtcassiec-create/beginner-api-interface
P=/main/signal-bridge-deploy/bootstrap.sh
curl -fsSL "$B$R$P" -o b.sh
bash b.sh your-subdomain.duckdns.org
```

## After bootstrap (manual, deliberate)

- Register your single account (`POST /auth/register`).
- Set `SB_REGISTRATION_OPEN=false` in `/root/sbr/.env`, then
  `cd /root/sbr && docker compose up -d` to lock registration.
- Get your JWT (`POST /auth/login`) — this is the bearer token
  Petrichor's connector will use against `https://<domain>/mcp`.
- Point the phone relay client + Intiface at `wss://<domain>/ws/phone`
  with that token.

## Safety

Emergency-stop, dead-man's switch, duration auto-stop, rate limiting
and IP banning are all enforced server-side in the relay regardless of
which LLM drives it. The Petrichor side adds its own fault-isolation
and keeps `stop` first-class. Never use the authless fallback mode for
a real device.
