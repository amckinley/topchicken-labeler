#!/bin/bash
# Render config from env, start the bsky-watch labeler, then run our poller.
set -eu

: "${LABELER_DID:?LABELER_DID required}"
: "${SIGNING_KEY:?SIGNING_KEY required}"
: "${BSKY_APP_PASSWORD:?BSKY_APP_PASSWORD required}"
: "${LABELER_ENDPOINT:?LABELER_ENDPOINT required}"

DB_PATH="${DB_PATH:-${RAILWAY_VOLUME_MOUNT_PATH:-/data}/labels.sqlite}"
PORT="${PORT:-8080}"        # public: queryLabels + subscribeLabels (Railway sets PORT)
ADMIN_PORT="${ADMIN_PORT:-8081}"  # localhost-only: POST /label

mkdir -p "$(dirname "$DB_PATH")"

# Substitute env into the config template (no secrets in the repo).
sed \
  -e "s|__DB_PATH__|${DB_PATH}|g" \
  -e "s|__SIGNING_KEY__|${SIGNING_KEY}|g" \
  -e "s|__LABELER_DID__|${LABELER_DID}|g" \
  -e "s|__BSKY_APP_PASSWORD__|${BSKY_APP_PASSWORD}|g" \
  -e "s|__LABELER_ENDPOINT__|${LABELER_ENDPOINT}|g" \
  /app/config.template.yaml > /app/config.yaml

echo "starting bsky-watch labeler: public=:${PORT} admin=:${ADMIN_PORT} db=${DB_PATH}"
/app/labeler \
  --config=/app/config.yaml \
  --listen-addr=":${PORT}" \
  --admin-addr="127.0.0.1:${ADMIN_PORT}" \
  --log-level=0 &
LABELER_PID=$!

# Stop the whole container if the labeler dies.
trap 'kill "$LABELER_PID" 2>/dev/null || true' INT TERM

# Wait for the admin API to accept connections before starting the poller.
echo "waiting for admin API..."
for _ in $(seq 1 60); do
  if wget -q -O /dev/null --post-data='{}' "http://127.0.0.1:${ADMIN_PORT}/label" 2>/dev/null \
     || nc -z 127.0.0.1 "${ADMIN_PORT}" 2>/dev/null; then
    break
  fi
  sleep 1
done

echo "starting poller"
ADMIN_URL="http://127.0.0.1:${ADMIN_PORT}/label" python3 /app/poller.py &
POLLER_PID=$!

# Exit when either process exits.
wait -n "$LABELER_PID" "$POLLER_PID"
