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
 * XChain Hub - Count-based PBFT quorum threshold (, flag-day Pkg 7)
 *
 * THE single hub-side definition of the count-based (non-stake-weighted) PBFT
 * quorum size. Before this extraction the identical arithmetic
 *
 *     Math.max(2 * Math.floor((N - 1) / 3) + 1, Math.ceil((N + 1) / 2))
 *
 * was hand-copied into ~15 consensus sites (Consensus, OracleConsensus,
 * CrossChainEngine, ReorgHandler, CapabilitySnapshot, StateCheckpointEngine,
 * RetractionConsensus, CrossChainDexConsensus, StateAnchorPublisher,
 * PriceAggregator, AttestationConsensus). It is CONSENSUS-CRITICAL: a single
 * divergent copy computes a different threshold and forks the chain, so the
 * arithmetic now lives here once and every site resolves through it.
 *
 * The bare 2f+1 form (f = floor((N-1)/3)) degenerates to 1 at N=3 (f=0), which
 * would let a lone validator finalize a round by itself; the ceil((N+1)/2)
 * simple-majority floor prevents that. `bftQuorum` is that majority-floored
 * threshold for a live membership set of size N >= 2.
 *
 * This function does NOT coerce N. Callers derive their own membership count -
 * some from a block-locked snapshot, some falling back to a live peer count,
 * some to a validator-set array length - and their safe single-node fallback
 * differs (0 for "no consensus needed / caller bypasses", 1 for "self-sign
 * satisfies quorum"). `bftQuorumOrSingle` folds that N<=1 branch in with an
 * explicit caller-chosen single-node value so the two shapes stay in one place.
 *
 * Not part of the byte-identity-vendored consensus set (stake_weighted_quorum.js
 * / equivocation_header.js): this is a hub-local dedup of an arithmetic each
 * repo already carries inline, numerically identical to the pre-extraction
 * expression. The unit suite pins that identity across N.
 *
 ********************************************************************/

'use strict';

// Majority-floored Byzantine quorum for a membership set of size n (n >= 2).
// Equivalent to max(2f+1, ceil((n+1)/2)) with f = floor((n-1)/3).
function bftQuorum(n){
    return Math.max(2 * Math.floor((n - 1) / 3) + 1, Math.ceil((n + 1) / 2));
}

// bftQuorum with the single-node branch folded in. `singleNodeQuorum` is the
// value the caller wants when n <= 1 (0 = "no peer to reach, caller bypasses
// consensus"; 1 = "the sole validator's self-signature is the whole quorum").
function bftQuorumOrSingle(n, singleNodeQuorum){
    return (n <= 1) ? singleNodeQuorum : bftQuorum(n);
}

module.exports = { bftQuorum, bftQuorumOrSingle };
