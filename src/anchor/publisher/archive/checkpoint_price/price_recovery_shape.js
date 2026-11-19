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
 * ANCHOR publisher - archived price row shape the indexer recovery reader accepts
 *
 ********************************************************************/

'use strict';

const { archivedInteger } = require('../unheld_row.js');

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const PRICE_STATUSES = ['finalized', 'skipped', 'disputed'];
const INTEGER_COLUMNS = ['id', 'round_number', 'reference_block', 'block_timestamp',
    'validator_count', 'consensus_round'];
const NULLABLE_INTEGER_COLUMNS = ['admit_block_btc', 'admit_block_ltc', 'admit_block_doge'];

function nonEmptyText(value){
    return typeof value === 'string' && value.length > 0;
}

function validSignature(entry){
    return !!entry && typeof entry === 'object' && HEX64.test(String(entry.pubkey || '')) &&
        HEX128.test(String(entry.sig || ''));
}

function parseProof(raw){
    if(typeof raw !== 'string') return undefined;
    try { return JSON.parse(raw); } catch(_e) { return undefined; }
}

function validBatchProof(proof){
    if(!proof || typeof proof !== 'object' || Array.isArray(proof) ||
       !proof.batch || !Array.isArray(proof.sigs)) return false;
    const batch = proof.batch;
    return archivedInteger(batch.first_round) && archivedInteger(batch.last_round) &&
        archivedInteger(batch.btc_block_height) && batch.last_round >= batch.first_round &&
        proof.sigs.every(validSignature);
}

// The columns the held compare leaves out and the signature leaves uncovered. Quorum counting
// skips malformed signature entries, so the proof's own shape needs a check of its own.
function proofRefusal(row){
    const proof = parseProof(row.consensus_proof);
    if(proof === undefined || proof === null) return 'has malformed consensus_proof';
    if(Array.isArray(proof)){
        if(!proof.every(validSignature)) return 'has malformed proof signatures';
        if(row.status === 'finalized' && proof.length === 0) return 'has empty finalized proof';
        return null;
    }
    if(!validBatchProof(proof)) return 'has malformed proof shape';
    if(row.round_number < proof.batch.first_round || row.round_number > proof.batch.last_round)
        return 'falls outside its batch proof range';
    return null;
}

// Mirrors validatePrice in xchain-indexer/bin/recovery/checkpoint_price.js: a price row recovery
// would throw on fails the whole anchored batch, so a co-signer refuses it before signing.
function priceRecoveryRefusal(row){
    if(!row || typeof row !== 'object' || Array.isArray(row)) return 'has malformed shape';
    for(const name of INTEGER_COLUMNS)
        if(!archivedInteger(row[name])) return 'has malformed ' + name;
    for(const name of NULLABLE_INTEGER_COLUMNS)
        if(row[name] !== null && !archivedInteger(row[name])) return 'has malformed ' + name;
    for(const name of ['coin_pair', 'reference_chain'])
        if(!nonEmptyText(row[name])) return 'has malformed ' + name;
    if(row.price !== null && typeof row.price !== 'string') return 'has malformed price';
    if(!PRICE_STATUSES.includes(row.status)) return 'has malformed status';
    return proofRefusal(row);
}

module.exports = { priceRecoveryRefusal };
