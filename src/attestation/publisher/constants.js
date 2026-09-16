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
 * XChain Hub - Attestation Publisher: shared constants
 *
 * Failover timing, the pending-page size, the wire limit and the marker-retention
 * bounds the publisher's parts read.
 *
 ********************************************************************/

'use strict';

const APPROX_BTC_BLOCK_MS  = 600000;  // ~10 min; used to translate the failover
                                      // window from blocks to a wall-clock silence
                                      // threshold that survives a restart.
const DEFAULT_FAILOVER_WINDOW_BLOCKS = 2;       // leader silence before rank-1 steps in

const DEFAULT_FAILOVER_POLL_MS       = 30000;   // sweep cadence

const DEFAULT_LEADER_RETRY_MS        = 60000;   // grace before the sweep retries a leader entry
                                                // (lets the happy-path live broadcast win)
const PENDING_PAGE_LIMIT             = 100;     // matches AttestationRound poll page size

const ATTEST_WIRE_MAX_BYTES          = 8189;    // must equal MAX_DATA_BYTES in xchain-encoder/src/validator.js

// Default retention window for the durable attest_published_requests marker table,
// mirroring OraclePublisher's ~90-day oracle_published_rounds window.
const DEFAULT_PUBLISHED_RETENTION_MS = 7776000000;   // 90 days

// Multiple of the re-presentability horizon the effective window is FLOORED at.
// The horizon itself is governance-controlled (see publishedRetentionFloorMs), so
// the safety multiple is what absorbs a hub whose indexer view lags the chain.
const PUBLISHED_RETENTION_DEADLINE_SAFETY = 4;

// Cap on how many queued request ids the prune DELETE will carry as an exclusion
// list. A queue this deep is a drain failure, not a retention problem; the sweep
// skips rather than building a pathological statement.
const PUBLISHED_RETENTION_QUEUE_MAX = 5000;

module.exports = {
    APPROX_BTC_BLOCK_MS,
    DEFAULT_FAILOVER_WINDOW_BLOCKS,
    DEFAULT_FAILOVER_POLL_MS,
    DEFAULT_LEADER_RETRY_MS,
    PENDING_PAGE_LIMIT,
    ATTEST_WIRE_MAX_BYTES,
    DEFAULT_PUBLISHED_RETENTION_MS,
    PUBLISHED_RETENTION_DEADLINE_SAFETY,
    PUBLISHED_RETENTION_QUEUE_MAX
};
