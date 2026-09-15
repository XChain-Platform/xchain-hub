/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Hub - Call Engine Constants
 *
 * The relay's chain list, poll cadence, the statuses it will carry, the result-relay backoff
 * bounds and the canonical integer fields each phase signs, in one place because the poll,
 * the follower checks and the surface reads each need some of them.
 *
 ********************************************************************/

const coins = require('../../coins');

const ALLOWED_CHAINS  = [...coins.ALLOWED_COINS];

const DEFAULT_POLL_MS = 15000;

// Per-chain confirmation depth a source request (and a target execution) must
// reach before the federation will sign its relay row: shares the cross-chain
// swap thresholds (coins.resolveConfirmations; XCHAIN_CONFIRMATIONS_<COIN> env
// / p2pConfig overridable, mainnet floor-clamped).

// Result statuses the federation will relay. Anything else from an indexer is
// treated as 'error' (deterministic normalization happens indexer-side; this
// is belt-and-suspenders against a confused indexer response).
// Note: the indexer's vmFailureStatus collapses resource exhaustion to
// 'out_of_resource', but xexec.js:_mapFailureStatus then re-normalizes
// 'out_of_resource' back to 'out_of_gas' for XCALL result rows, so
// 'out_of_gas' (not 'out_of_resource') is what the federation relays here.
const RESULT_STATUSES = ['ok', 'reverted', 'out_of_gas', 'no_contract', 'not_callable', 'payload_too_large', 'error'];

// Result-relay backoff (deepdive M-14). A dispatch row whose target execution
// never yields a result at confirmation depth (e.g. the execution was reorged
// away and never re-injected) matches the result poll's WHERE clause forever.
// Under a plain `ORDER BY id ASC LIMIT n` window such rows, being the lowest ids,
// would pin the window and starve every newer dispatch (head-of-line blocking).
// A result-less row is parked with an exponential next-retry time and excluded
// from the hot window until then, so fresh dispatches always get in while the
// stuck row is retried on a slow cadence. Node-local only: which rows THIS hub
// proposes first is not a consensus decision (every hub re-verifies each round
// independently and any hub can lead it), so parking never blocks participation.
const RESULT_BACKOFF_BASE_MS    = 60 * 1000;        // first re-attempt delay for a result-less dispatch

const RESULT_BACKOFF_MAX_MS     = 60 * 60 * 1000;   // exponential backoff ceiling (1h)

const RESULT_BACKOFF_EXCLUDE_MAX = 500;             // max parked call_ids excluded per query (bounds query size)

const RESULT_BACKOFF_MAP_MAX    = 10000;            // parked-map cap; FIFO evict just retries an entry sooner (safe)

// Bound on listCalls rows (mirrors the api-side validateLimit ceiling).
const CALL_LIST_MAX = 10000;

// The INT/BIGINT-backed fields each phase signs VERBATIM into canonicalMatch and
// every verifier re-derives from a normalized integer. Decimal, address, method,
// payload, chain and status fields are compared as strings and are NOT listed.
const CANONICAL_INT_FIELDS = {
    dispatch: ['snapshot_block', 'source_action_index', 'source_contract_index',
               'target_contract_index', 'gas_limit', 'cross_hops', 'effective_time'],
    result:   ['snapshot_block', 'effective_time']
};

module.exports = { ALLOWED_CHAINS, DEFAULT_POLL_MS, RESULT_STATUSES, RESULT_BACKOFF_BASE_MS, RESULT_BACKOFF_MAX_MS, RESULT_BACKOFF_EXCLUDE_MAX, RESULT_BACKOFF_MAP_MAX, CALL_LIST_MAX, CANONICAL_INT_FIELDS };
