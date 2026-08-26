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

// Per-pair bounded-change clamp for the aggregation step: a round's
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

// Default oracle round cadence (10 min) and submission window (3 min), in ms.
// These anchor federation-wide oracle round numbering together with the
// fail-closed ORACLE_EPOCH_START (api.js): every consumer that falls back when
// ORACLE_ROUND_INTERVAL / ORACLE_SUBMISSION_WINDOW is absent from p2pConfig
// (api.js env parsing, OracleRound scheduling, XChainHub tip-freshness bound)
// must fall back to the SAME value, or a hub constructed without a populated
// p2pConfig numbers rounds on a different cadence than its peers. Previously
// each site kept its own bare literal linked only by a prose comment;
// requiring these from one module makes the loader enforce the sync.
const DEFAULT_ORACLE_ROUND_INTERVAL_MS   = 600000;
const DEFAULT_ORACLE_SUBMISSION_WINDOW_MS = 180000;

// PRICE v1 wire-format bounds. Mirror xchain-indexer/src/config.js
// (COINS, FIATS, MAX_TICK_LENGTH, MAX_MEMO_LENGTH) and actions/price.js
// parse_v1: the indexer rejects these on-chain, so any push carrying a value
// outside them is malformed or Byzantine and must not reach oracle_prices
// (getLatestPrice / fee validation / the hub-db mirror stream read it).
// Keep in lockstep with the indexer when new coins or fiats are added.
const PRICE_V1_COINS  = ['BTC', 'LTC', 'DOGE'];
const PRICE_V1_FIATS  = ['USD', 'CAD', 'AUD', 'MXN', 'GBP', 'JPY', 'CNY', 'CHF', 'BRL', 'INR', 'EUR', 'KRW'];
const MAX_TICK_LENGTH = 250;
const MAX_MEMO_LENGTH = 250;
// DERIVED_PAIRS: pairs the federation may carry in a PRICE v0 round that
// are NOT fetched from an external API. XCHAIN is listed on no exchange, so its
// USD price is derived from platform-realized fills; every native-coin fee decision on
// LTC and DOGE needs the pair, and without it those chains cannot price a fee at all.
//
// ADMISSION ONLY, deliberately. This list widens what a hub will ACCEPT - the
// canonical-pair whitelist that gates peer-submission ingest and PROPOSE co-signing.
// It does NOT widen what a hub PRODUCES: PriceFetcher.getCoinPairs() stays the 36
// API pairs, so nothing here causes a hub to submit the pair. Until the derived
// source lands (spec step 2) this constant is purely permissive and inert.
//
// It is also deliberately NOT added to the skipped-row sites
// (OracleConsensus._storeSkippedRound and the missing-pair marker), which answer
// "which pairs did this hub expect to produce and fail to". A pair with no producer
// yet is unbuilt, not dropped; writing a skipped row for it every round would make
// the dashboard health signal permanently red for a pair nothing is trying to
// publish. When step 2 lands and the source exists, the pair joins the producible
// set and those markers become meaningful on their own.
//
// CONSENSUS-CRITICAL and must deploy fleet-wide BEFORE any leader proposes the pair.
// A hub without it treats the pair as fabricated and withholds co-sign on the WHOLE
// round (a signed round is atomic - the pair set is inside the signed payload, so
// there is no per-entry drop), which would stall all 36 pairs federation-wide and
// fail fee validation on every chain once the 1800s staleness bound elapses.
const DERIVED_PAIRS = ['XCHAIN/USD'];

// XCHAIN derived-price parameters (spec §4 / D1+D4)
// CONSENSUS-UNIFORM. Every validator must compute the same window over the same
// fills, so these deploy fleet-wide in lockstep; a hub running different values
// produces a different XCHAIN/BTC leg and lands outside the co-sign deviation band.
//
// D1 and D4 are still open operator decisions; these are the spec's recommended
// defaults and are expected to ship as-is unless the operator retunes them. A retune
// is a declared consensus event (validators on the old constants get slashed, not
// refused), so it rides a flag-day like any other.

