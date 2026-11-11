#!/usr/bin/env bash
# Boots the built server in dry-run with a temp STATE_FILE, checks /health and /admin/status.json, stops it with SIGTERM.
set -euo pipefail
DIR=$(mktemp -d)
PORT=${SMOKE_PORT:-18080}
STATE_FILE="$DIR/state.json" PORT=$PORT DRY_RUN=true AGENT_MODE=stub ADMIN_SECRET=smoke node dist/server.js > "$DIR/log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$PORT/health" > "$DIR/health.json"; then break; fi
  sleep 0.5
done
grep -q '"ok":true' "$DIR/health.json" || { echo "health failed"; cat "$DIR/log"; exit 1; }
curl -sf -H "Authorization: Bearer smoke" "http://127.0.0.1:$PORT/admin/status.json" | grep -q '"functions"' || { echo "status failed"; exit 1; }
kill -TERM $PID
for i in $(seq 1 20); do kill -0 $PID 2>/dev/null || break; sleep 0.25; done
if kill -0 $PID 2>/dev/null; then echo "did not stop on SIGTERM"; exit 1; fi
trap - EXIT
echo "smoke ok: boots, /health 200, status.json, clean SIGTERM stop"
