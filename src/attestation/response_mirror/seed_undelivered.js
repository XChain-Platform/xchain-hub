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
 **********************************************************************/

'use strict';

const crypto = require('crypto');

const RESPONSE_PAYLOAD = JSON.stringify({ seeded: true });
const SEED_META = JSON.stringify({ seeded: 'hub-seed-undelivered' });

class SeedNetworkError extends Error {
    constructor(network){
        super('Refusing to seed attestation response for network ' + JSON.stringify(network));
        this.name = 'SeedNetworkError';
    }
}

class SeedCollisionError extends Error {
    constructor(requestId){
        super('Refusing to replace an existing attestation response for request_id ' + requestId);
        this.name = 'SeedCollisionError';
    }
}

function assertSeedableNetwork(network){
    if(network !== 'testnet' && network !== 'regtest')
        throw new SeedNetworkError(network);
    return network;
}

function buildSeedRow(network, nowSeconds, randomBytes = crypto.randomBytes){
    const checkedNetwork = assertSeedableNetwork(network);
    const requestId = randomBytes(32).toString('hex');
    if(!/^[0-9a-f]{64}$/.test(requestId))
        throw new Error('randomBytes must return exactly 32 bytes');

    return {
        network:              checkedNetwork,
        request_id:           requestId,
        request_action_index: null,
        request_block_index:  null,
        provider_id:          'seed_probe',
        status:               'ok',
        response_payload:     RESPONSE_PAYLOAD,
        response_hash:        crypto.createHash('sha256').update(RESPONSE_PAYLOAD).digest('hex'),
        meta:                 SEED_META,
        effective_time:       nowSeconds,
        admit_block_btc:      null,
        signer_pubkeys:       '[]',
        signatures:           '[]',
        widen:                0,
        batch_action_index:   null,
        finalized_at:         nowSeconds
    };
}

async function seedUndeliveredResponse(db, opts = {}){
    const network = assertSeedableNetwork(opts.network);
    const nowSeconds = opts.nowSeconds === undefined
        ? Math.floor(Date.now() / 1000) : opts.nowSeconds;
    const row = buildSeedRow(network, nowSeconds, opts.randomBytes);
    const held = await db.getAttestationResponseMirrorRow(
        row.network, row.request_id, row.effective_time);
    if(Array.isArray(held) ? held.length > 0 : Boolean(held))
        throw new SeedCollisionError(row.request_id);

    if(opts.apply) await db.createAttestationResponseMirrorRow(row);
    return row;
}

module.exports = {
    SeedCollisionError,
    SeedNetworkError,
    assertSeedableNetwork,
    buildSeedRow,
    seedUndeliveredResponse
};
