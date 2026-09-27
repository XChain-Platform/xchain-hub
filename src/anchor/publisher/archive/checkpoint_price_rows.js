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
 * ANCHOR publisher - archived checkpoint and price rows
 *
 ********************************************************************/

'use strict';

const StateCheckpointEngine = require('../../checkpoint_engine.js');
const OracleConsensus = require('../../../oracle/consensus.js');
const admissionHeight = require('../../../lib/admission_height.js');
const { CHECKPOINT_KEYS, PRICE_KEYS } = require('../constants.js');

const INTEGER_KEYS = new Set(['id', 'block_index', 'checkpoint_seq', 'snapshot_block',
    'round_number', 'reference_block', 'block_timestamp', 'validator_count',
    'consensus_round', 'batch_block_time']);
const NULLABLE_INTS = new Set(['state_root_version', 'block_merkle_version',
    'source_action_index', 'admit_block_btc', 'admit_block_ltc', 'admit_block_doge']);
const NULLABLE_TEXT = new Set(['state_root', 'block_merkle_root', 'price']);

function archivedValue(key, value){
    if(INTEGER_KEYS.has(key)) return Number(value);
    if(NULLABLE_INTS.has(key)) return value == null ? null : Number(value);
    if(NULLABLE_TEXT.has(key)) return value == null ? null : String(value);
    if(key === 'validator_signatures' || key === 'consensus_proof') return value;
    return String(value == null ? '' : value);
}

function serializeByKeys(keys, row){
    const out = {};
    for(const key of keys) out[key] = archivedValue(key, row[key]);
    return out;
}

function compareText(a, b){
    a = String(a);
    b = String(b);
    return a < b ? -1 : a > b ? 1 : 0;
}

function compareInteger(a, b){
    const x = BigInt(String(a));
    const y = BigInt(String(b));
    return x < y ? -1 : x > y ? 1 : 0;
}

function signatureProof(proof){
    if(typeof proof === 'string'){
        try { proof = JSON.parse(proof); }
        catch(e) { return false; }
    }
    return Array.isArray(proof) && proof.length > 0;
}

module.exports = {

    serializeStateCheckpoint(row){
        return serializeByKeys(CHECKPOINT_KEYS, row);
    },

    serializePriceSnapshot(row){
        return serializeByKeys(PRICE_KEYS, row);
    },

    serializePriceTombstone(row){
        return { round_number: Number(row.round_number), coin_pair: String(row.coin_pair) };
    },

    sortedStateCheckpoints(rows){
        return (rows || []).slice().sort((a, b) => compareText(a.chain, b.chain) ||
            compareText(a.network, b.network) || compareInteger(a.checkpoint_seq, b.checkpoint_seq));
    },

    sortedPriceSnapshots(rows){
        return (rows || []).slice().sort((a, b) => compareInteger(a.round_number, b.round_number) ||
            compareText(a.coin_pair, b.coin_pair));
    },

    sortedPriceTombstones(rows){
        return (rows || []).slice().sort((a, b) => compareInteger(a.round_number, b.round_number) ||
            compareText(a.coin_pair, b.coin_pair));
    },

    isSignatureProofedPrice(row){
        return signatureProof(row && row.consensus_proof);
    },

    stateCheckpointCanonical(row){
        return StateCheckpointEngine.canonicalCheckpoint(row);
    },

    priceSnapshotCanonical(rows, network){
        rows = this.sortedPriceSnapshots(rows);
        if(rows.length === 0) throw new Error('price snapshot canonical requires a round');
        const first = rows[0];
        const pairs = rows.map(row => ({ coinPair: row.coin_pair, price: row.price }));
        return OracleConsensus.prototype.buildPriceV0Payload.call(
            { hub: { network: network == null ? this.network : network } },
            first.round_number, first.block_timestamp,
            pairs, first.reference_block, admissionHeight.rowAdmitBlocks(first));
    },

    async backfillCheckpointPriceRows(batchSeq, checkpointIds, priceIds, tombstoneIds){
        for(const checkpoint of (checkpointIds || []))
            await this.db.updateStateCheckpointArchiveBatchSeq(
                batchSeq, checkpoint.chain, checkpoint.network, checkpoint.checkpoint_seq);
        for(const price of (priceIds || []))
            await this.db.updatePriceSnapshotArchiveBatchSeq(
                batchSeq, price.status, price.batch_block_time, price.proof_sha,
                price.round_number, price.coin_pair);
        for(const tombstone of (tombstoneIds || []))
            await this.db.updatePriceTombstoneArchiveBatchSeq(
                batchSeq, tombstone.round_number, tombstone.coin_pair);
    }

};
