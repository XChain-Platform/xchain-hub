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

// Pins the fold leader's guard against re-issuing an archive under a seq its own DOGE
// address already spent: a live archive intent holds the draw, a spent seq drops the
// archive section, and a sent fold archive records its seq as our own.

const { expect }           = require('chai');
const sinon                = require('sinon');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');
const ValidatorIdentity    = require('../../../../../src/validators/identity');
const { DB_METHODS }       = require('../../../../helpers/mockHub.js');

const SEQ = 12;
const CP  = { chain: 'BTC', network: 'regtest', block_index: 500, checkpoint_seq: 100, snapshot_block: 100 };

function mkFoldLeader({ nextSeq = SEQ, intent = null, indexerReply = { exists: false } } = {}){
    const identity = new ValidatorIdentity('11'.repeat(32));
    const db = { ...DB_METHODS, doQuery: async () => [] };
    const pub = new StateAnchorPublisher({
        db: db, network: 'regtest', p2pConfig: {},
        getIdentity: () => identity,
        getPeerManager: () => ({ on(){}, removeListener(){}, broadcast(){} }),
        rewardTracker: { anchorReward: '10.00000000', resolveSourceByPubkey: async () => 'src' },
        resolveBtcLatestBlock: async () => 100
    });
    const drawn = [];
    const indexerCalls = [];
    pub.db.getNextAnchorBatchSeq = sinon.stub().resolves([{ next_seq: nextSeq }]);
    pub.db.getAnchorPublishedArchive = sinon.stub().resolves(intent ? [intent] : []);
    pub.db.findCrossChainMatchesByBatchSeq = async () => [];
    pub.db.findCrossChainCallsByBatchSeq = async () => [];
    pub.dogeAddress = 'Downer';
    pub.indexers = { DOGE: { url: 'http://indexer.invalid' } };
    pub.indexerCall = async (coin, method, params) => {
        indexerCalls.push({ coin, method, params });
        if(indexerReply instanceof Error) throw indexerReply;
        return indexerReply;
    };
    Object.assign(pub, {
        archiveFoldSubdeadlineMs: 2000,
        gatherArchiveRows: async () => ({ rewards: [], matches: [], calls: [] }),
        orderedBundleSections: () => [CP],
        cpFromRow: () => CP,
        // Stand in for the rest of the build: reaching it means the section was not dropped
        resolveArchiveRewardSources: async () => { drawn.push('built'); throw new Error('stop'); }
    });
    return { pub, drawn, indexerCalls };
}

async function buildOutcome(pub){
    try { return await pub.buildFoldArchiveSection([CP], 'regtest'); }
    catch(e){ if(e.message === 'stop') return 'built'; throw e; }
}

