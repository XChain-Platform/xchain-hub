'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// WATERMARK-OVERTAKE GUARD for the checkpoint producer, the twin of
// OracleConsensus.broadcast-gap.test.js.
//
// _acceptFinalized commits a quorum-signed checkpoint and then re-reads it to stream
// it to hub-DB mirror subscribers. An unguarded re-read there drops the row on a throw:
// the mirror row AND aborted the rest of the accept (the cadence-latch advance, the log
// line, the checkpoint:finalized emit), while an empty result dropped the row silently.
// HubDbBroadcaster.broadcastWatermark keeps advancing on its own wall clock and certifies
// "you have every row produced through ts", and state_checkpoints is a HUB_STATE_TABLES
// member with no FULL_REPAGE re-page, so the mirror then certifies completeness past a
// committed, quorum-signed checkpoint until the socket happens to reconnect.
// dropAllForResync is the sanctioned repair; OracleConsensus._finalize is the precedent.

const { expect }            = require('chai');
const sinon                 = require('sinon');
const StateCheckpointEngine = require('../../src/StateCheckpointEngine');

const CP = {
    chain: 'BTC', network: 'regtest', block_index: 500, block_hash: 'c0'.repeat(32),
    ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
    checkpoint_seq: 7, snapshot_block: 480,
    state_root: 'd4'.repeat(32), state_root_version: 1,
    block_merkle_root: 'e5'.repeat(32), block_merkle_version: 1
};

// A db double whose SELECT behaviour is the variable under test; every other
// statement is a no-op that resolves, so only DELIVERY can fail.
function mkDb(selectBehaviour) {
    return {
        selects: 0,
        async doQuery(sql) {
            if (/^SELECT \* FROM state_checkpoints/.test(sql) ||
                /^SELECT \* FROM capability_snapshots/.test(sql)) {
                this.selects++;
                return selectBehaviour(this.selects);
            }
            return [];
        }
    };
}

function mkEngine(db, broadcaster) {
    const engine = new StateCheckpointEngine({
        db: db, network: 'regtest', p2pConfig: { CHECKPOINT_ENABLED: 'false' },
        hubDbBroadcaster: broadcaster,
        getPeerManager: () => null,
        getIdentity:    () => null
    });
    return engine;
}

describe('StateCheckpointEngine: post-commit mirror broadcast gap', function () {

    let broadcaster;

    beforeEach(function () {
        broadcaster = {
            broadcastRow:     sinon.stub(),
            dropAllForResync: sinon.stub().returns(1)
        };
        sinon.stub(console, 'error');
        sinon.stub(console, 'log');
        sinon.stub(console, 'warn');
    });

    afterEach(function () { sinon.restore(); });

    describe('_broadcastRowOrResync', function () {

        it('broadcasts the re-read rows and does not resync', async function () {
            const db     = mkDb(() => [{ id: 1, chain: 'BTC' }]);
            const engine = mkEngine(db, broadcaster);
            await engine._broadcastRowOrResync('state_checkpoints', 'SELECT * FROM state_checkpoints WHERE id = ?', [1], 'why');
            expect(broadcaster.broadcastRow.calledOnce).to.equal(true);
            expect(broadcaster.broadcastRow.firstCall.args[0].table).to.equal('state_checkpoints');
            expect(broadcaster.dropAllForResync.called).to.equal(false);
        });

        it('repairs the stream when the re-read throws', async function () {
            const db     = { async doQuery() { throw new Error('connection lost'); } };
            const engine = mkEngine(db, broadcaster);
            await engine._broadcastRowOrResync('state_checkpoints', 'SELECT * FROM state_checkpoints WHERE id = ?', [1], 'gap-a');
            expect(broadcaster.broadcastRow.called).to.equal(false);
            expect(broadcaster.dropAllForResync.calledOnce).to.equal(true);
            expect(broadcaster.dropAllForResync.firstCall.args[0]).to.equal('gap-a');
        });

        it('treats an EMPTY re-read of a committed row as the same undeliverable event', async function () {
            // The half a bare try/catch misses: `if(r.length)` silently produced no frame
            // for a row that is committed locally, which the watermark then certifies past.
            const db     = mkDb(() => []);
            const engine = mkEngine(db, broadcaster);
            await engine._broadcastRowOrResync('state_checkpoints', 'SELECT * FROM state_checkpoints WHERE id = ?', [1], 'gap-b');
            expect(broadcaster.broadcastRow.called).to.equal(false);
            expect(broadcaster.dropAllForResync.calledOnce).to.equal(true);
        });

        it('never throws out of the repair itself', async function () {
            const db     = { async doQuery() { throw new Error('connection lost'); } };
            const engine = mkEngine(db, { broadcastRow() {}, dropAllForResync() { throw new Error('repair blew up'); } });
            await engine._broadcastRowOrResync('state_checkpoints', 'SELECT 1', [], 'gap-c');   // resolves
        });

        it('fires the repair once, not once per row, when the subscriber set is already empty', async function () {
            // _persistCapabilitySnapshot broadcasts inside a per-validator loop, so a
            // persistent DB fault would otherwise fire dropAllForResync once per validator.
            const b = {
                subscribers: new Set(),
                broadcastRow: sinon.stub(),
                dropAllForResync: sinon.stub().returns(0)
            };
            const db     = { calls: 0, async doQuery() { this.calls++; throw new Error('connection lost'); } };
            const engine = mkEngine(db, b);
            await engine._broadcastRowOrResync('capability_snapshots', 'SELECT 1', [], 'gap-d');
            expect(b.dropAllForResync.called).to.equal(false);
            expect(db.calls, 'no re-read is worth running with nothing to deliver to').to.equal(0);
        });
    });

    describe('_acceptFinalized', function () {

        it('still advances the latch and emits when the mirror re-read fails', async function () {
            const db     = { async doQuery(sql) {
                if (/^SELECT \* FROM state_checkpoints/.test(sql)) throw new Error('connection lost');
                return [];
            } };
            const engine = mkEngine(db, broadcaster);
            engine._persistCapabilitySnapshot = async () => {};   // isolate the checkpoint leg

            let emitted = null;
            engine.on('checkpoint:finalized', (e) => { emitted = e; });

            await engine._acceptFinalized(CP, [{ pubkey: 'aa', sig: 'bb' }], 1, false);

            expect(broadcaster.dropAllForResync.calledOnce,
                'a committed checkpoint that could not be streamed must force a resync').to.equal(true);
            expect(engine._lastCheckpointBtcBlock,
                'the cadence latch must advance: the checkpoint IS committed').to.equal(480);
            expect(emitted, 'checkpoint:finalized must still fire').to.not.equal(null);
            expect(emitted.checkpoint.checkpoint_seq).to.equal(7);
        });

        it('leaves the happy path untouched', async function () {
            const db     = mkDb(() => [{ id: 9, chain: 'BTC', checkpoint_seq: 7 }]);
            const engine = mkEngine(db, broadcaster);
            engine._persistCapabilitySnapshot = async () => {};

            let emitted = null;
            engine.on('checkpoint:finalized', (e) => { emitted = e; });

            await engine._acceptFinalized(CP, [{ pubkey: 'aa', sig: 'bb' }], 1, false);

            expect(broadcaster.broadcastRow.calledOnce).to.equal(true);
            expect(broadcaster.dropAllForResync.called).to.equal(false);
            expect(engine._lastCheckpointBtcBlock).to.equal(480);
            expect(emitted).to.not.equal(null);
        });
    });
});
