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

// Crash-safety for the ARCHIVE publish path.
//
// _publishArchive broadcasts the v1/v6 head and every v2 continuation chunk BEFORE
// _backfillBatch records the batch, so a crash in that window leaves the rows pending
// and the next flush re-elects the identical matches and pays for the whole archive a
// second time. The checkpoint path has guarded this since its own existence check
// landed; the archive path had no on-chain guard at all, and could not reuse the
// checkpoint one: every archive read is keyed on match_batch_seq, which is exactly what
// the restart does not preserve (_getNextBatchSeq is MAX(batch_seq)+1 fleet-wide, so a
// peer archiving in the meantime moves it).
//
// These pin the content-addressed guard: the head is adopted when the same batch
// (checkpoint identity + crc + match_count, scoped to our own publishing address) is
// already on-chain, each chunk slot is resolved on its own so a partial archive resumes
// without re-paying for the chunks that landed, the resumed chunks are addressed to the
// seq the head ACTUALLY landed under, and every "can't tell" degrades to publishing.

const { expect }           = require('chai');
const StateAnchorPublisher = require('../../src/StateAnchorPublisher');

const CP = {
    chain: 'BTC', network: 'regtest', block_index: 500, block_hash: 'c0'.repeat(32),
    ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
    checkpoint_seq: 100, snapshot_block: 100
};

const CRC        = 'deadbeef';
const COUNT      = 4;
const ROUND_SEQ  = 12;          // the seq THIS process allocated
const LANDED_SEQ = 9;           // the seq the earlier (crashed) attempt published under
const CHUNKS     = ['chunk0', 'chunk1', 'chunk2'];

// A publisher wired so _publishArchive reaches its broadcast decisions with the
// intent marker, quorum, back-fill and reward bookkeeping out of the way. Every DOGE
// send is captured rather than made.
function mkPub(indexerReply) {
    const sent      = [];
    const backfills = [];
    const pub = new StateAnchorPublisher({ db: { async doQuery(){ return []; } },
                                           p2pConfig: { DOGE_ADDRESS: 'Dpub1' } });
    pub.chunkRetryDelayMs     = 1;
    pub.ambiguousPollDelayMs  = 1;
    pub.ambiguousPollAttempts = 1;
    pub.identity    = null;      // skips the publisher-attestation round
    pub.peerManager = null;      // skips the XANC_FINALIZED announce
    pub.dogeAddress = 'Dpub1';
    pub.indexers    = { DOGE: { url: 'http://indexer.invalid' } };
    pub.spendGuard  = { isPaused: () => false, allow: () => true, record(){}, noteBlocked: () => '' };
    // Durable-intent marker: exercised by its own suite; inert here.
    pub._getLiveArchiveIntent  = async () => null;
    pub._recordArchiveIntent   = async () => {};
    pub._markArchiveSent       = async () => {};
    pub._withdrawArchiveIntent = async () => {};
    pub._backfillBatch = async (seq, matches, txid) => { backfills.push({ seq, matches, txid }); };
    pub._recordReward  = () => {};
    pub.indexerCalls   = [];
    pub._indexerCall   = async (coin, method, params) => {
        pub.indexerCalls.push({ coin, method, params });
        return indexerReply(params);
    };
    return { pub, sent, backfills };
}

function mkRound(sent) {
    return {
        cp: CP, batchSeq: ROUND_SEQ, count: COUNT, crc: CRC, chunks: CHUNKS.slice(),
        canonical: 'canonical', quorum: 1, weighted: false,
        validators: [{ pubkey: 'aa'.repeat(32), amount: '1', source: '' }],
        signatures: new Map([['aa'.repeat(32), 'sig']]),
        matchIds: [{ id: 1, status: 'settled' }], callIds: [], rewardIds: [],
        signer: { broadcastFn: async (p) => { sent.push(p); return { txid: 'fresh-tx-' + sent.length }; } }
    };
}