describe('StateAnchorPublisher: fold archive own seq guard', function () {

    it('drops the archive section when our own address already spent the drawn seq', async function () {
        const { pub, drawn } = mkFoldLeader();
        pub.noteOwnArchiveSeq(SEQ);
        expect(await buildOutcome(pub)).to.equal(null);
        expect(drawn).to.deep.equal([]);
    });

    it('builds the archive section when the own spent seq is below the drawn seq', async function () {
        const { pub } = mkFoldLeader();
        pub.noteOwnArchiveSeq(SEQ - 1);
        expect(await buildOutcome(pub)).to.equal('built');
    });

    it('builds the archive section on a fresh hub that has spent no seq', async function () {
        const { pub } = mkFoldLeader();
        expect(pub.ownArchiveSeqFloor()).to.equal(-1);
        expect(await buildOutcome(pub)).to.equal('built');
    });

    it('holds the draw while an unsettled archive intent is inside its TTL', async function () {
        const intent = { network: 'regtest', batch_seq: SEQ, intent_at: new Date(), txid: null };
        const { pub } = mkFoldLeader({ intent });
        const draw = sinon.spy(pub, 'getNextBatchSeq');
        expect(await buildOutcome(pub)).to.equal(null);
        expect(draw.called, 'no seq drawn under a live intent').to.equal(false);
        expect(pub.db.getAnchorPublishedArchive.firstCall.args).to.deep.equal(['regtest']);
    });

    it('draws again once the archive intent has aged past its TTL', async function () {
        const intent = { network: 'regtest', batch_seq: SEQ, intent_at: new Date(Date.now() - 10 * 60 * 1000) };
        const { pub } = mkFoldLeader({ intent });
        pub.anchorIntentTtlMs = 60 * 1000;
        expect(await buildOutcome(pub)).to.equal('built');
    });

    it('fails closed for the archive when the intent read errors', async function () {
        const { pub } = mkFoldLeader();
        pub.db.getAnchorPublishedArchive = sinon.stub().rejects(new Error('db down'));
        let err = null;
        try { await pub.buildFoldArchiveSection([CP], 'regtest'); } catch(e){ err = e; }
        expect(err && err.message).to.equal('db down');
    });

    it('keeps the pinned regtest seq even when our own address spent it', async function () {
        const { pub } = mkFoldLeader();
        pub.noteOwnArchiveSeq(SEQ);
        pub.archiveNextSeqOverride = () => SEQ;
        expect(pub.foldSeqSpentByOwnAddress(SEQ)).to.equal(false);
        expect(await buildOutcome(pub)).to.equal('built');
    });
});

describe('StateAnchorPublisher: fold archive own seq floor refresh', function () {

    it('refreshes the own floor from the indexer before drawing, so a restart drops the spent seq', async function () {
        const { pub, indexerCalls } = mkFoldLeader({ indexerReply: { exists: true, match_batch_seq: SEQ } });
        expect(pub.ownArchiveSeqFloor()).to.equal(-1);
        expect(await pub.collectFoldArchive([CP], 'regtest')).to.equal(null);
        expect(indexerCalls[0]).to.deep.equal({ coin: 'DOGE', method: 'getarchiveanchor', params: { author: 'Downer' } });
        expect(pub.ownArchiveSeqFloor()).to.equal(SEQ);
    });

    it('keeps the cached floor and still drops the spent seq when the indexer is down', async function () {
        const { pub } = mkFoldLeader({ indexerReply: new Error('down') });
        pub.noteOwnArchiveSeq(SEQ);
        expect(await pub.collectFoldArchive([CP], 'regtest')).to.equal(null);
        expect(pub.ownArchiveSeqFloor()).to.equal(SEQ);
    });
});

describe('StateAnchorPublisher: fold archive send records the own seq', function () {

    function mkCompletePub(lost){
        const { pub } = mkFoldLeader();
        Object.assign(pub, {
            markArchiveSent: async () => {}, broadcastArchiveChunks: async () => lost,
            backfillBatch: async () => {}, settleArchiveIntent: async () => {},
            announceArchiveFinalized: () => {},
            archiveBackfillIds: () => ({ matchIds: [], callIds: [], rewardIds: [], bridgeIds: [],
                                         policyIds: [], checkpointIds: [], priceIds: [], tombstoneIds: [] })
        });
        return pub;
    }

    it('notes a whole fold archive seq as our own without moving the row-derived draw', async function () {
        const pub = mkCompletePub(0);
        await pub.completeFoldArchive({ cp: CP, batchSeq: SEQ }, {}, 'fold-tx');
        expect(pub.ownArchiveSeqFloor()).to.equal(SEQ);
        expect(await pub.getNextBatchSeq()).to.equal(SEQ);
    });

    it('notes a partial fold archive seq as our own as well', async function () {
        const pub = mkCompletePub(1);
        await pub.completeFoldArchive({ cp: CP, batchSeq: SEQ }, {}, 'fold-tx');
        expect(pub.ownArchiveSeqFloor()).to.equal(SEQ);
    });
});
