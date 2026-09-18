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
 * XChain Hub - Call Shared Plumbing
 *
 * The helpers the three cross-chain engines keep in lockstep: the capability set a row is
 * verified against, the BTC-anchored snapshot block, and the forward margin a relayed row's
 * effective_time carries so every chain holds it before any chain applies it.
 *
 ********************************************************************/

const swq = require('../../consensus/stake_weighted_quorum.js');
const { relayMarginS } = require('../../lib/relay_margin.js');

module.exports = {
    // Source-keyed at/above STAKE_WEIGHTED_QUORUM activation, legacy count set below
    // it (source='' , weight=amount). Mirrors CrossChainDexEngine.resolveCapabilityValidators.
    async resolveCapabilityValidators(capability, block, network){
        let validators = [];
        let weighted = swq.isStakeWeightedQuorumActive(block, network);
        if(this.capSnapshot){
            if(weighted){
                let snap = await this.capSnapshot.getWeightSnapshot(capability, block);
                if(snap && Array.isArray(snap.validators)){
                    validators = snap.validators.map(v => ({ pubkey: v.pubkey, source: String(v.source != null ? v.source : ''), weight: String(v.weight != null ? v.weight : '0'), amount: String(v.weight != null ? v.weight : '0') }));
                    // Carry the truncation flag through the .map so the consensus fails
                    // closed on an over-cap weighted snapshot (SWQ-TRUNC parity with the
                    // indexer consumers; meetsStakeThreshold under-counts a truncated S).
                    if(snap.truncated === true) validators.truncated = true;
                }
            } else {
                let snap = await this.capSnapshot.getSnapshot(capability, block);
                if(snap && Array.isArray(snap.validators)){
                    validators = snap.validators.map(v => ({ pubkey: v.pubkey, source: '', weight: String(v.amount != null ? v.amount : '0'), amount: String(v.amount != null ? v.amount : '0') }));
                    // getSnapshot marks an over-cap COUNT set truncated too, and the persist
                    // guard reads the marker off this array, so carry it in both modes or the
                    // mirror takes a partial set below the stake-weighted flag day.
                    if(snap.truncated === true) validators.truncated = true;
                }
            }
        }
        if(validators.length === 0 && this._seedLocalValidator && this.identity){
            let pk = this.identity.getPubkeyHex();
            validators = [{ pubkey: pk, source: 'seed:' + String(pk).toLowerCase(), weight: '1', amount: '1' }];
        }
        return validators;
    },

    async resolveSnapshotBlock(){
        let b = this.hub.resolveBtcLatestBlock ? await this.hub.resolveBtcLatestBlock() : null;
        if(b != null) return b;
        return Number.isFinite(this._snapshotBlockOverride) ? this._snapshotBlockOverride : null;
    },

    nowSeconds(){ return Math.floor(Date.now() / 1000); },

    // effective_time to stamp on a relayed row: now + a forward margin sized to
    // the chain that GATES the row (dispatch -> the TARGET chain injects the
    // execution; result -> the SOURCE chain delivers the callback). Putting it in
    // the future of every chain's tip guarantees the row is present everywhere
    // before any chain reaches the block it applies at, so a live node and a
    // replaying node always inject at the same block. Capped under the follower
    // clock-skew bound (RELAY_MARGIN_MAX_S) so a large XCALL_RELAY_MARGIN_BLOCKS
    // can never produce a row a peer would reject, and FLOORED at the default
    // margin so XCALL_RELAY_MARGIN_BLOCKS=0 can no longer stamp the bare clock
    // second and re-open the very race the margin exists to close. The
    // operator tunes the margin up; the floor is not tunable, because followers
    // enforce a fixed floor of their own and a hub stamping under it would never
    // collect a quorum.
    relayEffectiveTime(gatingChain){
        return this.nowSeconds() + relayMarginS(gatingChain, this.relayMarginBlocks);
    },
};
