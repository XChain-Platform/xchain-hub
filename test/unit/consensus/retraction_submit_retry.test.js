// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const RetractionConsensus = require('../../../src/consensus/retraction.js');
const { waitUntil } = require('../../helpers/waitUntil');

const VALIDATORS = [
    { pubkey: '02aa', source: 'source-a', weight: '100' },
    { pubkey: '02bb', source: 'source-b', weight: '100' }
];

function makeHub({ resolveBlock, resolveValidators } = {}){
    let peerManager = new EventEmitter();
    peerManager.broadcasts = [];
    peerManager.broadcast = (type, data) => peerManager.broadcasts.push({ type, data });
    let broadcaster = {
        deletions: [],
        broadcastDeletion(evt){ this.deletions.push(evt); }
    };
    return {
        identity: {
            getPubkeyHex: () => VALIDATORS[0].pubkey,
            sign: () => 'initiator-signature'
        },
        peerManager,
        hubDbBroadcaster: broadcaster,
        network: 'regtest',
        p2pConfig: {},
        capabilitySnapshot: {
            getWeightSnapshot: async () => ({ validators: await resolveValidators() }),
            getSnapshot: async () => ({ validators: await resolveValidators() })
        },
        resolveBtcLatestBlock: resolveBlock
    };
}

function event(table = 'cross_chain_calls'){
    return {
        table,
        source_chain: 'DOGE',
        from_action_index: 42,
        retraction_generation: 7
    };
}

function hasSignRequest(hub){
    return hub.peerManager.broadcasts.some(item => item.type === 'XRETRACT_SIGN_REQ');
}

describe('RetractionConsensus submit retry', function () {
    it('defers an empty validator set and opens a signing round on retry', async function () {
        let reads = 0;
        let hub = makeHub({
            resolveBlock: async () => 5000,
            resolveValidators: async () => (++reads === 1 ? [] : VALIDATORS)
        });
        let consensus = new RetractionConsensus(hub);
        consensus.retrySignReqMs = 5;
        consensus.roundTimeoutMs = 20;

        try {
            await consensus.submitLocal(event());
            assert.strictEqual(hub.hubDbBroadcaster.deletions.length, 0,
                'an unresolved quorum set must never fall through to unsigned broadcast');
            assert.strictEqual(hasSignRequest(hub), false);
            await waitUntil(() => hasSignRequest(hub), {
                label: 'a signing round after the validator set resolves'
            });
            assert.strictEqual(hub.hubDbBroadcaster.deletions.length, 0);
        } finally {
            consensus.stop();
        }
    });

    it('defers a null snapshot block and opens a signing round on retry', async function () {
        let reads = 0;
        let hub = makeHub({
            resolveBlock: async () => (++reads === 1 ? null : 5000),
            resolveValidators: async () => VALIDATORS
        });
        let consensus = new RetractionConsensus(hub);
        consensus.retrySignReqMs = 5;
        consensus.roundTimeoutMs = 20;

        try {
            await consensus.submitLocal(event());
            assert.strictEqual(hub.hubDbBroadcaster.deletions.length, 0,
                'an unknown gate state must never fall through to unsigned broadcast');
            assert.strictEqual(hasSignRequest(hub), false);
            await waitUntil(() => hasSignRequest(hub), {
                label: 'a signing round after the snapshot block resolves'
            });
            assert.strictEqual(hub.hubDbBroadcaster.deletions.length, 0);
        } finally {
            consensus.stop();
        }
    });

    it('still broadcasts a table outside the quorum class unsigned', async function () {
        let hub = makeHub({
            resolveBlock: async () => null,
            resolveValidators: async () => []
        });
        let consensus = new RetractionConsensus(hub);

        try {
            await consensus.submitLocal(event('price_snapshots'));
            assert.strictEqual(hub.hubDbBroadcaster.deletions.length, 1);
            assert.strictEqual(hub.hubDbBroadcaster.deletions[0].retraction_signatures, undefined);
            assert.strictEqual(hasSignRequest(hub), false);
        } finally {
            consensus.stop();
        }
    });
});
