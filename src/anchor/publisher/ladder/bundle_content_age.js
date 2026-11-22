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
 * ANCHOR publisher - v0 bundle failover ladder age
 *
 * How old the content a v0 bundle owes is, for the leader's publish decision and
 * both follower checks (the attestation co-sign and BUNDLE_DONE), so the three agree
 * on which backup rank has unlocked.
 *
 ********************************************************************/

'use strict';

const canonicalForms = require('../canonical_forms.js');
const { getLogger } = require('../../../observability');
const logger = getLogger();

module.exports = {

    // The BTC height publishBundle measures the ladder from: shifted so that its
    // `btcBlock - snapshotBlock` equals the age of the oldest content the bundle owes
    // (`contentBlock`, from bundleContentBlock), not the age of the newest section.
    bundleLadderBlock(sections, btcBlock, contentBlock){
        if(!Number.isFinite(btcBlock)) return btcBlock;
        const blocks = (sections || []).map(section => Number(section.snapshot_block));
        const snapshotBlock = Math.max(0, ...blocks);
        const oldest = Number.isFinite(contentBlock) ? contentBlock : Math.min(snapshotBlock, ...blocks);
        return btcBlock + snapshotBlock - Math.min(oldest, snapshotBlock);
    },

    // Oldest BTC height of checkpoint content this bundle owes: its own oldest section,
    // or, earlier, the first eligible checkpoint of one of its chains since that chain's
    // last anchor. A section is replaced by a newer checkpoint every cadence step, so its
    // own height never ages past one step and the backup ranks would never unlock.
    // Leader and followers both read it here, from their own rows. The leader passes
    // `bundleEligible` and counts only rows a bundle could carry; followers keep the
    // wider age, whose rows are a superset, so any rank a leader unlocks is unlocked at
    // every follower whichever of the two ages that follower reads.
    async bundleContentBlock(network, sections, bundleEligible){
        let block = Math.min(...sections.map(section => Number(section.snapshot_block)));
        const chains = new Set(sections.map(section => String(section.chain)));
        const rows = bundleEligible ? await this.oldestBundleEligibleCheckpointBlocks(network)
                                    : await this.oldestUnanchoredCheckpointBlocks(network);
        for(const row of rows){
            const oldest = Number(row.oldest_block);
            if(chains.has(String(row.chain)) && Number.isSafeInteger(oldest) && oldest >= 0 && oldest < block)
                block = oldest;
        }
        return block;
    },

    // A failed read falls back to the sections' own heights, which only keeps ranks locked.
    async oldestUnanchoredCheckpointBlocks(network){
        if(!this.db || typeof this.db.findOldestUnanchoredCheckpointBlocksByNetwork !== 'function') return [];
        try {
            return (await this.db.findOldestUnanchoredCheckpointBlocksByNetwork(
                this.checkpointIntervalBlocks, this.anchorEveryNCheckpoints, String(network))) || [];
        } catch(e){
            logger.warn('StateAnchorPublisher: oldest unanchored checkpoint read failed for ' + network +
                        '; measuring the bundle ladder from its own sections: ' + (e && e.message));
            return [];
        }
    },

    // The age above restricted to rows groupSectionsByNetwork and the pending selector
    // would let ride a bundle. Any failure reads the wider age instead, so failover is
    // never weaker than with the wider age alone.
    async oldestBundleEligibleCheckpointBlocks(network){
        const floor = typeof this.commitmentFloorBlock === 'function' ? this.commitmentFloorBlock(network) : null;
        if(!Number.isSafeInteger(floor) || !this.db ||
           typeof this.db.findOldestBundleEligibleCheckpointBlocksByNetwork !== 'function')
            return this.oldestUnanchoredCheckpointBlocks(network);
        try {
            return (await this.db.findOldestBundleEligibleCheckpointBlocksByNetwork(
                this.checkpointIntervalBlocks, this.anchorEveryNCheckpoints, String(network), floor)) || [];
        } catch(e){
            logger.warn('StateAnchorPublisher: bundle-eligible checkpoint age read failed for ' + network +
                        '; measuring the bundle ladder from the unanchored age: ' + (e && e.message));
            return this.oldestUnanchoredCheckpointBlocks(network);
        }
    },

    // Follower half of the ladder: is `sender` rank-unlocked for the bundle over `rows`
    // (our own copies of its sections) at our BTC tip? Same order as the leader's
    // publishBundle, measured from the wider unanchored age, which is never younger than
    // the leader's, so a backup the leader side unlocks is accepted here.
    async bundleSenderUnlocked(network, snapshotBlock, electionSet, sender, rows){
        const order = canonicalForms.hashOrder(
            this.bundleElectionKey({ network: network, snapshot_block: snapshotBlock }), electionSet);
        const myBtc = this.hub.resolveBtcLatestBlock ? await this.hub.resolveBtcLatestBlock() : null;
        const since = Number.isFinite(myBtc) ? myBtc - await this.bundleContentBlock(network, rows) : null;
        return this.rankUnlocked(order, sender, since);
    }

};
