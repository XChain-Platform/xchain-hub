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
 * XChain Hub - DEX Shared Plumbing
 *
 * The helpers the three cross-chain engines keep in lockstep: the capability set a match is
 * verified against, the clock second a row is stamped at, and the BTC-anchored snapshot
 * block a round and its capability snapshot share.
 *
 ********************************************************************/

const swq = require('../../stake_weighted_quorum.js');

module.exports = {
    // Resolve the qualifying validator set, normalized to { pubkey, source, weight, amount }.
    // At/above STAKE_WEIGHTED_QUORUM activation (keyed on the BTC snapshot_block +
    // network) this fetches the SOURCE-KEYED weights; below it, the legacy count set
    // (source='' , weight=amount): byte-for-byte the old membership/values, so the
    // pre-activation path and mirror rows are unchanged.
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
            // Synthetic single-source seed: weight 1 trivially clears 3·1 > 2·1.
            validators = [{ pubkey: pk, source: 'seed:' + String(pk).toLowerCase(), weight: '1', amount: '1' }];
        }
        return validators;
    },

    nowSeconds(){ return Math.floor(Date.now() / 1000); },

    // Resolve the BTC-anchored snapshot block. In a no-BTC regtest, fall back to a fixed
    // deterministic override (XDEX_SNAPSHOT_BLOCK) so the match + capability snapshot share
    // a consistent anchor. Production always resolves the live BTC tip (override unset).
    async resolveSnapshotBlock(){
        let b = this.hub.resolveBtcLatestBlock ? await this.hub.resolveBtcLatestBlock() : null;
        if(b != null) return b;
        return Number.isFinite(this._snapshotBlockOverride) ? this._snapshotBlockOverride : null;
    },
};
