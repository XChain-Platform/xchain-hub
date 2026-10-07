'use strict';

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
 ********************************************************************/

const assert = require('assert');
const EventEmitter = require('events');

const persist = require('../../../../../src/cross_chain/list/persist.js');

function row(snapshotId){
    return { snapshot_id: snapshotId, snapshot_block: 50, network: 'regtest' };
}

function makeEngine(){
    const calls = { inserted: [], forgotten: [], broadcast: [], resync: [], finalized: [] };
    const engine = Object.assign(new EventEmitter(), persist, {
        _inflight: new Set(),
        listConsensus: {
            forgetFinalized(snapshotId){ calls.forgotten.push(snapshotId); }
        },
        async persistCapabilitySnapshot(){ return 1; },
        async resolveBtcChainId(){ return 'chain-id'; },
        db: {
            async insertListSnapshot(value){
                calls.inserted.push(value);
                return true;
            },
            async getListSnapshotBySnapshotId(snapshotId){
                return [{ snapshot_id: snapshotId, committed: true }];
            }
        },
        broadcaster: {
            subscribers: new Set(['subscriber']),
            broadcastRow(message){ calls.broadcast.push(message); },
            dropAllForResync(reason){ calls.resync.push(reason); }
        }
    });
    engine.on('list:finalized', ev => calls.finalized.push(ev));
    return { engine, calls };
}

describe('shared-list finalized persistence: capability gate', function () {
    it('defers without inserting when capability persistence writes zero rows', async function () {
        const { engine, calls } = makeEngine();
        engine.persistCapabilitySnapshot = async () => 0;
        engine._inflight.add('zero-snapshot');

        await engine.writeFinalizedList({ row: row('zero-snapshot') });

        assert.deepStrictEqual(calls.inserted, []);
        assert.deepStrictEqual(calls.forgotten, ['zero-snapshot']);
        assert.strictEqual(engine._inflight.has('zero-snapshot'), false);
    });

    it('defers without inserting when capability persistence throws', async function () {
        const { engine, calls } = makeEngine();
        engine.persistCapabilitySnapshot = async () => { throw new Error('snapshot unavailable'); };
        engine._inflight.add('throw-snapshot');

        await engine.writeFinalizedList({ row: row('throw-snapshot') });

        assert.deepStrictEqual(calls.inserted, []);
        assert.deepStrictEqual(calls.forgotten, ['throw-snapshot']);
        assert.strictEqual(engine._inflight.has('throw-snapshot'), false);
    });

});

describe('shared-list finalized persistence: write and mirror', function () {
    it('inserts, re-reads, broadcasts and emits a good finalize', async function () {
        const { engine, calls } = makeEngine();
        const value = row('good-snapshot');
        engine._inflight.add(value.snapshot_id);

        await engine.writeFinalizedList({ row: value, signatures: ['signature'], view: 4 });

        assert.strictEqual(calls.inserted.length, 1);
        assert.strictEqual(calls.inserted[0], value);
        assert.strictEqual(value.validator_signatures, '["signature"]');
        assert.strictEqual(value.finalizing_view, 4);
        assert.strictEqual(value.btc_chain_id, 'chain-id');
        assert.deepStrictEqual(calls.broadcast, [{
            table: 'list_snapshots',
            row: { snapshot_id: 'good-snapshot', committed: true }
        }]);
        assert.deepStrictEqual(calls.finalized, [{ snapshotId: 'good-snapshot' }]);
        assert.strictEqual(engine._inflight.has(value.snapshot_id), false);
    });

    it('defers when inserting the finalized row throws', async function () {
        const { engine, calls } = makeEngine();
        engine.db.insertListSnapshot = async () => { throw new Error('database unavailable'); };
        engine._inflight.add('insert-throw');

        await engine.writeFinalizedList({ row: row('insert-throw'), signatures: null, view: null });

        assert.deepStrictEqual(calls.forgotten, ['insert-throw']);
        assert.deepStrictEqual(calls.broadcast, []);
        assert.deepStrictEqual(calls.finalized, []);
        assert.strictEqual(engine._inflight.has('insert-throw'), false);
    });

    it('forces resync after an empty re-read and still emits finalization', async function () {
        const { engine, calls } = makeEngine();
        engine.db.getListSnapshotBySnapshotId = async () => [];

        await engine.writeFinalizedList({ row: row('mirror-gap') });

        assert.deepStrictEqual(calls.broadcast, []);
        assert.deepStrictEqual(calls.resync, ['list_snapshots mirror gap']);
        assert.deepStrictEqual(calls.finalized, [{ snapshotId: 'mirror-gap' }]);
    });
});
