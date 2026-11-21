'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const RetractionConsensus = require('../../../../src/consensus/retraction.js');
const ValidatorIdentity = require('../../../../src/validators/identity.js');
const { DB_METHODS } = require('../../../helpers/mockHub.js');
const { waitUntil } = require('../../../helpers/waitUntil');

const EVENT = {
    table: 'cross_chain_calls', source_chain: 'DOGE', from_action_index: 42,
    to_action_index: 99, retraction_generation: 7, snapshot_block: 5000
};

function identity() {
    return new ValidatorIdentity(crypto.randomBytes(32).toString('hex'));
}

function makeHub(identities, failInserts) {
    const validators = identities.map((item, i) => ({
        pubkey: item.getPubkeyHex().toLowerCase(), source: 'source-' + i, weight: '100'
    }));
    const peerManager = new EventEmitter();
    peerManager.broadcast = () => {};
    const broadcaster = {
        deletions: [], rows: [],
        broadcastDeletion(evt) { this.deletions.push(evt); },
        broadcastRow(evt) { this.rows.push(evt); }
    };
    let inserts = 0;
    const db = {
        ...DB_METHODS,
        doQuery: async sql => {
            if (/INSERT IGNORE INTO capability_snapshots/.test(sql)) {
                inserts++;
                if (inserts <= failInserts) throw new Error('db unavailable');
            }
            return /^SELECT/.test(sql) ? [{ id: 1 }] : [];
        }
    };
    return {
        hub: {
            identity: identities[0], peerManager, hubDbBroadcaster: broadcaster, db,
            network: 'regtest',
            p2pConfig: { RETRACT_SIGN_RETRY_MS: 5, RETRACT_ROUND_TIMEOUT_MS: 20,
                RETRACT_FINALIZE_MAX_ATTEMPTS: 3 },
            capabilitySnapshot: {
                getWeightSnapshot: async () => ({ validators }),
                getSnapshot: async () => ({ validators })
            },
            resolveBtcLatestBlock: async () => 5000
        },
        broadcaster,
        insertAttempts: () => inserts
    };
}

describe('RetractionConsensus finalize retry', function () {
    it('retries a single-validator signed retraction without another submit', async function () {
        const fixture = makeHub([identity()], 1);
        const consensus = new RetractionConsensus(fixture.hub);
        try {
            const local = Object.assign({}, EVENT);
            delete local.snapshot_block;
            await consensus.submitLocal(local);
            await waitUntil(() => fixture.broadcaster.deletions.length === 1,
                { label: 'the retained signed retraction to stream after DB recovery' });
            assert.strictEqual(fixture.insertAttempts(), 2);
            assert.strictEqual(consensus.pending.size, 0);
            assert.strictEqual(consensus.finalized.size, 1);
        } finally {
            consensus.stop();
        }
    });

    it('retries one follower FINALIZED delivery with the verified signatures', async function () {
        const ids = [identity(), identity(), identity(), identity()];
        const fixture = makeHub(ids, 1);
        const consensus = new RetractionConsensus(fixture.hub);
        const canonical = RetractionConsensus.canonicalRetraction(EVENT);
        const signatures = ids.slice(0, 3).map(item => ({
            pubkey: item.getPubkeyHex().toLowerCase(), sig: item.sign(canonical)
        }));
        try {
            await consensus.handleFinalized({ data: { retraction: EVENT, signatures } });
            await waitUntil(() => fixture.broadcaster.deletions.length === 1,
                { label: 'the follower finalize retry to stream after DB recovery' });
            assert.strictEqual(fixture.broadcaster.deletions[0].retraction_signatures.length, 3);
            assert.strictEqual(consensus.pending.size, 0);
        } finally {
            consensus.stop();
        }
    });

    it('stops retrying after the configured attempt cap', async function () {
        const fixture = makeHub([identity()], Number.MAX_SAFE_INTEGER);
        fixture.hub.p2pConfig.RETRACT_FINALIZE_MAX_ATTEMPTS = 2;
        const consensus = new RetractionConsensus(fixture.hub);
        try {
            const local = Object.assign({}, EVENT);
            delete local.snapshot_block;
            await consensus.submitLocal(local);
            await waitUntil(() => consensus._finalizeRetriesExhausted === 1,
                { label: 'the finalize retry cap to be reached' });
            assert.strictEqual(fixture.broadcaster.deletions.length, 0);
            assert.strictEqual(fixture.insertAttempts(), 3);
            assert.strictEqual(consensus.pending.size, 0);
        } finally {
            consensus.stop();
        }
    });
});
