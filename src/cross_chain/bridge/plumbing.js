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
 * XChain Hub - Bridge Shared Plumbing
 *
 * The helpers the three cross-chain engines keep in lockstep by design: the capability set a
 * row is verified against, its persist and mirror, the chain identity stamped on a record,
 * the amount compare the canonical uses, and the BTC-anchored snapshot block.
 *
 ********************************************************************/

const swq = require('../../stake_weighted_quorum.js');
const snapWrite = require('../../lib/capability_snapshot_write.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {
    // ---------------------------------------------------------------------------
    // Shared plumbing (the sibling engines' helpers, kept in lockstep by design)
    // ---------------------------------------------------------------------------

    async resolveCapabilityValidators(capability, block, network){
        let validators = [];
        let weighted = swq.isStakeWeightedQuorumActive(block, network);
        if(this.capSnapshot){
            if(weighted){
                let snap = await this.capSnapshot.getWeightSnapshot(capability, block);
                if(snap && Array.isArray(snap.validators)){
                    validators = snap.validators.map(v => ({
                        pubkey: v.pubkey, source: String(v.source != null ? v.source : ''),
                        weight: String(v.weight != null ? v.weight : '0'),
                        amount: String(v.weight != null ? v.weight : '0')
                    }));
                    // Carry the truncation marker through the .map or the consensus cannot fail
                    // closed on an over-cap weighted snapshot (meetsStakeThreshold under-counts S).
                    if(snap.truncated === true) validators.truncated = true;
                }
            } else {
                let snap = await this.capSnapshot.getSnapshot(capability, block);
                if(snap && Array.isArray(snap.validators)){
                    validators = snap.validators.map(v => ({
                        pubkey: v.pubkey, source: '',
                        weight: String(v.amount != null ? v.amount : '0'),
                        amount: String(v.amount != null ? v.amount : '0')
                    }));
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

    // Persist the qualifying validator set for (capability, block) and mirror each row, so
    // an off-BTC indexer can verify this record's signatures against a set it holds.
    // Returns the number of rows resolved; 0 is the fail-closed money-path signal.
    async persistCapabilitySnapshot(capability, block, network){
        let validators = await this.resolveCapabilityValidators(capability, block, network);
        // A TRUNCATED set is never mirrored: the marker fails this hub's own threshold check
        // closed, but it is a JS array property with no column behind it, so persisting the
        // capped rows would let an off-BTC verifier read a partial set as COMPLETE. Zero rows
        // is the fail-closed answer in both directions.
        if(validators && validators.truncated === true){
            logger.warn('CrossChainBridge: refusing to persist a TRUNCATED ' + capability +
                         ' capability snapshot at block ' + block +
                         ' (over the source cap; raise VALIDATOR_QUERY_LIMIT fleet-wide). No rows mirrored.');
            return 0;
        }
        let rows = await snapWrite.writeCapabilitySnapshotRows(
            this.db, capability, block, validators, await this.resolveBtcChainId(network));
        for(let row of rows){
            if(this.broadcaster){
                let r = await this.db.getCapabilitySnapshot(block, capability, row.signing_pubkey, row.source);
                if(r.length) this.broadcaster.broadcastRow({ table: 'capability_snapshots', row: r[0] });
            }
        }
        return validators.length;
    },

    // The chain instance these records belong to (the hash of BTC block 1 on the chain this
    // hub's Bitcoin indexer follows). Stamped so a mirror that survived a re-genesis can
    // refuse a record minted on the dead chain. Transport, never signed, and a lookup
    // failure must never fail a finalized record, so it degrades to NULL.
    async resolveBtcChainId(network){
        try {
            if(!this.db || typeof this.db.getChainTip !== 'function') return null;
            let tip = await this.db.getChainTip('bitcoin', network || this.network || '');
            return (tip && tip.chainId) ? tip.chainId : null;
        } catch(e){
            return null;
        }
    },

    // Trailing-zero-insensitive compare for the bcmath decimal strings the record carries.
    normalizeAmount(v){
        if(v === null || v === undefined) return '';
        let s = String(v).trim();
        if(s === '') return '';
        let neg = s.startsWith('-');
        if(neg) s = s.slice(1);
        let out = s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
        out = out.replace(/^0+(?=\d)/, '');
        return (neg && out !== '0') ? '-' + out : out;
    },

    amountsEqual(x, y){
        return this.normalizeAmount(x) === this.normalizeAmount(y);
    },

    _nowSeconds(){ return Math.floor(Date.now() / 1000); },

    // The BTC-anchored snapshot block. On a no-BTC regtest, fall back to the fixed
    // deterministic override the sibling engines share, so a record and the capability
    // snapshot it is verified against use one anchor.
    async resolveSnapshotBlock(){
        let b = this.hub.resolveBtcLatestBlock ? await this.hub.resolveBtcLatestBlock() : null;
        if(b != null) return b;
        return Number.isFinite(this._snapshotBlockOverride) ? this._snapshotBlockOverride : null;
    },
};
