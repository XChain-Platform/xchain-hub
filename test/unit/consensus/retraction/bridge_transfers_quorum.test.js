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
const crypto = require('crypto');
const { EventEmitter } = require('events');
const sinon = require('sinon');

const RetractionConsensus = require('../../../../src/consensus/retraction.js');
const ValidatorIdentity = require('../../../../src/validators/identity.js');
const { getLogger } = require('../../../../src/observability');

const SNAPSHOT_BLOCK = 5000;
const BRIDGE_EVT = {
    table: 'bridge_transfers',
    source_chain: 'BTC',
    from_action_index: 2049,
    retraction_generation: 2,
    snapshot_block: SNAPSHOT_BLOCK
};
const BRIDGE_CANONICAL = 'XRETRACTV1|bridge_transfers|BTC|2049||2|5000';

function makeIdentity(){
    return new ValidatorIdentity(crypto.randomBytes(32).toString('hex'));
}

function makeHub(identity, identities){
    const validators = identities.map((item, index) => ({
        pubkey: item.getPubkeyHex().toLowerCase(),
        source: 'source-' + index,
        weight: '100'
    }));
    const peerManager = new EventEmitter();
    peerManager.broadcasts = [];
    peerManager.broadcast = (type, data) => peerManager.broadcasts.push({ type, data });
    return {
        identity,
        peerManager,
        hubDbBroadcaster: { broadcastDeletion: sinon.spy() },
        network: 'regtest',
        p2pConfig: { RETRACT_ROUND_TIMEOUT_MS: 5000, RETRACT_SIGN_RETRY_MS: 5000 },
        capabilitySnapshot: {
            getWeightSnapshot: async () => ({ validators }),
            getSnapshot: async () => ({ validators })
        },
        resolveBtcLatestBlock: async () => SNAPSHOT_BLOCK
    };
}

describe('bridge transfer retraction quorum', function () {
    afterEach(function () { sinon.restore(); });

    it('opens a signed round for a bridge_transfers retraction and never broadcasts unsigned', async function () {
        const identities = Array.from({ length: 7 }, makeIdentity);
        const hub = makeHub(identities[0], identities);
        const consensus = new RetractionConsensus(hub);
        try {
            const evt = {
                table: 'bridge_transfers',
                source_chain: 'BTC',
                from_action_index: 2049,
                retraction_generation: 2
            };
            await consensus.submitLocal(evt);

            assert.strictEqual(consensus.pending.size, 1, 'the signed round must remain open below quorum');
            assert.ok(hub.peerManager.broadcasts.some(item => item.type === 'XRETRACT_SIGN_REQ'));
            assert.strictEqual(hub.hubDbBroadcaster.broadcastDeletion.callCount, 0);
        } finally {
            consensus.stop();
        }
    });

    it('co-signs a bridge transfer request over the consumer canonical bytes', async function () {
        const leader = makeIdentity();
        const follower = makeIdentity();
        const hub = makeHub(follower, [leader, follower]);
        const consensus = new RetractionConsensus(hub);
        try {
            assert.strictEqual(RetractionConsensus.canonicalRetraction(BRIDGE_EVT), BRIDGE_CANONICAL);
            consensus.localIntents.set(RetractionConsensus.intentKey(BRIDGE_EVT), Date.now());
            await consensus.handleSignReq({ data: {
                retraction: BRIDGE_EVT,
                sig_pubkey: leader.getPubkeyHex().toLowerCase(),
                sig: leader.sign(BRIDGE_CANONICAL)
            }});

            const signed = hub.peerManager.broadcasts.find(item => item.type === 'XRETRACT_SIGN');
            assert.ok(signed, 'the follower must co-sign the locally observed bridge retraction');
            assert.ok(ValidatorIdentity.verify(
                BRIDGE_CANONICAL,
                signed.data.sig,
                follower.getPubkeyHex().toLowerCase()
            ));
        } finally {
            consensus.stop();
        }
    });

    it('keeps price tables unsigned and warns once per intent', async function () {
        const identity = makeIdentity();
        const hub = makeHub(identity, [identity]);
        const consensus = new RetractionConsensus(hub);
        const warn = sinon.stub(getLogger(), 'warn');
        const evt = {
            table: 'price_snapshots',
            source_chain: 'BTC',
            from_action_index: 2049,
            retraction_generation: 2
        };
        try {
            await consensus.submitLocal(evt);
            await consensus.submitLocal(evt);

            assert.strictEqual(hub.hubDbBroadcaster.broadcastDeletion.callCount, 2);
            assert.strictEqual(warn.callCount, 1);
            assert.match(String(warn.firstCall.args[0]), /broadcasting UNSIGNED retraction/);
            assert.match(String(warn.firstCall.args[0]), /price_snapshots\|BTC\|2049/);
        } finally {
            consensus.stop();
        }
    });
});
