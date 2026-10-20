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

// Pins the own-address archive seq floor: seqs our DOGE address already spent are
// never re-drawn, whatever the peer jump cap says, and chunk slots only count under the
// seq a chunk is addressed to.

const { expect }           = require('chai');
const sinon                = require('sinon');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');
const ValidatorIdentity    = require('../../../../../src/validators/identity');
const { DB_METHODS } = require('../../../../helpers/mockHub.js');

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
    const calls = [];
    pub.dogeAddress = 'Downer';
    pub.indexers = { DOGE: { url: 'http://indexer.invalid' } };
    pub.indexerCall = async (coin, method, params) => {
        calls.push({ coin, method, params });
        if(reply instanceof Error) throw reply;
        return reply;
    };
    return calls;
}

describe('StateAnchorPublisher: own archive seq floor', function () {

    it('leads above our own spent seq even far beyond the peer jump cap', async function () {
        const pub = mkPub(5);
        expect(pub.ownArchiveSeqFloor()).to.equal(-1);
        pub.noteOwnArchiveSeq(2000);
        expect(await pub.leaderBatchSeqAboveOwn(await pub.getNextBatchSeq())).to.equal(2001);
        expect(await pub.leaderBatchSeqAboveOwn(2500)).to.equal(2500);
    });

    it('still caps a peer floor at the leader draw, measured from the own floor', async function () {
        const pub = mkPub(5);
        pub.noteOwnArchiveSeq(2000);
        pub.noteConsumedBatchSeq(5000, 'test');
        expect(await pub.leaderBatchSeqAboveOwn(await pub.getNextBatchSeq())).to.equal(2001);
        const near = mkPub(5);
        near.noteOwnArchiveSeq(2000);
        near.noteConsumedBatchSeq(2010, 'test');
        expect(await near.leaderBatchSeqAboveOwn(await near.getNextBatchSeq())).to.equal(2011);
    });

    it('leaves the follower draw on the rows, so a high own floor still co-signs a lower seq', async function () {
        const pub = mkPub(5);
        pub.noteOwnArchiveSeq(2000);
        expect(await pub.getNextBatchSeq()).to.equal(5);
        const leader = new ValidatorIdentity('22'.repeat(32)).getPubkeyHex().toLowerCase();
        const refused = [], bound = [];
        Object.assign(pub, {
            hub: { resolveBtcLatestBlock: async () => 100 },
            getActiveOraclePublishPubkeys: async (block) => (block === 100 ? [leader] : []),
            archiveSenderUnlocked: () => true,
            verifiedArchiveCanonical: () => 'canonical',
            broadcastSeqRefusal: (seq, consumed) => refused.push([seq, consumed]),
            bindObservedArchiveLeader: (d) => bound.push(Number(d.batch_seq))
        });
        const d = { checkpoint: { snapshot_block: 90 }, election_block: 100, sig_pubkey: leader, batch_seq: 5 };
        await pub.handleSignReq({ data: d });
        expect(refused, 'no stale-seq refusal').to.deep.equal([]);
        expect(bound, 'leader bound for co-signing').to.deep.equal([5]);
    });

    it('ignores fractional, negative, boolean and empty own seqs and never lowers the floor', function () {
        const pub = mkPub(0);
        for(const bad of [1.5, -1, '2.5', true, '', null, undefined, 'abc'])
            pub.noteOwnArchiveSeq(bad);
        expect(pub.ownArchiveSeqFloor()).to.equal(-1);
        pub.noteOwnArchiveSeq('9');
        pub.noteOwnArchiveSeq(4);
        expect(pub.ownArchiveSeqFloor()).to.equal(9);
    });
});

describe('StateAnchorPublisher: own archive seq floor refresh', function () {

    it('raises the floor from the author-only indexer read and reports the rise once', async function () {
        const pub = mkPub(5);
        const calls = wireIndexer(pub, { exists: true, match_batch_seq: 1500 });
        expect(await pub.refreshOwnArchiveSeqFloor()).to.equal(true);
        expect(calls[0]).to.deep.equal({ coin: 'DOGE', method: 'getarchiveanchor', params: { author: 'Downer' } });
        expect(pub.ownArchiveSeqFloor()).to.equal(1500);
        expect(await pub.refreshOwnArchiveSeqFloor()).to.equal(false);
    });

    it('keeps the floor and does not throw when the read fails or finds nothing', async function () {
        for(const reply of [new Error('down'), { error: 'indexer database not ready' }, { exists: false }]){
            const pub = mkPub(5);
            pub.noteOwnArchiveSeq(7);
            wireIndexer(pub, reply);
            expect(await pub.refreshOwnArchiveSeqFloor()).to.equal(false);
            expect(pub.ownArchiveSeqFloor()).to.equal(7);
        }
    });

    it('keeps the boot-seeded own floor when the indexer is down at the leader draw', async function () {
        const pub = mkPub(3);
        wireIndexer(pub, { exists: true, match_batch_seq: 5000 });
        await pub.seedArchiveSeqFloor();
        expect(pub.ownArchiveSeqFloor()).to.equal(5000);
        wireIndexer(pub, new Error('down'));
        expect(await pub.getNextBatchSeq(), 'peer cap drops the seed as a peer floor').to.equal(3);
        expect(await pub.leaderBatchSeqAboveOwn(3)).to.equal(5001);
    });
});