// W: window length in reference-chain blocks. ~1000 BTC blocks is about a week, long
// enough that renting the price for a round costs a week of sustained wash volume.
const XCHAIN_PRICE_WINDOW_BLOCKS = 1000;

// K: confirmation buffer. The window top is held K blocks below the round's reference
// height so a fill that a shallow reorg can still roll back is never inside it.
const XCHAIN_PRICE_CONFIRMATION_BUFFER = 6;

// D2, REDECIDED 2026-08-03 (operator): the bootstrap price, in force until real
// fills exist, denominated in SATOSHIS rather than USD.
//
// The original D2 (2026-07-25) pinned `2.00000000` USD, anchored on a token
// issuance costing $2.00: GAS_PRICE 0.00001 x ISSUE 100,000 gas is exactly 1.0
// XCHAIN, so the bootstrap equalled the issuance cost 1:1. That anchor was
// replaced because it prices the TOKEN, not just the fee: against a 100M supply
// $2.00 implies a $200M valuation on a token that has never traded, and a launch
// price that only ever falls from there is the wrong first impression. 1000 sat
// is a deliberately reserved floor (about $0.64 at BTC $63.5k).
//
// Denominated in satoshis, NOT USD, because the quantity the operator wants held
// still is the BTC-denominated one; a USD pin drifts against BTC between the
// decision and launch. It is converted to USD at the point of use with the
// CONSENSUS BTC/USD (the last finalized below the round), never a local API
// price - see XchainPriceSource.derive for why that distinction is load-bearing.
//
// This is also the winsorization anchor for the very first derived round.
//
// Safe to change as of 2026-08-03 because XCHAIN/USD has NEVER finalized a round
// on any network (measured: 0 rows in price_snapshots on mainnet), so re-pinning
// it rewrites no history and supersedes no published value.
const XCHAIN_PRICE_BOOTSTRAP_SATS = 1000;

// The same bootstrap as a BTC-denominated rate, which is the unit fills are
// quoted in and therefore the unit the conversion helper expects.
const XCHAIN_PRICE_BOOTSTRAP_XCHAIN_BTC = '0.00001000';

// D4: per-pair move clamp for XCHAIN/USD, tighter than the global
// ORACLE_MAX_CHANGE_PER_ROUND of 25%. XCHAIN trades in a market that is thin by
// construction pre-launch, so the generic clamp is the wrong size for it: at the
// 10-minute round default, 25%/round compounds to roughly a 10x move in about 80
// minutes, which §5 concedes is a speed bump rather than a wall. 10% costs an
// honest sustained move a few extra hours to walk and costs an attacker most of a
// day per decade of price.
//
// APPLIED AT THE AGGREGATION CLAMP ONLY, deliberately, and the asymmetry with the
// follower propose-gate is the point rather than an oversight. Tightening the
// clamp is always safe (§5: a smaller move always passes a wider gate); tightening
// the GATE to match would put the two within rounding distance of each other, and
// a maximally-clamped aggregate whose 18dp deviation lands a hair above a 10%
// threshold would be rejected by every honest follower - wedging the round it was
// supposed to protect. The gate keeps the wider global band, which for XCHAIN/USD
// is merely permissive: no honest leader can propose a move the clamp did not
// already bound.
const XCHAIN_PRICE_MAX_CHANGE_PER_ROUND = 0.10;

