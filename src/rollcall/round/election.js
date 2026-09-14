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
 * XChain Hub - ROLLCALL round: election
 *
 * Who publishes an epoch: the chain-derived election key, the candidate order
 * borrowed from the anchor rail, and the rank ladder that unlocks sweepers.
 *
 * src/rollcall/round.js installs every method below on RollcallRound.prototype,
 * non-enumerable like the class's own methods, so callers and tests keep
 * reaching them as round.<method>().
 *
 ********************************************************************/

'use strict';

const StateAnchorPublisher = require('../../anchor/publisher.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // ── elect ────────────────────────────────────────────────────────────────

    // The election key. Identical on every hub because both fields are chain-
    // derived, and STABLE while the tip advances, which is what makes the ladder
    // climbable: E is fixed, so `since` grows across the whole accept window and
    // floor(window / tolerance) ranks unlock inside it. The anchor ladder is inert
    // on the bundle rail only because a checkpoint's snapshot_block chases the tip.
    _electionKey(epoch){
        return 'XROLLCALL|' + this.network + '|' + String(epoch);
    },

    // The candidate set: effective keys of the oracle_publish capability set, the
    // SAME set the BTC close uses as R(E).
    //
    // The height passed is the RAW epoch. CapabilitySnapshot applies
    // CANONICAL_REORG_BUFFER itself (_buriedBlockIndex), so this resolves at
    // E - 6 = buriedSnapshotBlock(E, network), which is where the chain resolves
    // R(E). Passing an already-buried height here would bury twice and elect from
    // E - 12, forking the hub's leader from the one the close pays.
    //
    // Returns null when the set is unresolved, and every caller treats null as
    // abstain: an empty order would make _rankUnlocked false for everyone anyway,
    // but null says WHY, and it must never be read as "the federation is empty".
    async _electionOrder(epoch){
        let keys = null;
        try {
            let sap = this.hub && this.hub.stateAnchorPublisher;
            if(sap && typeof sap._resolveCapabilitySet === 'function'){
                // Borrowed rather than re-derived: the anchor rail already owns
                // the resolver that fails closed off regtest and picks the
                // source-keyed weighted form, and two copies of that logic would
                // be two ways to disagree with the chain.
                let set = await sap._resolveCapabilitySet('oracle_publish', epoch, this.network);
                if(Array.isArray(set)) keys = set.map(v => String(v.pubkey).toLowerCase());
            } else if(this.capabilitySnapshot && typeof this.capabilitySnapshot.getWeightSnapshot === 'function'){
                // The weighted form specifically: the chain's R(E) is
                // getStakeWeightsByCapability, which is source-keyed and carries
                // delegated effective keys the count form does not.
                let snap = await this.capabilitySnapshot.getWeightSnapshot('oracle_publish', epoch);
                if(snap && Array.isArray(snap.validators))
                    keys = snap.validators.map(v => String(v.pubkey).toLowerCase());
            }
        } catch(e){
            logger.warn('RollcallRound: epoch=' + epoch + ' election set unresolved (' +
                         (e && e.message ? e.message : e) + '); abstaining from publishing');
            return null;
        }
        if(keys === null) return null;
        return StateAnchorPublisher.hashOrder(this._electionKey(epoch), keys);
    },

    // Rank 0 may publish immediately; each further rank unlocks after another
    // ROLLCALL_ELECTION_TOLERANCE_BLOCKS of BTC height past the epoch. Blocks, not
    // wall clock, so every hub computes the same unlock with no clock sync. A key
    // outside the order never publishes.
    _rankUnlocked(order, pubkey, sinceBlocks){
        if(!order) return false;
        let rank = order.indexOf(String(pubkey || '').toLowerCase());
        if(rank < 0) return false;
        if(rank === 0) return true;
        let unlocked = Number.isFinite(sinceBlocks)
            ? Math.floor(Math.max(0, sinceBlocks) / this.electionToleranceBlocks) : 0;
        return rank <= unlocked;
    }
};
