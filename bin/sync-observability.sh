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
# Vendor the shared observability module into the sibling services.
#
# Every xchain-* service is an independent repo with its own package.json, so a
# shared /metrics exporter cannot be an internal npm dependency without a
# publish step and six lockfile bumps. Instead xchain-hub/src/observability/ is
# CANONICAL and this script copies it verbatim into each consumer. Copies are
# byte-identical by construction, and `--check` fails on any that is not.
#
# WHERE THE CHECK ACTUALLY RUNS. For its first months this script was hand-run
# only: no npm script, no workflow and no gate invoked it, so "byte-identical by
# construction" was a claim nothing measured, and the indexer's copy sat drifted
# for weeks with every suite green. It is now wired in two places that both have
# the six consumers laid out beside the hub:
#
#   - npm run check:observability-sync, which bin/ci-full.sh runs as a drift
#     tier, so the pre-push venue gate reddens before the push, and
#   - the drift-guards job of .github/workflows/ci.yml, so GitHub reddens too.
#
# A MISSING consumer checkout is a FAILURE in --check, not a skip. Skipping is
# how a cross-repo guard reports green having compared nothing: the gates above
# run where all six are present, so absence there means the layout broke, not
# that there is less to check. Hand runs on a partial checkout pass
# --allow-missing to opt back into skipping.
#
# Usage:
#   bin/sync-observability.sh                     copy canonical -> every sibling found
#   bin/sync-observability.sh --check             report drift only, exit 1 if any
#   bin/sync-observability.sh --check --allow-missing
#                                                 as --check, but skip absent consumers
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

CONSUMERS=(xchain-indexer xchain-decoder xchain-encoder xchain-utxo-tracker xchain-explorer xchain-sync)

CHECK_ONLY=0
ALLOW_MISSING=0
for arg in "$@"; do
    case "$arg" in
        --check)         CHECK_ONLY=1 ;;
        --allow-missing) ALLOW_MISSING=1 ;;
        *)
            echo "usage: bin/sync-observability.sh [--check [--allow-missing]]" >&2
            exit 2
            ;;
    esac
done

if [[ ! -d "$SRC_DIR" ]]; then
    echo "FATAL: canonical module missing at $SRC_DIR" >&2
    exit 2
fi

drift=0
copied=0
skipped=0
missing=0
compared=0

for consumer in "${CONSUMERS[@]}"; do
    dest_root="$PLATFORM_ROOT/$consumer"
    if [[ ! -d "$dest_root/src" ]]; then
        # In check mode an absent consumer is a hole in the evidence, so it is
        # reported red unless the caller asked for a partial run.
        if [[ $CHECK_ONLY -eq 1 && $ALLOW_MISSING -eq 0 ]]; then
            echo "MISSING $consumer (no checkout at $dest_root)"
            missing=$((missing + 1))
        else
            echo "skip   $consumer (no checkout at $dest_root)"
            skipped=$((skipped + 1))
        fi
        continue
    fi
    dest_dir="$dest_root/src/observability"
    for f in "${FILES[@]}"; do
        src="$SRC_DIR/$f"
        dst="$dest_dir/$f"
        if [[ $CHECK_ONLY -eq 1 ]]; then
            compared=$((compared + 1))
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
        echo "      Fix in xchain-hub/src/observability, then re-run this script with no" >&2
        echo "      flags to re-vendor. Never hand-edit a vendored copy." >&2
    fi
    if [[ $missing -gt 0 ]]; then
        echo "FAIL: $missing consumer checkout(s) absent, so this check proved nothing" >&2
        echo "      about them. Lay the siblings out beside xchain-hub (or point" >&2
        echo "      XCHAIN_PLATFORM_ROOT at a checkout that has them); pass" >&2
        echo "      --allow-missing only for a deliberately partial hand run." >&2
    fi
    if [[ $drift -gt 0 || $missing -gt 0 ]]; then
        exit 1
    fi
    echo "OK: $compared vendored observability file(s) match the canonical module" \
         "($((${#CONSUMERS[@]} - skipped)) of ${#CONSUMERS[@]} consumers checked)"
    exit 0
fi

echo "done: $copied file(s) updated, $skipped consumer(s) skipped"