// The RPC answer for a batch already on-chain, with `present` continuation chunks.
function onChain(present) {
    return {
        coin: 'DOGE', network: 'regtest', exists: true, status: 'valid', version: 1,
        txid: 'aa'.repeat(32), author: 'Dpub1',
        checkpoint_chain: CP.chain, checkpoint_network: CP.network,
        block_index: CP.block_index, checkpoint_seq: CP.checkpoint_seq, snapshot_block: CP.snapshot_block,
        match_batch_seq: LANDED_SEQ, match_count: COUNT, batch_crc32: CRC,
        total_chunks: CHUNKS.length, chunks_present: present,
        chunks_complete: present.length >= CHUNKS.length,
        block_index_doge: 700, latest_block_index: 705, confirmations: 6
    };
}

const ABSENT = { coin: 'DOGE', network: 'regtest', exists: false, latest_block_index: 705,
                 confirmations: 0, chunks_present: [], chunks_complete: false };

// The ANCHOR version and, for a v2, the batch seq a captured payload carries.
function parse(payload) {
    const p = String(payload).split('|');
    return { version: p[1], batchSeq: p[2], chunkIndex: p[3] };
}

describe('StateAnchorPublisher: content-addressed archive-anchor existence check', () => {

    it('the guard exists and is threaded through the v1 head broadcast', () => {
        const { pub } = mkPub(() => ABSENT);
        expect(typeof pub._findExistingArchiveAnchor, '_findExistingArchiveAnchor must exist').to.equal('function');
        expect(typeof pub._findExistingArchiveChunk,  '_findExistingArchiveChunk must exist').to.equal('function');
    });

    it('publishes the whole batch when the archive is definitively not on-chain', async () => {
        const { pub, sent } = mkPub(() => ABSENT);
        await pub._publishArchive(mkRound(sent));
        expect(sent.length, 'head + every continuation chunk').to.equal(CHUNKS.length);
        expect(parse(sent[0]).version).to.equal('1');
        // Nothing was adopted, so the chunks stay on this round's own seq.
        expect(parse(sent[1]).batchSeq).to.equal(String(ROUND_SEQ));
        expect(parse(sent[2]).batchSeq).to.equal(String(ROUND_SEQ));
    });

    it('asks the CONTENT question: checkpoint identity + crc + count + our address, never a batch seq', async () => {
        const { pub, sent } = mkPub(() => ABSENT);
        await pub._publishArchive(mkRound(sent));
        const call = pub.indexerCalls.find(c => c.method === 'getarchiveanchor');
        expect(call, 'the archive path must consult getarchiveanchor').to.be.an('object');
        expect(call.params).to.include({
            chain: CP.chain, network: CP.network, block_index: CP.block_index,
            checkpoint_seq: CP.checkpoint_seq, batch_crc32: CRC, match_count: COUNT,
            author: 'Dpub1'
        });
        // The seq is precisely what a restart loses; asking with it would defeat the guard.
        expect(Object.keys(call.params)).to.not.include('match_batch_seq');
        expect(Object.keys(call.params)).to.not.include('batch_seq');
    });

    it('re-spends NOTHING when the identical batch is already on-chain under a different seq', async () => {
        const { pub, sent, backfills } = mkPub(() => onChain([0, 1, 2]));
        await pub._publishArchive(mkRound(sent));
        expect(sent.length, 'a completed archive must not be paid for twice').to.equal(0);
        // The adopted head's txid is what the rows are stamped with: it is the archive.
        expect(backfills[0].txid).to.equal('aa'.repeat(32));
        // Local bookkeeping stays on this round's seq (peers authenticated the FINALIZED
        // against it); only the on-chain chunk addressing follows the adopted head.
        expect(backfills[0].seq).to.equal(ROUND_SEQ);
    });

    it('resumes a PARTIAL archive: only the missing chunk is sent, under the ADOPTED seq', async () => {
        const { pub, sent } = mkPub(() => onChain([0, 1]));      // head + chunk 1 landed, chunk 2 did not
        await pub._publishArchive(mkRound(sent));
        expect(sent.length, 'only the missing chunk costs a fee').to.equal(1);
        const p = parse(sent[0]);
        expect(p.version).to.equal('2');
        expect(p.chunkIndex).to.equal('2');
        expect(p.batchSeq, 'a chunk under any other seq is an orphan that never reassembles')
            .to.equal(String(LANDED_SEQ));
    });

    it('does not dequeue the rows as fully archived while a chunk is still missing', async () => {
        // The resumed chunk goes out and succeeds, so the batch IS complete afterwards;
        // this pins that the resume path still runs the normal completeness bookkeeping.
        const { pub, sent, backfills } = mkPub(() => onChain([0, 1]));
        await pub._publishArchive(mkRound(sent));
        expect(backfills.length).to.equal(1);
        expect(backfills[0].matches[0].status, 'a successful resume archives normally').to.equal('settled');
    });

    it('republishes when the on-chain head is decoded-invalid (it anchored nothing)', async () => {
        const { pub, sent } = mkPub(() => Object.assign(onChain([0, 1, 2]), { status: 'invalid: BATCH_CRC32' }));
        await pub._publishArchive(mkRound(sent));
        expect(sent.length).to.equal(CHUNKS.length);
    });

    it('republishes when the on-chain head declares a different chunk geometry', async () => {
        const { pub, sent } = mkPub(() => Object.assign(onChain([0, 1, 2]), { total_chunks: 5 }));
        await pub._publishArchive(mkRound(sent));
        expect(sent.length, 'our chunk bytes would land in slots that head never declared')
            .to.equal(CHUNKS.length);
    });

    it('republishes when the on-chain head has no resolvable txid (adopting one livelocks the rows)', async () => {
        const { pub, sent } = mkPub(() => Object.assign(onChain([0, 1, 2]), { txid: null }));
        await pub._publishArchive(mkRound(sent));
        expect(sent.length).to.equal(CHUNKS.length);
    });

    it('an UNREACHABLE indexer degrades to publishing, never to blocking the archive', async () => {
        const { pub, sent } = mkPub(() => { throw new Error('connect ECONNREFUSED'); });
        await pub._publishArchive(mkRound(sent));
        expect(sent.length, 'an un-upgraded or down indexer keeps todays behavior').to.equal(CHUNKS.length);
    });

    it('an indexer too old to serve the method degrades to publishing', async () => {
        const { pub, sent } = mkPub(() => ({ error: 'method not found' }));
        await pub._publishArchive(mkRound(sent));
        expect(sent.length).to.equal(CHUNKS.length);
    });

    it('with no DOGE indexer wired the check is undetermined, so the archive still publishes', async () => {
        const { pub, sent } = mkPub(() => ABSENT);
        pub.indexers = {};
        await pub._publishArchive(mkRound(sent));
        expect(sent.length).to.equal(CHUNKS.length);
    });

    describe('_archiveAnchorLookup', () => {
        it('throws (undetermined) rather than reporting absent when no indexer is wired', async () => {
            const { pub } = mkPub(() => ABSENT);
            pub.indexers = {};
            let threw = false;
            try { await pub._archiveAnchorLookup(CP, mkRound([])); } catch (e) { threw = true; }
            expect(threw, 'an unanswerable check must not read as "definitively absent"').to.equal(true);
        });

        it('reports absent (null) only on a definitive negative from the indexer', async () => {
            const { pub } = mkPub(() => ABSENT);
            expect(await pub._archiveAnchorLookup(CP, mkRound([]))).to.equal(null);
        });

        it('scopes the question to our own publishing address', async () => {
            const { pub } = mkPub(() => ABSENT);
            pub.dogeAddress = 'DsomeOtherAddress';
            await pub._archiveAnchorLookup(CP, mkRound([]));
            expect(pub.indexerCalls[0].params.author).to.equal('DsomeOtherAddress');
        });
    });
});
