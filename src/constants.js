/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
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
// so the ingestion layer (PriceFetcher) must reject anything at or above it —
// otherwise a price in [PRICE_MAX, ∞) would be accepted, recorded in
// oracle_submissions, and broadcast via gossip, only to be silently discarded
// when the round is aggregated. Keeping a single constant guarantees the
// ingestion bound and the aggregation bound can never drift apart.
//
// No BTC/LTC/DOGE fiat price approaches 10M today; raise this here (one place)
// before adding any high-nominal-value pair that could exceed it.
const PRICE_MAX = 10_000_000;

module.exports = { PRICE_MAX };
