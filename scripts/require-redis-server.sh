#!/usr/bin/env bash
# Fail unless redis-server is installed and can accept a connection.
# A missing binary is an error. This script does not skip.
set -euo pipefail

if ! command -v redis-server >/dev/null 2>&1; then
  echo "redis-server is not installed or not on PATH" >&2
  exit 1
fi
if ! command -v redis-cli >/dev/null 2>&1; then
  echo "redis-cli is not installed or not on PATH" >&2
  exit 1
fi

version="$(redis-server --version)"
printf '%s\n' "$version"
if ! printf '%s\n' "$version" | grep -Eq 'v=([7-9]|[1-9][0-9]+)\.'; then
  echo "redis-server must be version 7 or newer so PXAT and EXPIRETIME exist" >&2
  exit 1
fi

port=6399
pidfile="$(mktemp)"
logfile="$(mktemp)"
datadir="$(mktemp -d)"
cleanup() {
  if command -v redis-cli >/dev/null 2>&1; then
    redis-cli -p "$port" SHUTDOWN NOSAVE >/dev/null 2>&1 || true
  fi
  if [[ -f "$pidfile" ]]; then
    pid="$(cat "$pidfile" 2>/dev/null || true)"
    if [[ -n "${pid}" ]]; then
      kill "$pid" 2>/dev/null || true
    fi
  fi
  rm -rf "$pidfile" "$logfile" "$datadir"
}
trap cleanup EXIT

redis-server \
  --port "$port" \
  --bind 127.0.0.1 \
  --protected-mode yes \
  --daemonize yes \
  --pidfile "$pidfile" \
  --logfile "$logfile" \
  --dir "$datadir" \
  --save '' \
  --appendonly no

ready=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if redis-cli -p "$port" PING 2>/dev/null | grep -q PONG; then
    ready=1
    break
  fi
  sleep 0.1
done

if [[ "$ready" -ne 1 ]]; then
  echo "redis-server did not accept connections" >&2
  echo "--- logfile ---" >&2
  cat "$logfile" >&2 || true
  exit 1
fi

echo "redis-server is runnable"
