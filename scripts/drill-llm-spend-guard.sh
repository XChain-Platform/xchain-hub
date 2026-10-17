#!/usr/bin/env bash
# Run scripts/drill-llm-spend-guard.js inside a deployed hub container, so the
# guard is exercised on the IMAGE the hub actually runs (its src, its node, its
# node_modules), not the checkout. The drill only touches a temp dir inside the
# container: the hub's data dir and persisted spend window are left alone.
#
#   scripts/drill-llm-spend-guard.sh <ssh-host> <container> [window-ms]
#   scripts/drill-llm-spend-guard.sh <ssh-host> <hub-container>
#
# Regtest/testnet venues only; never point this at a mainnet hub.
set -euo pipefail

HOST="${1:?ssh host}"
CONTAINER="${2:?container name}"
WINDOW_MS="${3:-8000}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REMOTE_TMP="/tmp/drill-llm-spend-guard.$$.js"

# Two hops: this Mac -> the docker host -> the container.
scp -q "$HERE/drill-llm-spend-guard.js" "$HOST:$REMOTE_TMP"
ssh "$HOST" "docker cp '$REMOTE_TMP' '$CONTAINER:/tmp/drill-llm-spend-guard.js' && rm -f '$REMOTE_TMP' \
  && docker exec -e DRILL_HUB_ROOT=/XChainHub -e DRILL_WINDOW_MS='$WINDOW_MS' '$CONTAINER' \
       node /tmp/drill-llm-spend-guard.js; \
     rc=\$?; docker exec '$CONTAINER' sh -c 'rm -f /tmp/drill-llm-spend-guard.js; rm -rf /tmp/llm-spend-drill-*'; exit \$rc"
