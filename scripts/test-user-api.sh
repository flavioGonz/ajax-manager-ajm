#!/bin/bash
# Smoke test del User API de Ajax (login + hubs).
# Usage:
#   bash test-user-api.sh
# Pide email y password por stdin, NO los echo, NO los deja en historial.
set -e
read -p "Ajax email: " EMAIL
read -s -p "Ajax password: " PASS
echo
APIKEY=$(grep ^X_API_KEY= /opt/ajax-manager/.env | cut -d= -f2)
HASH=$(echo -n "$PASS" | sha256sum | cut -d" " -f1)
echo
echo "=== POST /login ==="
RESP=$(curl -s -X POST -H "Content-Type: application/json" -H "X-Api-Key: $APIKEY" -d "{\"login\":\"$EMAIL\",\"passwordHash\":\"$HASH\"}" https://api.ajax.systems/api/login)
echo "$RESP" | python3 -m json.tool 2>/dev/null | head -20 || echo "$RESP"
SESS=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get(\"sessionToken\",\"\"))" 2>/dev/null)
USERID=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get(\"userId\",\"\"))" 2>/dev/null)
if [ -z "$SESS" ]; then
  echo
  echo "FALLO: no se obtuvo sessionToken. Ver respuesta arriba."
  exit 1
fi
echo
echo "OK login. userId=$USERID  sessionToken=${SESS:0:8}...${SESS: -4}"
echo
echo "=== GET /user/$USERID/hubs ==="
curl -s -H "X-Api-Key: $APIKEY" -H "X-Session-Token: $SESS" "https://api.ajax.systems/api/user/$USERID/hubs" | python3 -m json.tool | head -80
echo
echo "=== GET /user/$USERID/spaces ==="
curl -s -H "X-Api-Key: $APIKEY" -H "X-Session-Token: $SESS" "https://api.ajax.systems/api/user/$USERID/spaces" | python3 -m json.tool | head -40
