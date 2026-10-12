'use strict';

const { expect } = require('chai');
const finalized = require('../../../../../src/anchor/publisher/archive/finalized.js');

const TXID = 'cd'.repeat(32);

function quorumRows(){
    return { bridges: [], policies: [], checkpoints: [], prices: [], tombstones: [], lists: [] };
}

function publisher(verdict){
    const pub = Object.assign({}, finalized);
    pub.record = { verifyArgs: [], applied: 0, backfilled: 0, deferred: 0 };
    pub.verifyArchiveCheckpointOnChain = async (...args) => {
        pub.record.verifyArgs.push(args);
        return verdict;
    };
    pub.applyFinalized = async () => { pub.record.applied++; };
    pub.backfillBatch = async () => { pub.record.backfilled++; };
    pub.deferFinalized = () => { pub.record.deferred++; };
    return pub;
}

async function stage(pub){
    await pub.stageFinalizedBackfill(
        { batch_seq: 0, txid: TXID, matches: [{ id: 1 }] }, 'pk', [], [], quorumRows());
}

describe('FINALIZED archive head rejected on-chain', function () {
    ['rejected:txid', 'rejected:status', 'rejected:mismatch', 'rejected:version'].forEach(verdict => {
        it('stamps nothing and leaves rows pending on ' + verdict, async function () {
            const pub = publisher(verdict);

            await stage(pub);

            expect(pub.record.applied).to.equal(0);
            expect(pub.record.backfilled).to.equal(0);
            expect(pub.record.deferred).to.equal(0);
        });
    });

    it('verifies the head against the batch seq and txid with the v0 and v2 reject set', async function () {
        const pub = publisher('rejected:txid');

        await stage(pub);

        expect(pub.record.verifyArgs).to.deep.equal([[0, TXID, { rejectVersions: [0, 2] }]]);
    });

    it('still stamps on a verified head', async function () {
        const pub = publisher('verified');

        await stage(pub);

        expect(pub.record.applied).to.equal(1);
        expect(pub.record.backfilled).to.equal(0);
    });

    it('stages partial rows and defers on a shallow head', async function () {
        const pub = publisher('shallow');

        await stage(pub);

        expect(pub.record.applied).to.equal(0);
        expect(pub.record.backfilled).to.equal(1);
        expect(pub.record.deferred).to.equal(1);
    });
});
