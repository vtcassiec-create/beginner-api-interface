#!/usr/bin/env bash
# Signal Bridge — credential check (VISIBLE prompts, on purpose).
#
#   bash lc.sh
#
# Tests your username/password straight against the relay on
# localhost (no phone app, no network, no Caddy in the way). The
# prompts are intentionally visible so a silent typo can't hide.
# Run on your own droplet console where only you can see the screen.

set -euo pipefail
API="http://localhost:8420"

echo "Enter your credentials. They are shown on screen ON PURPOSE so"
echo "you can confirm exactly what you type (you're alone on your"
echo "own server console)."
echo
read -rp "Username: " U
read -rp "Password (visible): " P

JF="$(mktemp)"; OUT="$(mktemp)"
trap 'rm -f "$JF" "$OUT"' EXIT
printf '{"username":"%s","password":"%s"}' "$U" "$P" > "$JF"

CODE="$(curl -s -o "$OUT" -w '%{http_code}' \
  -H 'content-type: application/json' -d @"$JF" \
  "$API/auth/login" || true)"

echo
echo "HTTP $CODE"
if [ "$CODE" = "200" ] && grep -q 'access_token' "$OUT" 2>/dev/null; then
  echo "RESULT: SUCCESS — these exact credentials are correct."
  echo "(So any app problem is connection/config, not your password.)"
else
  echo "RESULT: FAIL — server reachable, but it rejected these creds."
  echo "Most likely a typo when you registered. Server said:"
  head -c 300 "$OUT"; echo
fi
