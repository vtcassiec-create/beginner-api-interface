#!/usr/bin/env bash
# Signal Bridge — verify the token-authenticated /mcp endpoint.
#
#   bash v.sh
#
# Prompts (hidden) for your JWT, then does a real MCP "initialize"
# against https://precipice-sb-7xq.duckdns.org/mcp with that token as
# a Bearer header — exactly the path Petrichor's connector will use.
# The token is never printed and never leaves this server. The
# response printed is just the server's MCP handshake (no secret).

set -euo pipefail

URL="https://precipice-sb-7xq.duckdns.org/mcp"

read -rsp "Paste your Signal Bridge token (hidden, then Enter): " TOK
echo
echo
echo "==> Calling initialize on the token-authenticated endpoint..."

RESP="$(curl -sS --max-time 25 -X POST "$URL" \
  -H "Authorization: Bearer ${TOK}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify","version":"0.1"}}}' || true)"

echo "----- server response (no secret in here) -----"
printf '%s\n' "$RESP" | head -c 700
echo
echo "-----------------------------------------------"
if printf '%s' "$RESP" | grep -q '"serverInfo"'; then
  echo "RESULT: SUCCESS — token works, /mcp speaks MCP. Petrichor can use this."
else
  echo "RESULT: NOT YET — show the assistant the response above (no token in it)."
fi
