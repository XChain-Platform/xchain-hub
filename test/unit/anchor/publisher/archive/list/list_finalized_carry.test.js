'use strict';

const { expect } = require('chai');
const observed = require('../../../../../../src/anchor/publisher/archive/observed.js');
const finalized = require('../../../../../../src/anchor/publisher/archive/finalized.js');
const finalizedApply = require('../../../../../../src/anchor/publisher/archive/finalized_apply.js');

const PRESENT = 'a'.repeat(64);
const MISSING = 'b'.repeat(64);

function publisher(){
    return Object.assign({
        _observedArchiveContents: new Map(),
        _observedArchiveLeadersCap: 256,
        db: {}
    }, observed, finalized, finalizedApply);
}

function quorumRows(lists){
    return { bridges: [], policies: [], checkpoints: [], prices: [], tombstones: [], lists };
}

function registerObservedCarryTests(){
    it('binds announced list ids to the observed archive body', function () {
        const pub = publisher();
        pub.recordObservedArchiveContent(7, 'PK', {
            list_snapshots: [{ snapshot_id: PRESENT }]
        });

        expect(pub.finalizedOutsideObservedArchive(
            7, 'pk', [], [], [], [], [], [], [], [], [{ snapshot_id: PRESENT }]))
            .to.equal(null);
        expect(pub.finalizedOutsideObservedArchive(
            7, 'pk', [], [], [], [], [], [], [], [], [{ snapshot_id: MISSING }]))
            .to.equal('list ' + MISSING.substring(0, 16) + '...');
    });

    it('names a list announced after an archive without list rows', function () {
        const pub = publisher();
        pub.recordObservedArchiveContent(7, 'pk', {});

        expect(pub.finalizedOutsideObservedArchive(
            7, 'pk', [], [], [], [], [], [], [], [], [{ snapshot_id: MISSING }]))
            .to.equal('list ' + MISSING.substring(0, 16) + '...');
    });
}

function registerFinalizedRowTests(){
    it('carries list rows and defaults an absent field to empty', function () {
        const pub = publisher();
        const lists = [{ snapshot_id: PRESENT }];

        expect(pub.finalizedQuorumRows({ lists }).lists).to.equal(lists);
        expect(pub.finalizedQuorumRows({}).lists).to.deep.equal([]);
    });

    it('rejects a no-txid FINALIZED that announces a list', function () {
        const pub = publisher();

        expect(pub.finalizedNullTxidForged({
            batch_seq: 7, txid: null, matches: [], lists: [{ snapshot_id: PRESENT }]
        }, [], [])).to.equal(true);
    });

    it('validates list ids while preserving absent-field compatibility', async function () {
        const pub = publisher();

        expect(await pub.verifyFinalizedAgainstLocal(
            [], [], [], quorumRows([{ snapshot_id: null }]))).to.equal(false);
        expect(await pub.verifyFinalizedAgainstLocal(
            [], [], [], quorumRows([{ snapshot_id: PRESENT }]))).to.equal(true);

        const legacy = { bridges: [], policies: [], checkpoints: [], prices: [], tombstones: [] };
        expect(await pub.verifyFinalizedAgainstLocal([], [], [], legacy)).to.equal(true);
        expect(pub.finalizedNullTxidForged(
            { batch_seq: 7, txid: null, matches: [] }, [], [], legacy)).to.equal(false);
    });
}

function registerBackfillTests(){
    it('hands list ids to no-txid back-fill as argument eleven', async function () {
        const pub = publisher();
        const calls = [];
        pub.backfillBatch = async (...args) => calls.push(args);

        await pub.stageFinalizedBackfill({
            batch_seq: 7, txid: null, matches: [], lists: [{ snapshot_id: PRESENT }]
        }, 'pk', [], []);

        expect(calls).to.have.length(1);
        expect(calls[0]).to.have.length(11);
        expect(calls[0][10]).to.deep.equal([{ snapshot_id: PRESENT }]);
    });

    it('hands list ids to apply back-fill as argument eleven', async function () {
        const pub = publisher();
        const calls = [];
        pub.backfillBatch = async (...args) => calls.push(args);

        await pub.applyFinalized({ batch_seq: 7, txid: null, matches: [] }, 'pk', [], [],
                                 quorumRows([{ snapshot_id: PRESENT }]));

        expect(calls).to.have.length(1);
        expect(calls[0]).to.have.length(11);
        expect(calls[0][10]).to.deep.equal([{ snapshot_id: PRESENT }]);
    });
}

describe('FINALIZED list snapshot carry', function () {
    registerObservedCarryTests();
    registerFinalizedRowTests();
    registerBackfillTests();
});