// A leader whose rows were reset must redraw above its own on-chain seq before building.
describe('StateAnchorPublisher: own archive seq floor at the leader draw', function () {

    it('redraws the round seq after the refresh raises the own floor', async function () {
        const pub = mkPub(3);
        wireIndexer(pub, { exists: true, match_batch_seq: 1800 });
        const built = [];
        Object.assign(pub, {
            archiveTipUnresolved: () => false,
            getActiveOraclePublishPubkeys: async () => ['aa'],
            archiveElectionAdmits: () => true,
            gatherArchiveRows: async () => ({ rewards: [] }),
            latestArchiveWrapperRows: async () => [{ network: 'regtest' }],
            cpFromRow: () => ({ snapshot_block: 100 }),
            getLiveArchiveIntent: async () => null,
            archiveRoundIntentHeld: () => false,
            archiveRankLocked: () => false,
            resolveArchiveRewardSources: async () => [],
            archiveEmptyAfterResolution: () => false,
            buildSizedArchive: async (network, batchSeq) => { built.push(batchSeq); throw new Error('stop'); }
        });
        let stopped = false;
        try { await pub.startArchiveRound({}, 100); } catch(e){ stopped = e.message === 'stop'; }
        expect(stopped).to.equal(true);
        expect(built).to.deep.equal([1801]);
    });
});

const CP = {
    chain: 'BTC', network: 'regtest', block_index: 500, block_hash: 'c0'.repeat(32),
    ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
    checkpoint_seq: 100, snapshot_block: 100
};
const ROUND_SEQ  = 12;
const OLDER_SEQ  = 9;
const CHUNKS     = ['chunk0', 'chunk1', 'chunk2'];
const SOLE       = new ValidatorIdentity('33'.repeat(32));
const SOLE_PK    = SOLE.getPubkeyHex().toLowerCase();

function mkPublishPub(indexerReply){
    const pub = mkPub(0);
    Object.assign(pub, {
        chunkRetryDelayMs: 1, ambiguousPollDelayMs: 1, ambiguousPollAttempts: 1,
        identity: null, peerManager: null, dogeAddress: 'Dpub1',
        indexers: { DOGE: { url: 'http://indexer.invalid' } },
        spendGuard: { isPaused: () => false, reserve: () => ({ id: 1 }), commit(){}, release(){}, noteBlocked: () => '' },
        getLiveArchiveIntent: async () => null, recordArchiveIntent: async () => {},
        markArchiveSent: async () => {}, withdrawArchiveIntent: async () => {}, settleArchiveIntent: async () => {},
        backfillBatch: async () => {}, recordReward: () => {}, notePendingConfirmation: () => {}
    });
    pub.indexerCall = async (coin, method, params) => indexerReply(params);
    return pub;
}

function mkRound(sent){
    return {
        cp: CP, batchSeq: ROUND_SEQ, count: 4, crc: 'deadbeef', chunks: CHUNKS.slice(),
        canonical: 'canonical', quorum: 1, weighted: false,
        validators: [{ pubkey: SOLE_PK, amount: '1', source: '' }],
        signatures: new Map([[SOLE_PK, SOLE.sign('canonical')]]),
        matchIds: [{ id: 1, status: 'settled' }], callIds: [], rewardIds: [],
        signer: { broadcastFn: async (p) => { sent.push(p); return { txid: 'fresh-tx-' + sent.length }; } }
    };
}

function olderHead(present){
    return { exists: true, status: 'valid', txid: 'aa'.repeat(32), match_batch_seq: OLDER_SEQ,
             total_chunks: CHUNKS.length, chunks_present: present };
}

describe('StateAnchorPublisher: archive publish against an older same-content head', function () {

    it('counts the sent head seq as our own so the next draw moves past it', async function () {
        const sent = [];
        const pub = mkPublishPub(() => ({ exists: false }));
        await pub.publishArchive(mkRound(sent));
        expect(pub.ownArchiveSeqFloor()).to.equal(ROUND_SEQ);
        expect(await pub.leaderBatchSeqAboveOwn(await pub.getNextBatchSeq())).to.equal(ROUND_SEQ + 1);
    });

    it('re-sends chunks a same-content head holds under a different seq', async function () {
        const sent = [];
        let lookups = 0;
        const pub = mkPublishPub(() => {
            lookups++;
            if(lookups === 1) throw new Error('transient');
            return olderHead([0, 1, 2]);
        });
        await pub.publishArchive(mkRound(sent));
        expect(sent.length, 'head plus every chunk').to.equal(CHUNKS.length);
        for(const payload of sent.slice(1)) expect(payload.split('|')[2]).to.equal(String(ROUND_SEQ));
    });

    it('still skips a chunk already present under the seq it is addressed to', async function () {
        const sent = [];
        const pub = mkPublishPub(() => olderHead([0, 1]));
        await pub.publishArchive(mkRound(sent));
        expect(sent.map(p => p.split('|').slice(1, 4).join('|'))).to.deep.equal(['2|' + OLDER_SEQ + '|2']);
    });
});

// A partial fold archive must leave the leader on the same next seq its followers take
// from the FINALIZED, or the next fold co-sign equality check fails.
describe('StateAnchorPublisher: partial fold archive seq', function () {

    function mkFoldPub(lost){
        const pub = mkPub(ROUND_SEQ);
        Object.assign(pub, {
            markArchiveSent: async () => {}, broadcastArchiveChunks: async () => lost,
            backfillBatch: async () => {}, settleArchiveIntent: async () => {},
            announceArchiveFinalized: () => {}
        });
        return pub;
    }

    it('counts a partial fold archive seq as consumed so the next draw moves past it', async function () {
        const pub = mkFoldPub(1);
        await pub.completeFoldArchive(mkRound([]), {}, 'fold-tx');
        expect(await pub.getNextBatchSeq()).to.equal(ROUND_SEQ + 1);
    });

    it('leaves the draw on the rows after a whole fold archive', async function () {
        const pub = mkFoldPub(0);
        await pub.completeFoldArchive(mkRound([]), {}, 'fold-tx');
        expect(await pub.getNextBatchSeq()).to.equal(ROUND_SEQ);
    });
});
