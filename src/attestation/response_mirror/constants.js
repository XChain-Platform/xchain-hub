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
 * AttestationResponseMirror: shared constants
 *
 * The mirrored and gossiped column lists, the terminal statuses, the P2P message
 * type and the park bounds. The class file re-exports every one of them except
 * REQUEST_LOOKUP_LIMIT, as it did before the split.
 *
 ********************************************************************/

'use strict';

// The mirrored column set, in the order the snapshot route (api.js
// GET /hub-db/snapshot/attestation_responses) selects them. The INSERT and the
// select-back now live in src/db/attestation.js, which spells the same list for
// the SQL; this copy is the wire's, and GOSSIP_COLUMNS derive from it. The REST
// bootstrap and this WS stream must hand a consumer the SAME columns, and the way
// they drift apart is one path gaining a column the other does not know about, so
// a column added to the table goes in both lists.
// `id` is excluded: it is assigned by AUTO_INCREMENT and stripped again on apply
// (two hubs carry different ids for the same logical row), so it is a paging
// cursor and never an input.
const MIRROR_COLUMNS = [
    'network', 'request_id', 'request_action_index', 'request_block_index',
    'provider_id', 'status', 'response_payload', 'response_hash', 'meta',
    'effective_time', 'admit_block_btc', 'signer_pubkeys', 'signatures', 'widen', 'batch_action_index',
    'finalized_at'
];

// The statuses the mirror carries. Terminal only: a retryable round leaves the
// request pending on the indexer, has no chain effect today beyond an audit row,
// and is the one unbounded multiplier on the size of the periodic on-chain batch.
// In practice the hub only ever produces 'ok' here (decision D56: 'expired' is an
// indexer verdict from the local deadline sweep, which needs no mirror row); the
// wider set is accepted so an 'expired' producer could be added without a schema
// change, exactly as the column's own vocabulary allows.
const TERMINAL_STATUSES = new Set(['ok', 'expired']);

// The one P2P message type this engine owns (§3.3).
const ATTEST_RESULT = 'ATTEST_RESULT';

// The row as it rides the wire: every mirrored column except `finalized_at`.
// DERIVED from MIRROR_COLUMNS rather than written out again, so a column added to
// the table travels automatically instead of being silently absent on one path.
// `finalized_at` is excluded because it is the receiver's OWN audit stamp, not a
// property of the artifact: the column's contract is explicitly that two hubs'
// copies of one logical row may disagree on it, and the on-chain batch (§6.1)
// excludes it for the same reason. Leaving it off the wire also means there is no
// wire-supplied clock value to sanitize or to abuse. `batch_action_index` is off the
// wire for the same reason: it is set by the DOGE batch landing, hours after the
// gossip, and reaches every hub through the chain-to-hub push rather than through a
// peer's claim.
const GOSSIP_COLUMNS = MIRROR_COLUMNS.filter(c => c !== 'finalized_at' && c !== 'batch_action_index');

// The park set's ceiling. A row whose request this hub cannot resolve yet is held
// for one retry cycle, and a peer that gossips rows for requests that will never
// exist would otherwise grow this map without bound, so it is capped and the oldest
// entry is evicted first. Sized well above any honest backlog: the admission cap is
// 10 requests per BTC block (§6.1), so 128 covers roughly two hours of full blocks.
const PARK_MAX = 128;

// One park cycle. Matched to AttestationRound's DEFAULT_POLL_MS, because the thing
// being waited for is exactly what that poll observes: the local BTC indexer
// catching up far enough to hold the v0 request row.
const PARK_RETRY_MS = 15000;

// One page of the pending-request queue is enough to resolve a request, because the
// wire's own (block_index, action_index) positions the keyset cursor on it. See
// resolveLocalRequest for why using an untrusted value as a cursor is safe.
const REQUEST_LOOKUP_LIMIT = 100;

module.exports = {
    MIRROR_COLUMNS,
    TERMINAL_STATUSES,
    ATTEST_RESULT,
    GOSSIP_COLUMNS,
    PARK_MAX,
    PARK_RETRY_MS,
    REQUEST_LOOKUP_LIMIT
};
