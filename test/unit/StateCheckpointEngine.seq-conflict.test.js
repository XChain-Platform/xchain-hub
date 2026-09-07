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
// SAME-SEQ CONFLICT FENCE at the checkpoint persist seam.
//
// uq_chain_seq admits exactly one row per (chain, network, checkpoint_seq). Before the
// fence, a second quorum-signed payload arriving at a seated sequence was dropped by the
// INSERT IGNORE with no trace of WHY: the mirror re-read (keyed on block_index as well as
// seq) then found nothing, dumped every subscriber for a resync that cannot repair it,
// advanced the cadence latch and emitted a checkpoint the hub does not hold. Two hubs
// that received the two FINALIZED broadcasts in opposite orders keep DIFFERENT rows at
// that sequence, permanently and silently.
//
// The fence is DETECTION only. Preventing the double-sign needs a durable per-sequence
// commitment written before any signature leaves the hub; nothing here stops a Byzantine
// cadence leader collecting quorum on two payloads at one seq.

const { expect }            = require('chai');
const sinon                 = require('sinon');
const StateCheckpointEngine = require('../../src/StateCheckpointEngine');

const SEATED = {
    id: 1, chain: 'BTC', network: 'regtest', block_index: 494, block_hash: 'c0'.repeat(32),
    ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
    checkpoint_seq: 7, snapshot_block: 480,
    state_root: 'd4'.repeat(32), state_root_version: 1,
    block_merkle_root: 'e5'.repeat(32), block_merkle_version: 1,
    validator_signatures: '[]'
};

// The rival: same chain/network/seq/snapshot_block (so every co-sign guard that keys on
// snapshot_block passed for it too), a DIFFERENT block on the target chain.
const RIVAL = Object.assign({}, SEATED, {
    block_index: 495, block_hash: 'd0'.repeat(32), ledger_hash: 'a2'.repeat(32),
    actions_hash: 'b3'.repeat(32), contract_hash: 'c4'.repeat(32)
});
delete RIVAL.id;
delete RIVAL.validator_signatures;

