#!/usr/bin/env bash
#*********************************************************************
#
# Copyright © 2025-2026 Dankest, LLC
# Based on XChain Platform by Dankest, LLC - https://dankest.llc
#
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# This file is part of XChain Platform. Licensed under the GNU Affero
# General Public License v3.0 or later; see LICENSE.md. A commercial
# license (without AGPL source-disclosure terms) is available -
# contact legal@dankest.llc.
#
#*********************************************************************

#
# Vendor the shared observability module  into the sibling services.
#
# Every xchain-* service is an independent repo with its own package.json, so a
# shared /metrics exporter cannot be an internal npm dependency without a
# publish step and six lockfile bumps. Instead xchain-hub/src/observability/ is
# CANONICAL and this script copies it verbatim into each consumer. Copies are
# byte-identical by construction; bin/check-observability-parity.js at the
# platform root fails on drift.
#
# Usage:
#   bin/sync-observability.sh            copy canonical -> every sibling found
#   bin/sync-observability.sh --check    report drift only, exit 1 if any
#
# Sibling roots resolve from the platform checkout (../<service>); override the
# search root with XCHAIN_PLATFORM_ROOT.
#

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HUB_ROOT="$(cd "$HERE/.." && pwd)"
PLATFORM_ROOT="${XCHAIN_PLATFORM_ROOT:-$(cd "$HUB_ROOT/.." && pwd)}"

SRC_DIR="$HUB_ROOT/src/observability"
FILES=(metrics.js logShipper.js index.js README.md)

CONSUMERS=(xchain-indexer xchain-decoder xchain-encoder xchain-utxo-tracker xchain-explorer)

CHECK_ONLY=0
if [[ "${1:-}" == "--check" ]]; then CHECK_ONLY=1; fi

if [[ ! -d "$SRC_DIR" ]]; then
    echo "FATAL: canonical module missing at $SRC_DIR" >&2
    exit 2
fi

drift=0
copied=0
skipped=0

for consumer in "${CONSUMERS[@]}"; do
    dest_root="$PLATFORM_ROOT/$consumer"
    if [[ ! -d "$dest_root/src" ]]; then
        echo "skip   $consumer (no checkout at $dest_root)"
        skipped=$((skipped + 1))
        continue
    fi
    dest_dir="$dest_root/src/observability"
    for f in "${FILES[@]}"; do
        src="$SRC_DIR/$f"
        dst="$dest_dir/$f"
        if [[ $CHECK_ONLY -eq 1 ]]; then
            if [[ ! -f "$dst" ]] || ! cmp -s "$src" "$dst"; then
                echo "DRIFT  $consumer/src/observability/$f"
                drift=$((drift + 1))
            fi
        else
            mkdir -p "$dest_dir"
            if [[ -f "$dst" ]] && cmp -s "$src" "$dst"; then
                continue
            fi
            cp "$src" "$dst"
            echo "copied $consumer/src/observability/$f"
            copied=$((copied + 1))
        fi
    done
done

if [[ $CHECK_ONLY -eq 1 ]]; then
    if [[ $drift -gt 0 ]]; then
        echo "FAIL: $drift vendored file(s) drifted from xchain-hub/src/observability" >&2
        exit 1
    fi
    echo "OK: vendored observability copies match the canonical module"
    exit 0
fi

echo "done: $copied file(s) updated, $skipped consumer(s) skipped"
