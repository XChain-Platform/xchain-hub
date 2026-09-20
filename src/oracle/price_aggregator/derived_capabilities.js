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
 * XChain Hub - Price Aggregator: the derived capability set and its bounds
 *
 * Which capabilities a chain-only hub derives for itself, which consensus
 * engine owns each one where it does run, and the window, cadence and per-tick
 * RPC budget the derivation pass is held to.
 *
 ********************************************************************/

const { positiveIntConfig } = require('../../lib/config_int.js');

// ── Derived capability snapshots ────────────────────────────────────────────
// Every capability the consensus path persists into capability_snapshots, and so
// every capability a chain-only hub must derive for itself. Row 45 built this pass
// for `price` alone, which left a standalone node failing closed on ATTEST and
// storing ANCHOR archive heads `unverified` (measured on the testnet chain-only node
// 2026-09-09: 1,148 rows, all `price`, no other capability at any height).
//
// The consensus writers this mirrors, one per name:
//   price          OracleConsensus.persistCapabilitySnapshot (round finalization)
//   oracle_publish StateCheckpointEngine.js:477,866  (the ANCHOR archive-head verifier)
//   cross_chain    CrossChainCallEngine.js:721, RetractionConsensus.js:393,
//                  CrossChainDexConsensus.js:326,377, CrossChainDexEngine.js:712
//   attestation    AttestationBatchPublisher.js:722  (the v5 ATTEST head verifier)
//
// `cross_chain` is written by engines whose persistCapabilitySnapshot takes a third
// `network` argument, and that argument is NOT a per-row scope this pass cannot supply.
// capability_snapshots has no network column (lib/capability_snapshot_write.js COLUMNS)
// and every reader keys on (capability, snapshot_block) alone (xchain-indexer db/index.js
// getCapabilitySnapshotWeights / getCapabilitySnapshotValidators / getCapabilitySnapshotCount
// / isPubkeyInCapabilitySnapshot). The argument feeds exactly two things: the
// STAKE_WEIGHTED_QUORUM activation key, whose map is keyed mainnet/testnet/regtest, and
// btc_chain_id, a transport column in no reader's WHERE. Both are properties of the HUB's
// own deployment network, which a standalone hub knows as this.hub.network, so the rows
// this pass writes for `cross_chain` are the same rows the engines write.
const DERIVED_CAPABILITIES = ['price', 'oracle_publish', 'cross_chain', 'attestation'];

// The XChainHub properties that hold each capability's consensus writer, one entry per
// name in DERIVED_CAPABILITIES and drawn from the same writer list above. Presence of
// ANY of a capability's engines means the consensus path on this hub already covers it,
// so the derivation pass skips that capability and only that capability. The engines
// are built by startOracle / startCrossChain / startAttestation, each of which gates
// only on a peer manager, which is why engine presence alone cannot distinguish a
// validator from a mesh-only hub and runsConsensusFor pairs it with the signing
// identity. See runsConsensusFor.
const CAPABILITY_CONSENSUS_ENGINES = {
    price:          ['oracleConsensus'],
    oracle_publish: ['stateCheckpoints'],
    cross_chain:    ['crossChainCalls', 'crossChainDex', 'retractionConsensus'],
    attestation:    ['attestationBatchPublisher']
};

// How far back from the BTC tip a hub that does NOT run oracle consensus keeps
// capability_snapshots rows. It has to be a WINDOW rather than a single
// height because the hub never learns which anchor it needs: the indexer resolves
// a landed batch's quorum against capability_snapshots BEFORE it pushes anything,
// so an anchor the hub has not already covered produces no push to learn from.
// 144 blocks is ~1 day of Bitcoin, which covers a node following the tip and a
// day of catch-up; a deeper chain-only bootstrap raises it by config.
const PRICE_CAP_DERIVE_LOOKBACK_BLOCKS = 144;

// Seconds between derivation passes. One pass costs at most one indexer RPC per
// uncovered height, and the batch rail publishes hourly, so a minute is far
// finer-grained than anything it feeds.
const PRICE_CAP_DERIVE_INTERVAL_S = 60;

// Ceiling on the (capability, height) pairs ONE pass resolves. The first pass of a
// cold hub has the whole lookback window to fill for every capability, and doing that
// in a single tick would fire 144 * DERIVED_CAPABILITIES RPCs at the Bitcoin indexer at
// boot. The unit is the RPC, not the height, so widening the capability list did not
// widen this budget. The pass walks newest-first and covers ALL capabilities at a height
// before it steps back one, so the tip (what a node following the chain needs next) is
// fully covered first and the backfill trails behind it over the following ticks.
// HUB_PRICE_CAPABILITY_DERIVE_MAX_PER_TICK accepts a positive integer RPC-unit budget;
// an unset or invalid value retains the 64-unit default.
const PRICE_CAP_DERIVE_MAX_PER_TICK = positiveIntConfig(
    process.env.HUB_PRICE_CAPABILITY_DERIVE_MAX_PER_TICK, 64,
    'HUB_PRICE_CAPABILITY_DERIVE_MAX_PER_TICK');

module.exports = {
    DERIVED_CAPABILITIES, CAPABILITY_CONSENSUS_ENGINES,
    PRICE_CAP_DERIVE_LOOKBACK_BLOCKS, PRICE_CAP_DERIVE_INTERVAL_S, PRICE_CAP_DERIVE_MAX_PER_TICK
};
