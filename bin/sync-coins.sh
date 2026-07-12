#!/usr/bin/env bash
#
# Copyright © 2025–2026 Dankest, LLC
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Sync the canonical coin registry from xchain-hub/src/coins (the platform-wide
# source of truth) into each consuming service's vendored src/coins copy. The
# services build into independent containers without sibling repos, so each
# bundles its own byte-identical copy; this script (run by the release pipeline)
# keeps them in sync.
#
# Usage:
#   sync-coins.sh           Copy canonical -> every service (overwrites vendored copies).
#   sync-coins.sh --check   Verify every vendored copy is byte-identical; exit 1 on drift.
#                           Use in CI so a drifted/forgotten vendored copy fails the build.
#   sync-coins.sh --check --only <svc> [<svc> ...]
#                           Scope the check to the named service(s). For a consumer
#                           repo's own GitHub CI, where only that consumer and this
#                           canonical checkout exist side by side (the full-fleet
#                           check stays the default for the monorepo bin/ci-all.sh).
#
set -euo pipefail

# Repo root is two levels up from this script (xchain-hub/bin -> xchain-hub -> root).
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/../src/coins"
ROOT="$(cd "$HERE/../.." && pwd)"

FILES="BTC.js LTC.js DOGE.js index.js consensus_pin.js"
SERVICES="xchain-indexer xchain-explorer xchain-decoder xchain-encoder xchain-utxo-tracker xchain-sdk xchain-sync xchain-node"

CHECK=0
ONLY=""
while [ $# -gt 0 ]; do
    case "$1" in
        --check) CHECK=1; shift ;;
        --only)  shift; ONLY="$*"; break ;;
        *) echo "unknown arg: $1" >&2; exit 2 ;;
    esac
done
if [ -n "$ONLY" ]; then
    for svc in $ONLY; do
        case " $SERVICES " in
            *" $svc "*) ;;
            *) echo "unknown service: $svc (not a coin-registry consumer)" >&2; exit 2 ;;
        esac
    done
    SERVICES="$ONLY"
fi

drift=0
for svc in $SERVICES; do
    dest="$ROOT/$svc/src/coins"
    for f in $FILES; do
        if [ "$CHECK" -eq 1 ]; then
            if ! cmp -s "$SRC/$f" "$dest/$f"; then
                echo "DRIFT: $svc/src/coins/$f differs from canonical xchain-hub/src/coins/$f"
                drift=1
            fi
        else
            mkdir -p "$dest"
            cp "$SRC/$f" "$dest/$f"
        fi
    done
done

if [ "$CHECK" -eq 1 ]; then
    [ "$drift" -eq 0 ] && echo "OK: all vendored coin copies are byte-identical to canonical." || exit 1
else
    echo "Synced canonical coins into: $SERVICES"
fi
