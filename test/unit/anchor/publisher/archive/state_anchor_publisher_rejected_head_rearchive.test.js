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

const { expect } = require('chai');
const finalized = require('../../../../../src/anchor/publisher/archive/finalized.js');
const finalizedApply = require('../../../../../src/anchor/publisher/archive/finalized_apply.js');
const observed = require('../../../../../src/anchor/publisher/archive/observed.js');

const TXID = 'cd'.repeat(32);

function quorumRows(){
    return { bridges: [], policies: [], checkpoints: [], prices: [], tombstones: [], lists: [] };
}

function publisher(verdict){
    const pub = Object.assign({}, finalized, observed);
    pub.record = { verifyArgs: [], applied: 0, backfilled: 0, deferred: 0 };
    pub.verifyFinalizedArchiveOnChain = async (...args) => {
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

        expect(pub.record.verifyArgs).to.deep.equal([[
            { batch_seq: 0, txid: TXID, matches: [{ id: 1 }] }, 'pk'
        ]]);
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

const CP = { chain: 'BTC', network: 'regtest', block_index: 100, checkpoint_seq: 4 };
const FOLD = {
    batchSeq: 7, sender: 'AA', cp: CP,
    batchCrc32: '1234abcd', matchCount: 2, totalChunks: 3
};

function folded(row, batchSeq = 7){
    const pub = Object.assign({}, observed, {
        _observedArchiveCheckpoints: new Map([[batchSeq, CP]]),
        _observedFoldArchiveKeys: new Map(), dogeConfirmations: 6,
        indexers: { DOGE: { url: 'stub' } }, requests: []
    });
    pub.recordObservedFoldArchiveKey(batchSeq, 'aa', FOLD);
    pub.verifyArchiveIdentityOnChain = async (...args) => {
        pub.wrapperArgs = pub.wrapperArgs || [];
        pub.wrapperArgs.push(args);
        return args[2].version === 1 ? 'absent:other-anchor' : 'verified';
    };
    pub.indexerCall = async (_coin, _method, params) => {
        pub.requests.push(params);
        return row;
    };
    return pub;
}

function head(extra){
    return Object.assign({
        exists: true, status: 'valid', version: 3, txid: TXID,
        match_batch_seq: 7, match_count: 2, batch_crc32: '1234abcd',
        total_chunks: 3, checkpoint_chain: 'BTC', checkpoint_network: 'regtest',
        block_index: 100, checkpoint_seq: 4, confirmations: 6
    }, extra || {});
}

function registerFoldedArchiveHeadTests(){
    it('accepts only a matching v3 wrapper and content-key archive row', async function () {
        const pub = folded(head());
        const d = { batch_seq: 7, txid: TXID };

        expect(await pub.verifyFinalizedArchiveOnChain(d, 'AA')).to.equal('verified');
        expect(pub.wrapperArgs).to.deep.equal([
            [CP, TXID, { version: 1 }], [CP, TXID, { version: 3 }]
        ]);
        expect(pub.requests[0]).to.not.have.property('author');
    });

    it('defers absent or shallow rows and rejects mismatched folded content', async function () {
        for(const [row, verdict] of [
            [{ exists: false }, 'absent'],
            [head({ confirmations: 5 }), 'shallow'],
            [head({ match_batch_seq: 8 }), 'rejected:batch-seq'],
            [head({ txid: 'ef'.repeat(32) }), 'rejected:txid'],
            [head({ total_chunks: 4 }), 'rejected:total-chunks'],
            [head({ match_count: 3 }), 'rejected:match-count'],
            [head({ status: 'invalid_archive' }), 'rejected:status']
        ]){
            const pub = folded(row);
            expect(await pub.verifyFinalizedArchiveOnChain(
                { batch_seq: 7, txid: TXID }, 'aa')).to.equal(verdict);
        }
    });

    it('rejects v3 when this hub did not co-sign folded content', async function () {
        const pub = Object.assign({}, observed, {
            _observedArchiveCheckpoints: new Map([[7, CP]]),
            _observedFoldArchiveKeys: new Map()
        });
        pub.verifyArchiveIdentityOnChain = async (...args) => {
            pub.wrapperArgs = pub.wrapperArgs || [];
            pub.wrapperArgs.push(args);
            return args[2].version === 1 ? 'absent:other-anchor' : 'verified';
        };

        expect(await pub.verifyFinalizedArchiveOnChain(
            { batch_seq: 7, txid: TXID }, 'aa')).to.equal('rejected:unbound-fold');
        expect(pub.wrapperArgs).to.deep.equal([
            [CP, TXID, { version: 1 }], [CP, TXID, { version: 3 }]
        ]);
    });

    it('accepts a later v1 head even when an omitted fold left a cached content key', async function () {
        const pub = folded(head());
        pub.verifyArchiveIdentityOnChain = async (...args) => {
            pub.wrapperArgs = [args];
            return args[2].version === 1 ? 'verified' : 'rejected:version';
        };

        expect(await pub.verifyFinalizedArchiveOnChain(
            { batch_seq: 7, txid: TXID }, 'aa')).to.equal('verified');
        expect(pub.wrapperArgs).to.deep.equal([[CP, TXID, { version: 1 }]]);
        expect(pub.requests).to.deep.equal([]);
    });
}

function registerFoldedBatchIdentityTests(){
    it('rejects missing folded batch identities when the announced batch is zero', async function () {
        for(const matchBatchSeq of [null, undefined, '']){
            const pub = folded(head({ match_batch_seq: matchBatchSeq }), 0);
            expect(await pub.verifyFinalizedArchiveOnChain(
                { batch_seq: 0, txid: TXID }, 'aa')).to.equal('rejected:batch-seq');
        }
    });
}

function registerDeferredFoldTest(){
    it('uses the same sender-bound check when draining a deferred announcement', async function () {
        const d = { batch_seq: 7, txid: TXID, matches: [] };
        const pub = Object.assign({}, finalizedApply, {
            _deferredFinalized: new Map(), announceRetryTtlMs: 10000, applied: 0
        });
        pub._deferredFinalized.set('fold', {
            d, sender: 'aa', calls: [], rewards: [], quorumRows: quorumRows(), at: Date.now()
        });
        pub.verifyFinalizedArchiveOnChain = async (...args) => {
            pub.verifyArgs = args;
            return 'verified';
        };
        pub.verifyFinalizedAgainstLocal = async () => true;
        pub.applyFinalized = async () => { pub.applied++; };

        await pub.runFinalizedDrain();

        expect(pub.verifyArgs).to.deep.equal([d, 'aa']);
        expect(pub.applied).to.equal(1);
        expect(pub._deferredFinalized.size).to.equal(0);
    });
}

describe('FINALIZED folded archive content binding', function () {
    registerFoldedArchiveHeadTests();
    registerFoldedBatchIdentityTests();
    registerDeferredFoldTest();
});
