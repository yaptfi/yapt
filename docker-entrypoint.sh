#!/bin/sh
set -eu

echo "Starting Yapt services..."

# Defaults
: "${SERVE_FRONTEND:=true}"
: "${FRONTEND_PORT:=8080}"

# Ensure working dir is project root inside image
cd /app

# Start backend API
echo "Starting API on :3000"
node dist/index.js &
API_PID=$!

# Optionally start frontend static server
FRONT_PID=""
if [ "$SERVE_FRONTEND" = "true" ] || [ "$SERVE_FRONTEND" = "1" ]; then
  echo "Starting Frontend on :${FRONTEND_PORT}"
  PORT="$FRONTEND_PORT" node frontend/server.js &
  FRONT_PID=$!
else
  echo "SERVE_FRONTEND is disabled; not starting frontend server"
fi

term_handler() {
  echo "Signal received, shutting down..."
  if [ -n "$FRONT_PID" ] && kill -0 "$FRONT_PID" 2>/dev/null; then
    kill "$FRONT_PID" 2>/dev/null || true
  fi
  if kill -0 "$API_PID" 2>/dev/null; then
    kill "$API_PID" 2>/dev/null || true
  fi
}

trap term_handler INT TERM

# Wait for API process; if it exits, stop frontend too
wait "$API_PID"
STATUS=$?

if [ -n "$FRONT_PID" ] && kill -0 "$FRONT_PID" 2>/dev/null; then
  echo "API exited; stopping frontend..."
  kill "$FRONT_PID" 2>/dev/null || true
  wait "$FRONT_PID" 2>/dev/null || true
fi

exit "$STATUS"
