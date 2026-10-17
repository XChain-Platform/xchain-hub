'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The BTC tip reaches the cadence as whatever the hub's resolver returns. Both resolver
// paths return a Number today, but tick adds intervalBlocks to the tip and to the
// latch, and on a string that sum is concatenation ('100' + 6 is '1006'), so the
// cadence fired on every block; the co-sign freshness guard declined every request.
// The engine normalizes the height before any arithmetic.

const crypto                = require('crypto');
const { expect }            = require('chai');
const StateCheckpointEngine = require('../../../../../src/anchor/checkpoint_engine');
const ValidatorIdentity     = require('../../../../../src/validators/identity');
const { DB_METHODS }        = require('../../../../helpers/mockHub.js');
const { blockHashes, buildMesh } = require('./support/checkpoint_mesh.js');
const { waitUntil }  = require('../../../../helpers/waitUntil.js');

// A single-validator hub (rounds self-finalize) whose resolver returns `tipOf(block)`.
function soloEngine(tipOf, state) {
    const id = new ValidatorIdentity(crypto.createHash('sha256').update('solo').digest('hex'));
    const rows = [];
    const db = { ...DB_METHODS, async doQuery(sql, p) {
        if (sql.startsWith('INSERT IGNORE INTO state_checkpoints')) { rows.push(p[8]); return []; }
        if (sql.startsWith('SELECT MAX(')) return [{ last_block: null, max_seq: null }];
        return [];
    } };
    const hub = { db, network: 'regtest',
        p2pConfig: { CHECKPOINT_CHAINS: 'BTC', CHECKPOINT_CONFIRMATIONS: '0', CHECKPOINT_INTERVAL_BLOCKS: '6', BTC_INDEXER_URL: 'http://stub' },
        hubDbBroadcaster: { subscribers: new Set(), broadcastRow() {} },
        capabilitySnapshot: { async getWeightSnapshot() { return { validators: [{ pubkey: id.getPubkeyHex().toLowerCase(), source: 's', weight: '1' }] }; } },
        getIdentity: () => id, resolveBtcLatestBlock: async () => tipOf(state.tip) };
    const engine = new StateCheckpointEngine(hub);
    engine.indexerCall = async () => blockHashes(500, 'regtest');
    return { engine, rows };
}

async function cadenceOver(tipOf) {
    const state = { tip: 100 };
    const { engine, rows } = soloEngine(tipOf, state);
    await engine.start();
    for (let b = 100; b <= 160; b++) { state.tip = b; await engine.tick(); }
    await engine.stop();
    return rows;
}

describe('checkpoint cadence: a string-typed BTC tip', function () {
    this.timeout(10000);

    it('checkpoints once per interval, exactly as a numeric tip does', async function () {
        const asNumber = await cadenceOver(b => b);
        const asString = await cadenceOver(b => String(b));
        expect(asNumber).to.deep.equal([100, 106, 112, 118, 124, 130, 136, 142, 148, 154, 160]);
        expect(asString, 'string tip').to.deep.equal(asNumber);
    });

    it('a follower whose own tip resolves as a string still co-signs an on-cadence round', async function () {
        const bus = buildMesh({ n: 3 });
        for (const nd of bus.nodes) nd.hub.resolveBtcLatestBlock = async () => String(nd.btcTip);
        try {
            await bus.startAll();
            bus.setTip(100); await bus.tickAll();
            bus.setTip(106); await bus.tickAll();
            await waitUntil(() => bus.nodes.every(nd => bus.snapshots(nd).length === 2), { label: 'the 106 round on every hub' });
            for (const nd of bus.nodes) {
                expect(bus.snapshots(nd), 'hub ' + nd.i).to.deep.equal([100, 106]);
                expect(nd.engine._cosignDeclines.own_tip_unresolved, 'hub ' + nd.i).to.equal(0);
            }
        } finally { await bus.stopAll(); }
    });
});
