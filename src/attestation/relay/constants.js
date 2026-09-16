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
 * XChain Hub - Attestation cross-chain relay: shared constants
 *
 * The chain names, paging bounds, wire limit and eviction bounds every relay part
 * reads. One copy, required by the class file and by each part, so no two parts can
 * disagree about a bound. The class file re-exports HOME_CHAIN and ORIGIN_CHAINS.
 *
 ********************************************************************/

'use strict';

const coins = require('../../coins');

// The integer fields each relay leg signs VERBATIM and the indexer re-derives with
// parseInt() off the v3/v4 wire. request_id / response_hash are hex, and
// provider_id / status / meta are string compares, so none of them belong here.
const RELAY_CANONICAL_INT_FIELDS = {
    request:  ['snapshot_block', 'origin_action_index', 'redundancy', 'deadline_blocks'],
    response: ['snapshot_block', 'home_response_action_index']
};

// The chain attestation staking lives on, and therefore the only chain a
// responsible set can be keyed on. Must equal HOME_CHAIN in the indexer's attest/index.js.
const HOME_CHAIN    = 'BTC';

const ORIGIN_CHAINS = coins.ALLOWED_COINS.filter(c => c !== HOME_CHAIN);

const DEFAULT_POLL_MS = 15000;

const PAGE_LIMIT      = 500;   // the indexer's own per-call ceiling

const MAX_PAGES       = 20;    // bounds any one sweep at 10k rows

// The only two TERMINAL response statuses. The retryable ones (no_quorum, timeout,
// provider_error) leave the BTC request pending for another round, so relaying one
// would close an origin request the home chain still intends to fulfill. The origin
// indexer enforces the same list, so anything else is refused there anyway.
const RELAYABLE_STATUSES = ['ok', 'expired'];

// The request lifecycle value the indexer stamps on a REFUSED relay row (attest/index.js
// writes REQUEST_STATUS='rejected' whenever a v3 carries an error verdict). Every
// other value it can hold, 'pending' / 'fulfilled' / 'errored' / 'expired', belongs
// to a request that really was materialized on the home chain.
const REFUSED_REQUEST_STATUS = 'rejected';

// Must equal MAX_DATA_BYTES in xchain-encoder/src/validator.js, as in
// AttestationPublisher: an oversized payload is rejected by createTx, and finding
// that out after the round has finalized wastes the whole round.
const ATTEST_WIRE_MAX_BYTES = 8189;

// How far a leader's proposed snapshot_block may sit from our own view of the BTC
// tip before we refuse to co-sign. Same bound (about a day of BTC blocks) the
// XCALL relay uses: an ancient snapshot_block would let a Byzantine leader select
// a stale cross_chain validator set for the indexer's signature check.
const SNAPSHOT_DRIFT_BLOCKS = 144;

// Wall-clock silence, per rank, before a non-leader steps in and broadcasts the
// round it already co-signed. Rank 0 (the leader) sends immediately; rank 1 waits
// one window, rank 2 two, so a silent leader costs one window, not the request's
// whole deadline. Matches AttestationPublisher's failover shape.
const DEFAULT_FAILOVER_WINDOW_MS = 20 * 60 * 1000;

// How far past an origin request's own absolute deadline_block that chain's tip must
// travel before this driver forgets the request's at-most-once records.
// Added to the chain's confirmation depth, so the total covers both a reorg that
// could un-expire the request and the indexer's own expiry lag: the deadline sweep
// (xchain-indexer getExpiredAttestationRequests) is capped per block, so a batch of
// requests sharing one deadline drains over several blocks rather than all at once.
// Blocks, not wall clock, because the thing being outlived is a chain height.
const DEFAULT_EVICTION_GRACE_BLOCKS = 144;

// Safety valve on the deadline index itself. It is populated only for legs this node
// actually took part in, so it tracks the at-most-once sets rather than the chain, but
// an unbounded map is the very defect being fixed. At the cap new deadlines are
// refused, which costs RETENTION (those legs are never evicted) and never a re-spend.
const MAX_TRACKED_DEADLINES = 50000;

module.exports = {
    RELAY_CANONICAL_INT_FIELDS,
    HOME_CHAIN,
    ORIGIN_CHAINS,
    DEFAULT_POLL_MS,
    PAGE_LIMIT,
    MAX_PAGES,
    RELAYABLE_STATUSES,
    REFUSED_REQUEST_STATUS,
    ATTEST_WIRE_MAX_BYTES,
    SNAPSHOT_DRIFT_BLOCKS,
    DEFAULT_FAILOVER_WINDOW_MS,
    DEFAULT_EVICTION_GRACE_BLOCKS,
    MAX_TRACKED_DEADLINES
};
