/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * ANCHOR archive - price rounds above the federation's common floor
 *
 * The archive leader carries only price rounds a co-signer that does not hold
 * them can still verify, so no follower is asked to co-sign a round it cannot
 * check, and rounds older than the federation's shared history stop wedging
 * every batch.
 *
 ********************************************************************/

'use strict';

const swq = require('../../../../consensus/stake_weighted_quorum.js');
const { getLogger } = require('../../../../observability');
const logger = getLogger();

function roundGroups(prices){
    const groups = new Map();
    for(const row of prices){
        const round = Number(row.round_number);
        if(!groups.has(round)) groups.set(round, []);
        groups.get(round).push(row);
    }
    return groups;
}

module.exports = {

    // Lowest pending price round the archive leader still reads; rounds below it were
    // all omitted under the common floor. Per process: a restart re-learns it.
    priceArchiveFloor(){
        return Number.isSafeInteger(this._priceArchiveFloor) ? this._priceArchiveFloor : 0;
    },

    // Keep the rounds a follower without the rows can verify. A follower that does not
    // hold a signature-proofed round judges it by its signature quorum over the shared
    // `price` set at its reference block (checkpoint_price_verify.js), so a round whose
    // set only this hub's local table resolves, or whose quorum fails over the shared
    // set, sits below the federation's common history: a follower would decline the
    // whole batch (archive_diverges_from_local) on every flush. Those rounds stay
    // pending; their prices are already on chain in the PRICE batches. Without a
    // shared snapshot source every hub reads its local table and nothing is omitted.
    async priceRoundsAboveCommonFloor(prices){
        if(!this.capSnapshot || !prices || prices.length === 0) return prices || [];
        const kept = [], omitted = [];
        let prefix = true;
        for(const [round, group] of roundGroups(prices)){
            const verdict = await this.priceRoundVerifiableWithoutHistory(group);
            if(verdict === true) kept.push(...group);
            else omitted.push(round);
            // Only a settled "below the floor" moves the floor; an unanswered read does not
            if(verdict !== false) prefix = false;
            if(verdict === false && prefix) this._priceArchiveFloor = Math.max(this.priceArchiveFloor(), round + 1);
        }
        if(omitted.length)
            logger.warn('StateAnchorPublisher: archive omits ' + omitted.length + ' price round(s) (' +
                        omitted[0] + ' to ' + omitted[omitted.length - 1] + ') that a co-signer without them ' +
                        'could not verify from the shared price set; they stay pending, next read from round ' +
                        this.priceArchiveFloor());
        return kept;
    },

    // True when a follower without the round can verify it, false when it cannot, and
    // null when the shared source failed to answer: that round sits out this batch but
    // does not move the floor, so a passing outage never skips a round for good.
    // A batch-proofed round carries no signatures, so a follower checks it only against
    // its own held rows and the floor cannot be read from the round; it is kept.
    async priceRoundVerifiableWithoutHistory(group){
        const first = group[0];
        if(!this.isSignatureProofedPrice(first)) return true;
        const block = Number(first.reference_block);
        let set;
        try { set = await this.resolveCapabilitySet('price', block, this.network, true); }
        catch(_e){ return null; }
        if(!set || set.length === 0) return false;
        return this.quorumVerified(this.priceSnapshotCanonical(group, this.network),
                                   this.parseSigs(first.consensus_proof), set,
                                   swq.isStakeWeightedQuorumActive(block, this.network));
    }

};
