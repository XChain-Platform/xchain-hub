#!/usr/bin/env bash
#********************************************************************
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
#********************************************************************
#
# Run the DB-backed test tiers against a throwaway MariaDB.
#
# WHY THE PREFLIGHT MATTERS MORE THAN THE DATABASE. This tier reaches into a sibling
# repository by PATH POSITION rather than through an environment variable:
#
#   test/integration/oracle/oracleFiatDispenser.integration.test.js
#     require(path.resolve(__dirname, '../../../../xchain-indexer/src/utility.js'))
#
# There is no override for that. A checkout sitting anywhere other than beside
# xchain-indexer dies with MODULE_NOT_FOUND at module load, before a single test runs,
# and mocha reports it as an exception during the run rather than as a missing
# dependency. That is strictly worse than the indexer tier, which at least honours
# XCHAIN_SDK_PATH / XCHAIN_DECODER_SQL_PATH, and it cost a wasted run to discover.
# So this script checks the sibling FIRST and refuses rather than handing back a
# failure that looks like broken code.
#
# USAGE
#   bin/run-db-tiers.sh                       # integration tier (default)
#   bin/run-db-tiers.sh unit integration      # both, in order
#   bin/run-db-tiers.sh --keep integration    # leave the database up afterwards
#   bin/run-db-tiers.sh -- test/integration/api/jsonrpc.integration.test.js
#                                             # one file, straight to mocha
#
# ENVIRONMENT (all optional)
#   DB_PORT         host port for the throwaway MariaDB (default 23321)
#   TEST_DB_NAME    database name the suites use (default xchain_hub_test)
#
#********************************************************************

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CONTAINER="xchain-hub-dbtier"
DB_PORT="${DB_PORT:-23321}"
DB_PASS="test"                 # fixture value: throwaway container, dropped on exit
IMAGE="mariadb:11.4"
KEEP=0
TIERS=()
MOCHA_ARGS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --keep) KEEP=1; shift ;;
        --) shift; MOCHA_ARGS=("$@"); break ;;
        -h|--help) sed -n '/^# USAGE/,/^#\*\{10,\}$/p' "${BASH_SOURCE[0]}"; exit 0 ;;
        unit|integration|e2e) TIERS+=("$1"); shift ;;
        *) echo "run-db-tiers: unknown argument '$1' (want unit|integration|e2e, --keep, --, -h)" >&2
           exit 64 ;;
    esac
done
if [[ ${#TIERS[@]} -eq 0 && ${#MOCHA_ARGS[@]} -eq 0 ]]; then TIERS=(integration); fi

command -v docker >/dev/null 2>&1 || {
    echo "run-db-tiers: docker is required (it hosts the throwaway MariaDB)." >&2; exit 69; }

# ---- Preflight: the sibling indexer, resolved exactly as the suite resolves it, and
# ---- LOADED rather than merely stat-ed, because a symlinked sibling can exist as a
# ---- path while the module underneath it does not.
SIBLING="$REPO_ROOT/../xchain-indexer/src/utility.js"
if ! node -e "require('$SIBLING')" >/dev/null 2>&1; then
    cat >&2 <<SIBERR
run-db-tiers: cannot load the sibling indexer, so this run would die at module load.

  Expected: $SIBLING

  test/integration/oracle/oracleFiatDispenser.integration.test.js requires the
  indexer's utility.js by PATH POSITION ('../../../../xchain-indexer/src/utility.js')
  and there is NO environment override. A checkout that does not sit beside
  xchain-indexer fails with MODULE_NOT_FOUND before any test runs, and mocha reports
  it as an exception during the run rather than as a missing dependency.

  Fix: place this repo beside an xchain-indexer checkout, or symlink one:
      ln -s /path/to/xchain-indexer "$REPO_ROOT/../xchain-indexer"
SIBERR
    exit 78
fi

teardown(){
    local status=$?
    if [[ $KEEP -eq 1 ]]; then
        echo "run-db-tiers: leaving $CONTAINER up on port $DB_PORT (--keep)."
    else
        docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    fi
    exit $status
}
trap teardown EXIT

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
echo "run-db-tiers: starting $IMAGE as $CONTAINER on 127.0.0.1:$DB_PORT (tmpfs)"
docker run -d --name "$CONTAINER" \
    -e MARIADB_ROOT_PASSWORD="$DB_PASS" \
    -p "127.0.0.1:$DB_PORT:3306" \
    --tmpfs /var/lib/mysql \
    "$IMAGE" >/dev/null

# Poll the image's own healthcheck rather than sleeping a fixed amount: a cold pull
# makes any fixed wait either flaky or slow.
echo -n "run-db-tiers: waiting for the database"
for _ in $(seq 1 60); do
    if docker exec "$CONTAINER" healthcheck.sh --connect --innodb_initialized >/dev/null 2>&1; then
        echo " ready"; break
    fi
    echo -n "."; sleep 2
done
docker exec "$CONTAINER" healthcheck.sh --connect --innodb_initialized >/dev/null 2>&1 || {
    echo; echo "run-db-tiers: the database never came up; last container logs:" >&2
    docker logs --tail 20 "$CONTAINER" >&2; exit 75; }

export TEST_DB_HOST=127.0.0.1
export TEST_DB_PORT="$DB_PORT"
export TEST_DB_USER=root
export TEST_DB_PASS="$DB_PASS"
export TEST_DB_NAME="${TEST_DB_NAME:-xchain_hub_test}"

echo "run-db-tiers: sibling=ok db=$TEST_DB_NAME@$DB_PORT"

rc=0
if [[ ${#MOCHA_ARGS[@]} -gt 0 ]]; then
    echo "run-db-tiers: mocha ${MOCHA_ARGS[*]}"
    npx mocha --timeout 300000 --exit "${MOCHA_ARGS[@]}" || rc=$?
else
    for tier in "${TIERS[@]}"; do
        echo "run-db-tiers: === $tier tier ==="
        case "$tier" in
            unit)        npm run ci || rc=$? ;;
            integration) npm run test:integration || rc=$? ;;
            e2e)         npm run test:e2e || rc=$? ;;
        esac
        # Keep going through a failing tier so one red tier cannot hide the next, and
        # report the first failure's status at the end.
        [[ $rc -ne 0 ]] && echo "run-db-tiers: $tier tier FAILED (rc=$rc), continuing" >&2
    done
fi

echo "run-db-tiers: done (rc=$rc)"
exit $rc
