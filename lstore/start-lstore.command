#!/bin/sh
cd "$(dirname "$0")" || exit 1

if curl --silent --fail http://127.0.0.1:3000/api/apps >/dev/null 2>&1; then
  open http://localhost:3000
  echo "LStore is already running at http://localhost:3000"
  exit 0
fi

node server.js &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT INT TERM

attempt=0
until curl --silent --fail http://127.0.0.1:3000/api/apps >/dev/null 2>&1; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    wait "$SERVER_PID"
    exit 1
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 20 ]; then
    echo "LStore did not start within 10 seconds." >&2
    exit 1
  fi
  sleep 0.5
done

open http://localhost:3000
echo "LStore is running. Leave this Terminal window open while Eddy checks for updates."
wait "$SERVER_PID"
