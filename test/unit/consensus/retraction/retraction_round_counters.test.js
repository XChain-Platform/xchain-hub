'use strict';


// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
//
// RetractionConsensus: the counts the scrape reads for a signing round that loses
// quorum and for every unsigned broadcast, by reason.

const assert = require('assert');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const RetractionConsensus = require('../../../../src/consensus/retraction.js');
const ValidatorIdentity   = require('../../../../src/validators/identity.js');
const { waitUntil }       = require('../../../helpers/waitUntil');
const { DB_METHODS }      = require('../../../helpers/mockHub.js');

function makeIdentity(){
    return new ValidatorIdentity(crypto.randomBytes(32).toString('hex'));
}

function makeHub({ identity, validators, p2p = {} }){
    const peerManager = new EventEmitter();
    peerManager.broadcast = () => {};
    const broadcaster = { deletions: [], rows: [],
        broadcastDeletion(evt){ this.deletions.push(evt); },
        broadcastRow(evt){ this.rows.push(evt); } };
    const db = { ...DB_METHODS, doQuery: async () => [] };
    return {
        identity, peerManager, hubDbBroadcaster: broadcaster, db, network: 'regtest', p2pConfig: p2p,
        capabilitySnapshot: {
            getWeightSnapshot: async () => ({ validators }),
            getSnapshot: async () => ({ validators })
        },
        resolveBtcLatestBlock: async () => 5000
    };
}

const CALL = { table: 'cross_chain_calls', source_chain: 'DOGE', from_action_index: 42, retraction_generation: 7 };

describe('RetractionConsensus round counters', function () {
    it('starts every count at zero', function () {
        const rc = new RetractionConsensus(makeHub({ identity: null, validators: [] }));
        assert.strictEqual(rc._roundTimeouts, 0);
        assert.deepStrictEqual(rc.unsignedFallbackCount,
            { round_timeout: 0, out_of_class: 0, no_signing_deps: 0, gate_inactive: 0 });
        rc.stop();
    });

    it('counts a signing round that times out below quorum as a timeout and a round_timeout fallback', async function () {
        const ids = [makeIdentity(), makeIdentity(), makeIdentity()];
        const validators = ids.map((i, n) => ({ pubkey: i.getPubkeyHex().toLowerCase(), source: 'src' + n, weight: '100' }));
        const hub = makeHub({ identity: ids[0], validators, p2p: { RETRACT_ROUND_TIMEOUT_MS: 40, RETRACT_SIGN_RETRY_MS: 15 } });
        const rc = new RetractionConsensus(hub);
        await rc.submitLocal(CALL);
        assert.strictEqual(rc._roundTimeouts, 0, 'no timeout while the round is open');
        await waitUntil(() => hub.hubDbBroadcaster.deletions.length === 1, { label: 'the timed-out round to fall back unsigned' });
        assert.strictEqual(rc._roundTimeouts, 1);
        assert.strictEqual(rc.unsignedFallbackCount.round_timeout, 1);
        assert.strictEqual(rc.unsignedFallbackCount.gate_inactive, 0);
        rc.stop();
    });

    it('counts a repeat fallback for the same intent although the warn is deduped', async function () {
        const hub = makeHub({ identity: null, validators: [] });
        const rc = new RetractionConsensus(hub);
        await rc.submitLocal(CALL);
        await rc.submitLocal(CALL);
        assert.strictEqual(rc.unsignedFallbackCount.no_signing_deps, 2);
        assert.strictEqual(rc._roundTimeouts, 0);
        rc.stop();
    });

    it('counts a table outside the quorum class as out_of_class, not as a lost round', async function () {
        const id = makeIdentity();
        const validators = [{ pubkey: id.getPubkeyHex().toLowerCase(), source: 'srcA', weight: '100' }];
        const rc = new RetractionConsensus(makeHub({ identity: id, validators }));
        await rc.submitLocal({ table: 'price_snapshots', source_chain: 'BTC', from_action_index: 5, retraction_generation: 1 });
        assert.strictEqual(rc.unsignedFallbackCount.out_of_class, 1);
        assert.strictEqual(rc.unsignedFallbackCount.round_timeout, 0);
        assert.strictEqual(rc._roundTimeouts, 0);
        rc.stop();
    });

    it('counts a retraction below the signing gate as gate_inactive', async function () {
        const id = makeIdentity();
        const validators = [{ pubkey: id.getPubkeyHex().toLowerCase(), source: 'srcA', weight: '100' }];
        const hub = makeHub({ identity: id, validators });
        hub.network = 'mainnet';
        const rc = new RetractionConsensus(hub);
        await rc.submitLocal(CALL);
        assert.strictEqual(rc.unsignedFallbackCount.gate_inactive, 1);
        rc.stop();
    });
});
