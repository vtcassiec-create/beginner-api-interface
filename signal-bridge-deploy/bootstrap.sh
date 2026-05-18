#!/usr/bin/env bash
# Signal Bridge — self-host bootstrap for a fresh Ubuntu droplet.
#
# Usage:  bash b.sh your-subdomain.duckdns.org
#
# What it does (all on YOUR server, nothing hidden):
#   1. installs git
#   2. clones the signal_bridge_remote repo
#   3. writes a .env with a freshly generated secret key
#   4. builds & starts Signal Bridge via the repo's own docker compose
#   5. runs Caddy (in Docker) for automatic HTTPS on your domain
#   6. health-checks it
#
# Safety-relevant defaults: registration starts OPEN so you can make
# your one account, then you lock it (separate step). Token expiry is
# set long (1 year) so Petrichor's token doesn't keep dying — you can
# change SB_TOKEN_EXPIRY_HOURS later, and rotating SB_SECRET_KEY kills
# all tokens instantly if ever needed.

set -euo pipefail

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  echo "Usage: bash b.sh your-subdomain.duckdns.org"
  exit 1
fi

echo "==> [1/6] Installing git"
apt-get update -y
apt-get install -y git

echo "==> [2/6] Cloning signal_bridge_remote"
cd /root
rm -rf sbr
git clone https://github.com/AletheiaVox/signal_bridge_remote sbr
cd sbr

echo "==> [3/6] Writing .env (with a fresh secret key)"
SECRET="$(openssl rand -hex 32)"
cat > .env <<EOF
SB_SECRET_KEY=$SECRET
SB_HOST=0.0.0.0
SB_PORT=8420
SB_REGISTRATION_OPEN=true
SB_TOKEN_EXPIRY_HOURS=8760
SB_HEARTBEAT_INTERVAL=2.0
SB_HEARTBEAT_TIMEOUT=6.0
SB_BAN_THRESHOLD=20
SB_BAN_DURATION_MINUTES=30
EOF

echo "==> [4/6] Building & starting Signal Bridge"
docker compose up -d --build

echo "==> [5/6] Writing Caddyfile + starting Caddy (auto-HTTPS)"
cat > /root/Caddyfile <<EOF
$DOMAIN {
    reverse_proxy localhost:8420
}
EOF
docker rm -f caddy 2>/dev/null || true
docker run -d --name caddy --restart unless-stopped --network host \
  -v /root/Caddyfile:/etc/caddy/Caddyfile \
  -v caddy_data:/data \
  -v caddy_config:/config \
  caddy:2

echo "==> [6/6] Waiting a moment, then health check..."
sleep 6
echo "--- local health (expect JSON) ---"
curl -s http://localhost:8420/health || true
echo
echo
echo "Bootstrap finished."
echo "Next: register your account, then lock registration, then get a token."
echo "Your HTTPS endpoint will be: https://$DOMAIN/mcp"
echo "(Caddy may take 30-60s to obtain the certificate the first time.)"
