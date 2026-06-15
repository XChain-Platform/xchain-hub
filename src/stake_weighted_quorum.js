/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * XChain Hub — Stake-Weighted Quorum (STAKE_WEIGHTED_QUORUM / WI-1)
 *
 * The single, CONSENSUS-CRITICAL implementation of the stake-weighted quorum
 * predicate for the hub. Every PBFT tally engine (CrossChainDexConsensus,
 * CrossChainCallEngine, CrossChainEngine, OracleConsensus, StateCheckpointEngine,
 * Consensus) resolves through here so they can never drift. The indexer keeps a
 * byte-equivalent copy in xchain-indexer/src/stake_weighted_quorum.js; the
 * cross-service regression suite asserts both agree (a divergence forks the chain).
 *
 ********************************************************************/

const bc = require('./bcmath');

// Per-network activation height (LOCAL COPY of the canonical map in
// xchain-documentation/protocol/constants.js — kept equal by the cross-service
// regression suite). Keyed on the BTC-anchored snapshot_block, NOT each chain's
// local height, so the hub and all indexers flip on the same anchor.
const STAKE_WEIGHTED_QUORUM_ACTIVATION = {
    mainnet: 999999999,   // PLACEHOLDER — set the real BTC flag-day height before mainnet enable
    testnet: 0,
    regtest: 0,
};

// Whether stake-weighted quorum is in effect for a round whose BTC-anchored
// snapshot is at `snapshotBlock` on `network`. Below this → legacy count quorum.
function isStakeWeightedQuorumActive(snapshotBlock, network){
    let sb = parseInt(snapshotBlock);
    if(!Number.isFinite(sb)) return false;
    let threshold = STAKE_WEIGHTED_QUORUM_ACTIVATION[network];
    if(threshold === undefined) return false;   // unknown network → off (safe)
    return sb >= threshold;
}

// Total active snapshot stake S = Σ weight over DISTINCT sources.
function totalStake(validators){
    let weightBySource = new Map();
    for(let v of (validators || [])){
        let src = String(v.source);
        if(!weightBySource.has(src))
            weightBySource.set(src, (v.weight === null || v.weight === undefined) ? '0' : String(v.weight));
    }
    let S = '0';
    for(let w of weightBySource.values()) S = bc.bcadd(S, w);
    return S;
}

// Source-deduped stake-weighted quorum test.
//   validators    — full snapshot: [{ pubkey, source, weight }]
//   signerPubkeys — iterable of pubkeys that produced a VALID signature
// Returns true iff 3·Σ(distinct signing-source weight) > 2·S. A source counts ONCE
// no matter how many of its keys signed (DELEGATE v0 additive). Degenerate cases
// fall out: single source → 3S>2S true; empty/zero set → 0>0 false.
function meetsStakeThreshold(validators, signerPubkeys){
    let weightBySource = new Map();
    let pubkeyToSource = new Map();
    for(let v of (validators || [])){
        let src = String(v.source);
        let pk  = String(v.pubkey).toLowerCase();
        pubkeyToSource.set(pk, src);
        if(!weightBySource.has(src))
            weightBySource.set(src, (v.weight === null || v.weight === undefined) ? '0' : String(v.weight));
    }
    let S = '0';
    for(let w of weightBySource.values()) S = bc.bcadd(S, w);
    let countedSources = new Set();
    let seenPubkeys    = new Set();
    let tally          = '0';
    for(let pk of (signerPubkeys || [])){
        let lpk = String(pk).toLowerCase();
        if(seenPubkeys.has(lpk)) continue;
        seenPubkeys.add(lpk);
        let src = pubkeyToSource.get(lpk);
        if(src === undefined) continue;
        if(countedSources.has(src)) continue;
        countedSources.add(src);
        tally = bc.bcadd(tally, weightBySource.get(src));
    }
    return bc.bcgt(bc.bcmul(tally, '3'), bc.bcmul(S, '2'));
}

module.exports = {
    STAKE_WEIGHTED_QUORUM_ACTIVATION,
    isStakeWeightedQuorumActive,
    totalStake,
    meetsStakeThreshold,
};
