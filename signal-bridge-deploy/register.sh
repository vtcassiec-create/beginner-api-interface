#!/usr/bin/env bash
# Signal Bridge — one-time account registration + token fetch.
# Run on the signal-bridge droplet AFTER bootstrap.sh succeeded.
#
#   bash reg.sh
#
# Prompts for a username/password (password is hidden, never stored in
# shell history or argv), registers the single account, then logs in
# and prints your JWT token. That token is a SECRET — copy it straight
# into Vercel / the phone relay later; do NOT paste it into chat.

set -euo pipefail

API="http://localhost:8420"

read -rp "Choose a username: " SB_U
read -rsp "Choose a password: " SB_P
echo

JF="$(mktemp)"
trap 'rm -f "$JF"' EXIT
printf '{"username":"%s","password":"%s"}' "$SB_U" "$SB_P" > "$JF"

echo
echo "==> Registering account..."
curl -s -H "content-type: application/json" -d @"$JF" "$API/auth/register"
echo
echo "==> Logging in for your token..."
curl -s -H "content-type: application/json" -d @"$JF" "$API/auth/login"
echo
echo
echo "-----------------------------------------------------------"
echo "Look above for the token (the long 'access_token' value)."
echo "It is a SECRET. Copy it somewhere safe."
echo "Do NOT paste the token into chat — it goes into Vercel and"
echo "the phone relay directly. Tell the assistant only that it"
echo "worked, not the value."
echo "-----------------------------------------------------------"
