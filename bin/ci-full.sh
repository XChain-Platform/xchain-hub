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
# LANE-LEVEL BY DESIGN: bin/sync-coins.sh --check and the platform's
# reconcile-twins.sh --check are not tiers here. Both compare against the
# sibling checkouts beside this repo, so either reds on sibling drift that a hub
# commit did not cause, while the venue ships each sibling from its own origin.
# They run in the working tree where a twin is edited, beside the checkouts they
# read. The observability compare below is a tier because ci.yml's drift-guards
# job runs it.
#
# THE ONE EXCEPTION: bin/check-frozen-set.js runs as a tier below even though no
# ci.yml job calls it. It reads only this checkout (no sibling, no network), so
# it cannot red on state a hub commit did not cause, and until this change it
# ran in no gate at all: a carrier move or rename could land, published, with
# nothing catching it. Self-contained checks that only look at this tree belong
# in every push; the sibling-reading ones above stay lane-level.
#
# All tiers run even after one fails (GitHub reports every red job, so this
# reports every red tier); the exit code is red if any tier was.
#
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
SELF="$(pwd)"
SIB="$(cd .. && pwd)"

FAILED=""
# >>> ci-tier (generated block; re-run the tier wirer to update) >>>
# Tier classes. A push grades the FAST tier only: the unit job, the pin and
# drift guards, and the structure and hygiene checks the hook runs before it
# dispatches. The tiers named below (coverage re-runs, perf scenarios) are
# skipped when the gate sets CI_TIER=fast, and each skip is recorded so the
# closing verdict can never claim a green it did not earn. Nothing stops
# being graded: a scheduled sweep re-runs this same script with CI_TIER=full
# on every repo every three hours and before any release or deploy, and a
# red there is tracked down and fixed first. CI_TIER is unset for a hand
# run, so a bare `npm run ci:full` still runs every tier as it always did.
CI_TIER_FULL_ONLY=(
  "perf (test:perf)"
  "coverage ratchet (coverage:check)"
)
DEFERRED=""
ci_tier_deferred() {
  [ "${CI_TIER:-full}" = "fast" ] || return 1
  local t
  for t in ${CI_TIER_FULL_ONLY[@]+"${CI_TIER_FULL_ONLY[@]}"}; do
    if [ "$t" = "$1" ]; then
      DEFERRED="$DEFERRED [$1]"
      echo; echo "ci:full ===== $1 DEFERRED (CI_TIER=fast, runs in the full sweep) ====="
      return 0
    fi
  done
  return 1
}
# <<< ci-tier <<<
run_tier() {
  ci_tier_deferred "$1" && return 0  # ci-tier guard (generated)
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

need_sib xchain-documentation xchain-explorer xchain-indexer xchain-sdk xchain-wallet xchain-vm xchain-decoder \
         xchain-encoder xchain-utxo-tracker xchain-sync

# --- local guard: frozen carrier set (check:frozen-set) --------------------
# No ci.yml job runs this; it is wired in here anyway (see THE ONE EXCEPTION,
# above) because the hazard it catches never fails a suite and never changes a
# published number on its own. Cheap and self-contained, so it runs first.
run_tier "frozen carrier set (check:frozen-set)" npm run check:frozen-set

# --- local guard: the measurement tools' own suites (bin/test) -------------
# No npm script collects bin/test, and adding one would change what `ci` runs
# and the suite-title pin that records it, so the tier lives here. These suites
# are what make the identity, frozen-set, reachability, title-map and sibling
# reference readings mean anything: a tool that stops seeing what it measures
# still exits 0, and only its own fixtures say so.
run_tier "measurement tools (bin/test)" \
  npx mocha 'bin/test/**/*.test.js' --no-config --timeout 120000 --recursive --exit

# --- job: ci (XChain-Platform/.github ci-reusable.yml -> npm run ci) -------
run_tier "ci" env XCHAIN_REQUIRE_SIBLINGS=1 npm run ci

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
# The hub owns src/observability/ and vendors it byte-for-byte into six consumers.
# `--check` is cmp only (no npm install, no sibling module load), so the tier costs
# a few dozen file compares; it treats an absent consumer as red, which is why the
# three observability-only consumers joined need_sib above.
run_tier "drift: vendored observability shim vs canonical (six consumers)" \
  npm run check:observability-sync

# --- job: coverage ---------------------------------------------------------
run_tier "coverage ratchet (coverage:check)" \
  env XCHAIN_REQUIRE_SIBLINGS=1 npm run coverage:check

echo
# >>> ci-tier summary (generated) >>>
echo "ci:full: tier class ${CI_TIER:-full}"
if [ -n "${DEFERRED:-}" ]; then
  echo "ci:full: DEFERRED to the full sweep:$DEFERRED"
fi
# <<< ci-tier summary <<<
if [ -n "$FAILED" ]; then
  echo "ci:full: RED tiers:$FAILED"
  exit 1
fi
# >>> ci-tier verdict (generated) >>>
if [ "${CI_TIER:-full}" = "fast" ]; then
  echo "ci:full: all FAST tiers green; the DEFERRED tiers above were NOT graded here"
else
  echo "ci:full: all tiers green (same set GitHub CI runs)"
fi
# <<< ci-tier verdict <<<
