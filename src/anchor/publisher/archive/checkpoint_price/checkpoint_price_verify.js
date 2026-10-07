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
 * ANCHOR publisher - archived checkpoint and price verification
 *
 ********************************************************************/

'use strict';

const { resolveQuorumNetwork } = require('../../../quorum_network.js');
const swq = require('../../../../consensus/stake_weighted_quorum.js');
const { getLogger } = require('../../../../observability');
const logger = getLogger();

function withoutKeys(row, keys){
    const out = Object.assign({}, row);
    for(const key of keys) delete out[key];
    return out;
}

function sameRowExcept(local, archived, keys){
    return JSON.stringify(withoutKeys(local, keys)) ===
        JSON.stringify(withoutKeys(archived, keys));
}

function sameRow(local, archived){
    return sameRowExcept(local, archived, ['id']);
}

function samePriceRow(local, archived, signatureProofed){
    const keys = signatureProofed ? ['id', 'consensus_proof', 'validator_count'] : ['id'];
    return sameRowExcept(local, archived, keys);
}

function findHeldPriceRow(held, archived, signatureProofed){
    const local = (held || []).find(candidate =>
        String(candidate.coin_pair) === String(archived.coin_pair));
    if(signatureProofed && local && String(local.status) === 'skipped') return null;
    return local;
}

function hasHeldLivePriceRow(held, archived){
    return (held || []).some(candidate =>
        String(candidate.coin_pair) === String(archived.coin_pair) &&
        String(candidate.status) !== 'skipped');
}

function priceGroupKey(row){
    return JSON.stringify([Number(row.round_number), row.consensus_proof]);
}

function priceGroups(rows){
    const groups = new Map();
    for(const row of (rows || [])){
        const key = priceGroupKey(row);
        if(!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
    }
    return groups.values();
}

function sameSignedPriceFields(first, row){
    const keys = ['round_number', 'reference_block', 'block_timestamp',
        'admit_block_btc', 'admit_block_ltc', 'admit_block_doge'];
    return keys.every(key => String(first[key]) === String(row[key]));
}

module.exports = {

    async verifyArchivedStateCheckpoint(row){
        const held = await this.db.getStateCheckpointByChainAndNetworkAndCheckpointSeq(
            row.chain, row.network, Number(row.checkpoint_seq));
        if(held && held.length &&
           !sameRow(this.serializeStateCheckpoint(held[0]), row)){
            logger.warn('StateAnchorPublisher: archive checkpoint ' + row.chain + '/' +
                        row.network + '/' + row.checkpoint_seq +
                        ' differs from our row; NOT signing');
            return false;
        }
        const network = resolveQuorumNetwork(row, this.network);
        const block = Number(row.snapshot_block);
        const set = await this.resolveCapabilitySet('oracle_publish', block, network);
        const weighted = swq.isStakeWeightedQuorumActive(block, network);
        if(!this.quorumVerified(this.stateCheckpointCanonical(row),
                                this.parseSigs(row.validator_signatures), set, weighted)){
            logger.warn('StateAnchorPublisher: archive checkpoint ' + row.chain + '/' +
                        row.network + '/' + row.checkpoint_seq +
                        ' fails signature quorum at block ' + row.snapshot_block);
            return false;
        }
        return true;
    },

    async verifyArchivedPriceSnapshots(rows, archive){
        for(const group of priceGroups(rows)){
            if(!(await this.verifyArchivedPriceGroup(group, archive))) return false;
        }
        return true;
    },

    async verifyArchivedPriceGroup(group, archive){
        const first = group[0];
        if(!Number.isFinite(Number(first.round_number)) ||
           group.some(row => !sameSignedPriceFields(first, row))){
            logger.warn('StateAnchorPublisher: archive price group has inconsistent signed fields; NOT signing');
            return false;
        }
        const held = await this.db.findPriceSnapshotsForRound(Number(first.round_number));
        const signatureProofed = this.isSignatureProofedPrice(first);
        for(const row of group){
            const local = findHeldPriceRow(held, row, signatureProofed);
            if(local && !samePriceRow(this.serializePriceSnapshot(local), row, signatureProofed)){
                logger.warn('StateAnchorPublisher: archive price ' + row.round_number + '/' +
                            row.coin_pair + ' differs from our row; NOT signing');
                return false;
            }
            if(!local && !this.isSignatureProofedPrice(row)){
                logger.warn('StateAnchorPublisher: archive price ' + row.round_number + '/' +
                            row.coin_pair + ' has no verifiable proof or held row; NOT signing');
                return false;
            }
        }
        if(!signatureProofed) return true;
        const block = Number(first.reference_block);
        const network = resolveQuorumNetwork(archive, this.network);
        const set = await this.resolveCapabilitySet('price', block, network);
        const weighted = swq.isStakeWeightedQuorumActive(block, network);
        const sigs = this.parseSigs(first.consensus_proof);
        if(!this.quorumVerified(this.priceSnapshotCanonical(group, network), sigs, set, weighted)){
            logger.warn('StateAnchorPublisher: archive price round ' + first.round_number +
                        ' fails signature quorum at block ' + first.reference_block);
            return false;
        }
        return true;
    },

    async verifyArchivedPriceTombstone(row){
        const held = await this.db.findPriceSnapshotsForRound(Number(row.round_number));
        if(hasHeldLivePriceRow(held, row)){
            logger.warn('StateAnchorPublisher: archive price tombstone ' + row.round_number + '/' +
                        row.coin_pair + ' conflicts with our live row; NOT signing');
            return false;
        }
        return true;
    }

};
