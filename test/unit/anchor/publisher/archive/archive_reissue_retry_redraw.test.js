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

// Pins the retry after a refused v1 head: the head's rows stay pending, so a restart that
// loses process memory draws the same row-derived seq again. The hub must read its own
// spent seq back from the DOGE indexer and lead above it instead.

const { expect }           = require('chai');
const sinon                = require('sinon');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');
const ValidatorIdentity    = require('../../../../../src/validators/identity');
const { DB_METHODS } = require('../../../../helpers/mockHub.js');

const SPENT_SEQ = 12;

function mkPub(nextSeq){
    const identity = new ValidatorIdentity('11'.repeat(32));
    const db = { ...DB_METHODS, doQuery: async () => [] };
    const pub = new StateAnchorPublisher({
        db: db, network: 'regtest', p2pConfig: {},
        getIdentity: () => identity,
        getPeerManager: () => ({ on(){}, removeListener(){}, broadcast(){} }),
        rewardTracker: { anchorReward: '10.00000000', resolveSourceByPubkey: async () => 'src' },
        resolveBtcLatestBlock: async () => 100
    });
    pub.db.getNextAnchorBatchSeq = sinon.stub().resolves([{ next_seq: nextSeq }]);
    return pub;
}

function wireIndexer(pub, reply){
    pub.dogeAddress = 'Downer';
    pub.indexers = { DOGE: { url: 'http://indexer.invalid' } };
    pub.indexerCall = async () => {
        if(reply instanceof Error) throw reply;
        return reply;
    };
}

// What the author-only getarchiveanchor answers for a head the indexer refused.
const REFUSED_HEAD = { exists: true, status: 'invalid: retry', match_batch_seq: SPENT_SEQ };

describe('StateAnchorPublisher: archive reissue after a refused head', function () {

    it('MATCH_BATCH_SEQ (retry; restart loses memory) leads above the seq the refused head spent', async function () {
        const before = mkPub(SPENT_SEQ);
        before.noteOwnArchiveSeq(SPENT_SEQ);
        expect(before.ownArchiveSeqFloor()).to.equal(SPENT_SEQ);

        // Restart: a fresh process holds no floor and the pending rows draw the same seq.
        const after = mkPub(SPENT_SEQ);
        expect(after.ownArchiveSeqFloor()).to.equal(-1);
        expect(await after.getNextBatchSeq()).to.equal(SPENT_SEQ);

        wireIndexer(after, REFUSED_HEAD);
        await after.seedArchiveSeqFloor();
        expect(after.ownArchiveSeqFloor()).to.equal(SPENT_SEQ);
        expect(await after.leaderBatchSeqAboveOwn(await after.getNextBatchSeq())).to.equal(SPENT_SEQ + 1);
    });

    it('MATCH_BATCH_SEQ (retry; boot seed missed) is recovered by the refresh at the leader draw', async function () {
        const pub = mkPub(SPENT_SEQ);
        wireIndexer(pub, new Error('down'));
        await pub.seedArchiveSeqFloor();
        expect(pub.ownArchiveSeqFloor()).to.equal(-1);
        wireIndexer(pub, REFUSED_HEAD);
        expect(await pub.leaderBatchSeqAboveOwn(await pub.getNextBatchSeq())).to.equal(SPENT_SEQ + 1);
    });

    it('MATCH_BATCH_SEQ (retry; no head on chain) keeps the row-derived draw', async function () {
        const pub = mkPub(SPENT_SEQ);
        wireIndexer(pub, { exists: false });
        await pub.seedArchiveSeqFloor();
        expect(await pub.leaderBatchSeqAboveOwn(await pub.getNextBatchSeq())).to.equal(SPENT_SEQ);
    });
});