// D2, STILL OPEN: the BTC-side notional a window must carry before the derived
// VWAP supersedes the bootstrap carry-forward. null means SUPERSESSION DISABLED
// (threshold effectively infinite), which is how this ships: the value cannot be
// chosen well before real XCHAIN volume exists, and guessing it wrong in the
// permissive direction lets the first market print be set by whoever wash-trades
// first.
//
// Disabled is a SAFE default, not a broken one. The pair still publishes every
// round (§7 requires unconditional publication or the 1800s staleness bound
// re-bricks LTC/DOGE fees); it publishes the bootstrap, which is exactly what a
// zero-volume market should price at. Deciding the value later is a consensus
// retune riding a coordinated flag-day (§8), which is the cost of not guessing.
//
// The measured quantity is pinned even though the value is not: the sum of the
// BTC side over the window's included fills, post-exclusion and PRE-winsorize
// (xchainPrice.js returns it as totalCoin). XCHAIN-side volume is
// attacker-denominated - the same inventory recycles through unlimited wash
// fills - and fill count is trivially inflatable.
const XCHAIN_PRICE_MIN_BTC_VOLUME = null;

// Row-identity bound for the PRICE v1 dedupe key. Must not exceed the
// oracle_prices.source_address column width (VARCHAR(100)); an over-long value
// would otherwise error the INSERT or (on a non-strict server) truncate and
// collide distinct submitters onto one dedupe key.
const MAX_SOURCE_ADDRESS_LENGTH = 100;

// Default ATTEST PBFT round lifetime (2 min per request lifecycle). Shared, not
// copied, because AttestationRound floors its `seen` retry window at this value
// plus one poll: that floor exists precisely to stop the seen window nesting
// inside a live consensus round (a nested window re-`_startRound`s a request
// whose round is still pending and pays for a second provider fetch). A bare
// literal on each side kept the two coupled only while the copies happened to
// be equal, so a one-sided raise of the consensus default silently re-opened
// the paid duplicate fetch on any hub with no explicit
// ATTESTATION_ROUND_TIMEOUT_MS. Requiring one definition makes the loader
// enforce the coupling, as with the oracle cadence defaults above.
// Attestation-scoped on purpose: CrossChainDexConsensus keeps its own round
// timeout, a different engine's lifecycle that must not be tied to this one.
const DEFAULT_ATTESTATION_ROUND_TIMEOUT_MS = 120000;

// The ATTEST PBFT state machines this build actually implements, and therefore the
// admission allowlist for a block-anchored provider consensus_strategy.
// AttestationConsensus dispatches on the pinned strategy by POSITIVE equality against
// these two names only (leader-only agree() and PREPARE buffering for judge_model;
// the divergence slash-candidate sweep and the no_quorum self-derivation gate for
// byte_equality), so an unrecognised name does not select a third machine: it falls
// through to the byte_equality branches with the no_quorum gate switched off, which is
// the one combination no peer runs. ProviderRegistry deliberately carries an unknown
// name verbatim into the block-anchored history so every hub RESOLVES the same value;
// this list is the other half of that contract, the part that then DECLINES the round.
// Adding a strategy means adding its dispatch branches in AttestationConsensus and its
// entry here together: an entry without branches re-opens exactly this hole.
const SUPPORTED_CONSENSUS_STRATEGIES = Object.freeze(['byte_equality', 'judge_model']);

module.exports = { PRICE_MAX, ORACLE_DEVIATION_THRESHOLD, ORACLE_MAX_CHANGE_PER_ROUND, XCALL_MAX_HOPS,
                   DEFAULT_ORACLE_ROUND_INTERVAL_MS, DEFAULT_ORACLE_SUBMISSION_WINDOW_MS,
                   DEFAULT_ATTESTATION_ROUND_TIMEOUT_MS, SUPPORTED_CONSENSUS_STRATEGIES,
                   PRICE_V1_COINS, PRICE_V1_FIATS, MAX_TICK_LENGTH, MAX_MEMO_LENGTH,
                   MAX_SOURCE_ADDRESS_LENGTH, DERIVED_PAIRS,
                   XCHAIN_PRICE_WINDOW_BLOCKS, XCHAIN_PRICE_CONFIRMATION_BUFFER,
                   XCHAIN_PRICE_BOOTSTRAP_SATS, XCHAIN_PRICE_BOOTSTRAP_XCHAIN_BTC,
                   XCHAIN_PRICE_MAX_CHANGE_PER_ROUND,
                   XCHAIN_PRICE_MIN_BTC_VOLUME };
