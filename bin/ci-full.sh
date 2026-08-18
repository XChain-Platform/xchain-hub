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
# bin/ci-full.sh: run EVERY tier this repo's GitHub CI runs, in one process.
#
# .github/workflows/ci.yml fans this repo out as five jobs (ci, perf,
# regression, drift-guards, coverage). The pre-push venue gate used to run only
# `npm run ci`, so a push could gate green locally and then go red on GitHub on
# a job the gate never ran (2026-08-15: exactly that, on three repos at once).
# This script IS the local twin of the workflow: every job's run-steps,
# transcribed, in job order. When ci.yml gains or changes a job, change this
# script in the same commit.
#
# The other workflows in .github/workflows/ are deliberately out of scope:
# verify-tag.yml triggers on `v*` tags only, and audit.yml on schedule /
# workflow_dispatch / pull_request paths, so neither runs on a push to
# develop or master and neither can turn this gate's push red.
#
# Layout: siblings resolve at ../<repo>, which is both the platform monorepo
# layout and the venue gate's work/ layout (.ci-siblings ships them there). A
# sibling a GitHub job checks out is REQUIRED here: missing means fail loud,
# never skip, because GitHub will run the step this gate would be skipping.
# That applies twice over to xchain-wallet: sync-chain-registry.mjs prints
# "no xchain-hub checkout beside this one" and PASSES when the pair is not
# laid out, and the coverage ratchet measures a smaller suite when the
# .ci-siblings roster is absent (measured: 3713 of 3796 unit tests).
#
# Database: TEST_DB_* env if already set; else the venue's CI_DB_* (exported by
# ci-gate.sh from venue.env); else localhost root with the empty password the
# workflow's MariaDB service container uses (MARIADB_ALLOW_EMPTY_ROOT_PASSWORD)
# against the xchain_hub_test database, so a hand-run beside a stock
# `mariadb:11.4` container behaves like CI.
#
# SKIPPED-BY-DESIGN: none. Every run-step of every job is transcribed; the
# untranscribed steps are all actions-only bookkeeping (actions/checkout,
# actions/setup-node, the npm ci install step, and the coverage job's sibling
# clone loop, which need_sib below covers).
#
# All tiers run even after one fails (GitHub reports every red job, so this
# reports every red tier); the exit code is red if any tier was.
#
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
SELF="$(pwd)"
SIB="$(cd .. && pwd)"

FAILED=""
run_tier() {
  local name="$1"; shift
  echo; echo "ci:full ===== $name ====="
  if "$@"; then
    echo "ci:full ----- $name PASS"
  else
    FAILED="$FAILED [$name]"
    echo "ci:full ----- $name FAIL"
  fi
}
need_sib() {
  local s
  for s in "$@"; do
    if [ ! -d "$SIB/$s" ]; then
      echo "ci:full: MISSING SIBLING $SIB/$s" >&2
      echo "ci:full: GitHub CI checks this sibling out and runs steps against it," >&2
      echo "ci:full: so skipping here would gate green on a subset. Declare it in" >&2
      echo "ci:full: .ci-siblings (venue) or clone it beside this repo (hand run)." >&2
      exit 1
    fi
  done
}

export TEST_DB_HOST="${TEST_DB_HOST:-${CI_DB_HOST:-127.0.0.1}}"
export TEST_DB_PORT="${TEST_DB_PORT:-${CI_DB_PORT:-3306}}"
export TEST_DB_USER="${TEST_DB_USER:-${CI_DB_USER:-root}}"
export TEST_DB_PASS="${TEST_DB_PASS:-${CI_DB_PASS:-}}"
export TEST_DB_NAME="${TEST_DB_NAME:-${CI_DB_NAME:-xchain_hub_test}}"

need_sib xchain-documentation xchain-explorer xchain-indexer xchain-sdk xchain-wallet xchain-vm xchain-decoder

# --- job: ci (XChain-Platform/.github ci-reusable.yml -> npm run ci) -------
run_tier "ci" npm run ci

# --- job: perf -------------------------------------------------------------
# The workflow gives this job its own MariaDB service container; here the DB is
# the venue's (CI_DB_*), resolved above. SOAK_DURATION_MS mirrors the workflow's
# env, which keeps the soak bounded well under the suite's 120s default.
run_tier "perf (test:perf)" env SOAK_DURATION_MS=15000 npm run test:perf

# --- job: regression -------------------------------------------------------
# Fully mocked (no DB, no network). `npm run ci` already runs ci:regression, so
# this repeats seconds of work; it stays because the workflow job stays, and a
# tier this script drops is a tier the gate stops proving.
run_tier "regression (ci:regression)" npm run ci:regression

# --- job: drift-guards -----------------------------------------------------
# The workflow checks the hub out beside xchain-wallet and runs the wallet's
# sync script against the pair. The script resolves the hub at ../../xchain-hub
# from its own location, so the sibling layout is what makes it check anything.
run_tier "drift: chain-registry snapshot vs canonical wallet descriptors" \
  node "$SIB/xchain-wallet/bin/sync-chain-registry.mjs" --check
consensus_pin_check() { (cd "$SELF" && node -e '
  const coins = require("./src/coins");
  for (const net of ["testnet", "regtest"]) {
    const res = coins.verifyConsensusPin(net);
    if (res && res.skipped) throw new Error("consensus pin unexpectedly unarmed for " + net);
  }
  console.log("consensus pin conformance OK (testnet, regtest)");
'); }
run_tier "drift: coin consensus-pin conformance (canonical bundle)" consensus_pin_check

# --- job: coverage ---------------------------------------------------------
run_tier "coverage ratchet (coverage:check)" npm run coverage:check

echo
if [ -n "$FAILED" ]; then
  echo "ci:full: RED tiers:$FAILED"
  exit 1
fi
echo "ci:full: all tiers green (same set GitHub CI runs)"
