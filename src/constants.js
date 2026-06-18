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
 * XChain Hub - Shared Constants
 *
 * Protocol/consensus values shared across the oracle price pipeline.
 *
 ********************************************************************/

// Upper bound (exclusive) for any single coin/fiat price the oracle will
// accept. This is the binding consensus ceiling enforced during aggregation,
// so the ingestion layer (PriceFetcher) must reject anything at or above it;
// otherwise a price in [PRICE_MAX, ∞) would be accepted, recorded in
// oracle_submissions, and broadcast via gossip, only to be silently discarded
// when the round is aggregated. Keeping a single constant guarantees the
// ingestion bound and the aggregation bound can never drift apart.
//
// No BTC/LTC/DOGE fiat price approaches 10M today; raise this here (one place)
// before adding any high-nominal-value pair that could exceed it.
const PRICE_MAX = 10_000_000;

// Hard ceiling on cross-chain hop depth for XCALL relays. user->Y is hop 1,
// Y->back is hop 2; further hops require a fresh user-initiated transaction.
// Canonical value: xchain-documentation/protocol/constants.js XCALL_MAX_HOPS.
// The indexer enforces this at execution time; the hub enforces it here as
// defense-in-depth so a Byzantine indexer cannot queue a relay the indexer
// would then reject (wasted PBFT round + stale dispatch row in the DB).
const XCALL_MAX_HOPS = 2;

// Co-sign deviation band for the oracle PREPARE content-validation gate
// (OracleConsensus._handlePropose): a follower refuses to co-sign a proposed price
// that deviates more than this fraction from its own local aggregate for the pair.
// MUST be federation-uniform: if hubs used different bands, identical aggregates
// could yield different accept/withhold decisions (a liveness divergence on the ±band
// boundary). Sourced as a shared constant (not per-hub slashDetector config) so it can
// never drift between hubs. 0.05 = 5%.
const ORACLE_DEVIATION_THRESHOLD = 0.05;

module.exports = { PRICE_MAX, ORACLE_DEVIATION_THRESHOLD, XCALL_MAX_HOPS };
