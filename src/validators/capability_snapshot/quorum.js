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
 * XChain Hub - CapabilitySnapshot quorum and membership
 *
 * What a locked snapshot is used for once it exists: the federation-wide PBFT
 * quorum over it, and whether a pubkey belongs to it.
 * src/validators/capability_snapshot.js installs every method below on
 * CapabilitySnapshot.prototype, so callers keep writing snapshot.<method>().
 *
 ********************************************************************/

const { bftQuorumOrSingle } = require('../../lib/bft_quorum.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // Standard PBFT quorum over the FULL snapshot, floored at a simple
    // majority: max(2 * floor((N - 1) / 3) + 1, ceil((N + 1) / 2)). The bare
    // 2f+1 form degenerates to quorum=1 at N=3 (f=0), which would let a single
    // validator finalize alone.
    // Returns 0 when N <= 1 (single-node mode; caller bypasses consensus).
    //
    // NOTE: this is the federation-wide quorum (e.g. config-change Consensus
    // PBFT, where every staker participates). It is NOT used for attestation
    // PBFT. Those rounds only exchange messages within the REDUNDANCY-sized
    // responsible set, so AttestationConsensus.propose() computes its own
    // quorum over responsible.length instead of over the full count N here.
    getQuorum(snapshot) {
        if (!snapshot) return 0;
        // Alarm-and-proceed when the quorum is computed over a TRUNCATED snapshot
        // (#4479): the indexer hit VALIDATOR_QUERY_LIMIT, so `count` (and the
        // validator set) is capped below the true federation size and N here is a
        // floor, not the real N. We still finalize: every indexer truncates the
        // same way at the same block, so the capped set is cross-hub deterministic
        // and quorum stays consistent fleet-wide. Refusing would instead halt all
        // consensus the moment the validator set outgrows the limit, a worse
        // failure than a quorum over a deterministic cap. So raise a loud,
        // throttled operator warning (same idiom as onFetchError) telling the
        // operator to raise VALIDATOR_QUERY_LIMIT, and proceed. The warning is the
        // only safe lever here because the cap is invisible in N alone.
        if (snapshot.truncated === true) {
            let now = Date.now();
            if (now - this._truncWarnAt > this.cacheTtlMs) {
                this._truncWarnAt = now;
                logger.error('CapabilitySnapshot: quorum computed over a TRUNCATED validator-set snapshot ' +
                    '(capability=' + snapshot.capability + ' block=' + snapshot.blockIndex + ' count=' + snapshot.count +
                    '): the indexer hit VALIDATOR_QUERY_LIMIT, so N is CAPPED below the true federation size. ' +
                    'Quorum stays cross-hub deterministic (all indexers truncate identically) but is computed over a ' +
                    'partial set; raise the frozen VALIDATOR_QUERY_LIMIT consensus constant (coordinated fleet upgrade) on the indexers so the full validator set is returned.');
            }
        }
        // Coerce N from the raw indexer JSON. `count` can arrive as a STRING; left
        // uncoerced, `Math.ceil((N + 1) / 2)` string-concatenates ("5" + 1 -> "51")
        // and explodes the quorum (26-of-5 -> permanent consensus halt / DoS). Fall
        // back to the actual membership-set size when count is not a sane integer, so
        // a malformed count can never silently drop quorum to a single-node bypass.
        let N = Number(snapshot.count);
        if (!Number.isInteger(N) || N < 0) N = Array.isArray(snapshot.validators) ? snapshot.validators.length : 0;
        // N<=1: single node (0 = caller bypasses consensus). Above that, the
        // majority-floored BFT threshold (bft_quorum.js).
        return bftQuorumOrSingle(N, 0);
    },

    // Whether a pubkey appears in the snapshot's validator set (used to gate PBFT vote counting).
    isInSnapshot(snapshot, pubkey) {
        if (!snapshot || !pubkey) return false;
        let target = String(pubkey).toLowerCase();
        for (let v of snapshot.validators) {
            if (String(v.pubkey).toLowerCase() === target) return true;
        }
        return false;
    }
};