// A db double that seats exactly one state_checkpoints row and records every write.
function mkDb(seatedRow) {
    return {
        inserts: [],
        rows: seatedRow ? [seatedRow] : [],
        async doQuery(sql, params) {
            if (/^SELECT \* FROM state_checkpoints WHERE chain = \? AND network = \? AND checkpoint_seq = \?/.test(sql))
                return this.rows.filter(r => r.chain === params[0] && r.network === params[1] &&
                                             Number(r.checkpoint_seq) === Number(params[2])).slice(0, 1);
            if (/^SELECT \* FROM state_checkpoints/.test(sql))   // the mirror re-read: chain+network+block_index+seq
                return this.rows.filter(r => r.chain === params[0] && r.network === params[1] &&
                                             Number(r.block_index) === Number(params[2]) &&
                                             Number(r.checkpoint_seq) === Number(params[3])).slice(0, 1);
            if (/^INSERT IGNORE INTO state_checkpoints/.test(sql)) { this.inserts.push(params); return []; }
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
    engine._persistCapabilitySnapshot = async () => {};   // isolate the checkpoint leg
    return engine;
}

describe('StateCheckpointEngine: same-seq conflict fence', function () {

    let broadcaster;

    beforeEach(function () {
        broadcaster = { broadcastRow: sinon.stub(), dropAllForResync: sinon.stub().returns(1) };
        sinon.stub(console, 'error');
        sinon.stub(console, 'log');
        sinon.stub(console, 'warn');
    });

    afterEach(function () { sinon.restore(); });

    it('refuses a quorum-signed FINALIZED that names a different block at a seated sequence', async function () {
        const db     = mkDb(SEATED);
        const engine = mkEngine(db, broadcaster);
        let emitted = null;
        engine.on('checkpoint:finalized', (e) => { emitted = e; });

        await engine._acceptFinalized(RIVAL, [{ pubkey: 'aa', sig: 'bb' }], 1, false);

        expect(db.inserts, 'nothing is written').to.deep.equal([]);
        expect(broadcaster.broadcastRow.called, 'nothing is streamed to mirrors').to.equal(false);
        expect(broadcaster.dropAllForResync.called,
            'no subscriber dump: the read-back never runs, so there is no phantom gap to repair').to.equal(false);
        expect(emitted, 'nothing is emitted for a checkpoint this hub does not hold').to.equal(null);
        expect(engine._lastCheckpointBtcBlock, 'the cadence latch does not advance').to.equal(null);
        expect(engine._seqConflicts, 'the conflict is counted').to.equal(1);
        expect(console.error.calledOnce, 'and reported').to.equal(true);
        expect(console.error.firstCall.args[0]).to.contain('CONFLICTING checkpoint');
        expect(console.error.firstCall.args[0], 'the log names both blocks as evidence').to.contain('494');
        expect(console.error.firstCall.args[0]).to.contain('495');
    });

    it('surfaces the count in getStats so an operator can see the equivocation', async function () {
        const db     = mkDb(SEATED);
        const engine = mkEngine(db, broadcaster);
        expect((await engine.getStats()).seq_conflicts).to.equal(0);
        await engine._acceptFinalized(RIVAL, [{ pubkey: 'aa', sig: 'bb' }], 1, false);
        expect((await engine.getStats()).seq_conflicts).to.equal(1);
    });

    // The control the fence must not break: a re-delivered FINALIZED for the SAME payload
    // is ordinary traffic (the broadcast is deliberately re-deliverable), and it must
    // still commit, stream and emit exactly as before.
    it('leaves a re-delivery of the SAME payload untouched', async function () {
        const db     = mkDb(SEATED);
        const engine = mkEngine(db, broadcaster);
        let emitted = null;
        engine.on('checkpoint:finalized', (e) => { emitted = e; });

        const same = Object.assign({}, SEATED);
        delete same.id;
        delete same.validator_signatures;
        await engine._acceptFinalized(same, [{ pubkey: 'aa', sig: 'bb' }], 1, false);

        expect(db.inserts.length, 'the INSERT IGNORE still runs').to.equal(1);
        expect(broadcaster.broadcastRow.calledOnce, 'the row still streams').to.equal(true);
        expect(emitted, 'and still emits').to.not.equal(null);
        expect(engine._seqConflicts, 'no conflict counted').to.equal(0);
    });

    it('does not fire on a fresh sequence', async function () {
        const db     = mkDb(SEATED);
        const engine = mkEngine(db, broadcaster);
        const next = Object.assign({}, RIVAL, { checkpoint_seq: 8, snapshot_block: 486 });
        await engine._acceptFinalized(next, [{ pubkey: 'aa', sig: 'bb' }], 1, false);
        expect(db.inserts.length, 'a new seq commits normally').to.equal(1);
        expect(engine._seqConflicts).to.equal(0);
    });

    // The fence is a detector, not a safety property: uq_chain_seq admits one row with or
    // without it. Failing closed on a read error would turn a transient DB blip into a
    // refusal to persist quorum-signed checkpoints, which is strictly worse.
    it('fails OPEN when the conflict read itself errors', async function () {
        const db = {
            inserts: [],
            async doQuery(sql, params) {
                if (/^SELECT \* FROM state_checkpoints WHERE chain = \? AND network = \? AND checkpoint_seq = \?/.test(sql))
                    throw new Error('connection lost');
                if (/^INSERT IGNORE INTO state_checkpoints/.test(sql)) { this.inserts.push(params); return []; }
                return [];
            }
        };
        const engine = mkEngine(db, broadcaster);
        let emitted = null;
        engine.on('checkpoint:finalized', (e) => { emitted = e; });
        await engine._acceptFinalized(RIVAL, [{ pubkey: 'aa', sig: 'bb' }], 1, false);
        expect(db.inserts.length, 'the commit still happens').to.equal(1);
        expect(emitted, 'and still emits').to.not.equal(null);
        expect(engine._seqConflicts, 'nothing is counted: we could not tell').to.equal(0);
    });
});
