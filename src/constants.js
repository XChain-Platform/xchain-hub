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
// Sized for the highest-nominal configured pair, BTC/KRW: at ~$100k BTC and
// ~1,350 KRW/USD that is ~1.35e8 KRW, and it scales with the BTC price, so the
// old 1e7 cap dropped BTC/KRW always (and BTC/JPY above ~$66.7k BTC) silently at
// ingestion, leaving those pairs absent from price_snapshots with no skipped row
// or warning. 1e10 covers BTC/KRW past ~$7M BTC with headroom while still
// rejecting parse-overflow / misplaced-decimal garbage. This is a coarse global
// sanity ceiling only; per-pair outliers are caught by the co-sign deviation gate
// and multi-submitter aggregation, not here. Raise (or move to a per-pair bound)
// here in one place before adding any pair that could exceed it.
const PRICE_MAX = 10_000_000_000;

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

// Per-pair bounded-change clamp for the aggregation step : a round's
// trimmed-median aggregate may move at most this fraction from the pair's last
// FINALIZED price per round. A fat-tail spike (or a coordinated set of
// manipulated feeds that survives the trim) walks toward the new level at
// 25%/round instead of landing in one round, so USD-pegged fee math never sees
// a single absurd print. MUST be federation-uniform (hubs re-derive each
// other's aggregates before co-signing, so a divergent bound forks the
// federation on the boundary). Kept at 5x ORACLE_DEVIATION_THRESHOLD so a
// clamped aggregate always passes the follower propose-gate's historical band
// (which uses the same 5x multiplier). CONSENSUS-CRITICAL: deploy fleet-wide.
const ORACLE_MAX_CHANGE_PER_ROUND = 0.25;

// PRICE v1 wire-format bounds . Mirror xchain-indexer/src/config.js
// (COINS, FIATS, MAX_TICK_LENGTH, MAX_MEMO_LENGTH) and actions/price.js
// parse_v1: the indexer rejects these on-chain, so any push carrying a value
// outside them is malformed or Byzantine and must not reach oracle_prices
// (getLatestPrice / fee validation / the hub-db mirror stream read it).
// Keep in lockstep with the indexer when new coins or fiats are added.
const PRICE_V1_COINS  = ['BTC', 'LTC', 'DOGE'];
const PRICE_V1_FIATS  = ['USD', 'CAD', 'AUD', 'MXN', 'GBP', 'JPY', 'CNY', 'CHF', 'BRL', 'INR', 'EUR', 'KRW'];
const MAX_TICK_LENGTH = 250;
const MAX_MEMO_LENGTH = 250;

module.exports = { PRICE_MAX, ORACLE_DEVIATION_THRESHOLD, ORACLE_MAX_CHANGE_PER_ROUND, XCALL_MAX_HOPS,
                   PRICE_V1_COINS, PRICE_V1_FIATS, MAX_TICK_LENGTH, MAX_MEMO_LENGTH };
