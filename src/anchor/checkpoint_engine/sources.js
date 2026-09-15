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
 * State checkpoint engine - validator set, BTC tip and indexer reads
 *
 * The three things a round reads from outside the engine: the oracle_publish set at a
 * block, this hub's BTC snapshot block, and a chain's own indexer.
 *
 ********************************************************************/

'use strict';

const axios = require('axios');
const swq   = require('../../stake_weighted_quorum.js');

module.exports = {

    // Mirror CrossChainDexEngine.resolveCapabilityValidators (incl. regtest seam).
    // Source-keyed at/above STAKE_WEIGHTED_QUORUM (this.network + block), else legacy
    // count set (source='' , weight=amount). Uses the deployment network so the set is
    // resolved correctly at _tick, before the per-chain network is known.
    async resolveCapabilityValidators(capability, block){
        let validators = [];
        let weighted = swq.isStakeWeightedQuorumActive(block, this.network);
        if(this.capSnapshot){
            if(weighted){
                let snap = await this.capSnapshot.getWeightSnapshot(capability, block);
                if(snap && Array.isArray(snap.validators)){
                    validators = snap.validators.map(v => ({ pubkey: v.pubkey, source: String(v.source != null ? v.source : ''), weight: String(v.weight != null ? v.weight : '0'), amount: String(v.weight != null ? v.weight : '0') }));
                    // Carry the truncation flag through the .map so the quorum check fails
                    // closed on an over-cap weighted snapshot (SWQ-TRUNC parity with the sibling
                    // engines CrossChainDexEngine/CrossChainCallEngine and the indexer consumers;
                    // meetsStakeThreshold under-counts a truncated S, so a stake-evicted minority
                    // could otherwise clear the strict 2/3 bar and finalize a checkpoint a full
                    // snapshot would reject - the root of XHUB-TRUNC-1, which this engine missed).
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
        let b = this.hub._resolveBtcLatestBlock ? await this.hub._resolveBtcLatestBlock() : null;
        if(b != null) return b;
        return Number.isFinite(this._snapshotBlockOverride) ? this._snapshotBlockOverride : null;
    },

    async _indexerCall(coin, method, params){
        let ix = this.indexers[coin];
        if(!ix || !ix.url) throw new Error('no indexer url for ' + coin);
        let headers = { 'Content-Type': 'application/json' };
        if(ix.key) headers['x-api-key'] = ix.key;
        let resp = await axios.post(ix.url, { jsonrpc: '2.0', method, params: params || {}, id: 1 }, { headers, timeout: 15000 });
        if(resp.data && resp.data.error) throw new Error('indexer RPC error: ' + JSON.stringify(resp.data.error));
        return resp.data ? resp.data.result : null;
    }

};
