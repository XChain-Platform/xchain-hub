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

// The ARCHIVE election key must not carry the hub-local batch seq drawn by
// _getNextBatchSeq, which is MAX(batch_seq)+1 over THIS hub's own tables with no
// consensus step: that seq is fleet-uniform only while _backfillBatch plus the XANC_FINALIZED
// gossip have landed everywhere, so one missed back-fill makes two hubs key the SAME
// wrapper checkpoint differently: each ranks itself 0 under its own key and both
// publish (batches 26 and 27 for one wrapper, seen live), and after a degraded round
// each reads itself rank 1 and NEITHER publishes (hub0 batch 38 / hub1 batch 39).
//
// These are the pure-function halves of the fix: the key is a function of the wrapper
// identity alone, and _getNextBatchSeq honours a floor learned from federation evidence
// so the lagging hub converges on the leader's numbering. The two-hub rig that drives
// them through a real round lives in
// test/integration/anchor/archiveSeqDivergence.integration.test.js.

const { expect }           = require('chai');
const StateAnchorPublisher = require('../../src/StateAnchorPublisher');
const ValidatorIdentity    = require('../../src/ValidatorIdentity');

const CP = { chain: 'BTC', network: 'regtest', block_index: 494, checkpoint_seq: 7, snapshot_block: 100 };

function mkPub(nextSeqRow){
    const identity = new ValidatorIdentity('11'.repeat(32));
    const db = { async doQuery(sql){
        if(sql.indexOf('COALESCE(GREATEST(') !== -1) return [{ next_seq: nextSeqRow }];
        return [];
    } };
    return new StateAnchorPublisher({
        db: db, network: 'regtest', p2pConfig: {},
        getIdentity: () => identity,
        getPeerManager: () => ({ on(){}, removeListener(){}, broadcast(){} }),
        rewardTracker: { anchorReward: '10.00000000', resolveSourceByPubkey: async () => 'src' },
        _resolveBtcLatestBlock: async () => 100
    });
}

describe('StateAnchorPublisher: wrapper-anchored archive election key', function () {

    describe('_archiveElectionKey', function () {

        it('is a function of the wrapper identity alone, never of the hub-local batch seq', function () {
            const pub = mkPub(0);
            // The exact divergence observed live: one wrapper, two hubs whose tables
            // differ by one missed back-fill, so they draw 38 and 39 for the same round.
            expect(pub._archiveElectionKey(CP, 38)).to.equal(pub._archiveElectionKey(CP, 39));
            expect(pub._archiveElectionKey(CP)).to.equal(pub._archiveElectionKey(CP, 26));
        });

        it('carries only quorum-agreed fields', function () {
            const pub = mkPub(0);
            const key = pub._archiveElectionKey(CP);
            // chain/network/checkpoint_seq: the wrapper's own identity, and checkpoint_seq
            // is derived from snapshot_block by the checkpoint engine, so two hubs holding
            // the same wrapper cannot disagree about any of them.
            expect(key).to.equal('XANCV2|BTC|regtest|7');
            // Fields that are per-hub bookkeeping must not appear: block_index is fine
            // (consensus), but the seq is what the defect was made of.
            expect(key.split('|')).to.have.length(4);
        });

        it('is STABLE while a batch stalls, so the failover ladder keeps a fixed anchor', function () {
            const pub = mkPub(0);
            const first = pub._archiveElectionKey(CP);
            // Nothing about a stalled round moves: same wrapper, later retry, later seq.
            expect(pub._archiveElectionKey(Object.assign({}, CP), 99)).to.equal(first);
            // And it DOES move when the wrapper advances, so leadership still rotates.
            expect(pub._archiveElectionKey(Object.assign({}, CP, { checkpoint_seq: 8 }))).to.not.equal(first);
        });

        it('gives two hubs at different batch seqs the identical rank order', function () {
            const pub = mkPub(0);
            const set = ['aa', 'bb', 'cc', 'dd'].map(s => s.repeat(32));
            const atOneSeq   = StateAnchorPublisher.hashOrder(pub._archiveElectionKey(CP, 38), set);
            const atOtherSeq = StateAnchorPublisher.hashOrder(pub._archiveElectionKey(CP, 39), set);
            expect(atOneSeq).to.deep.equal(atOtherSeq);
        });
    });

    describe('_getNextBatchSeq floor', function () {

        it('returns the row-derived seq when no consumed seq has been observed', async function () {
            expect(await mkPub(7)._getNextBatchSeq()).to.equal(7);
        });

        it('draws above a consumed seq the federation has demonstrably spent', async function () {
            const pub = mkPub(38);                 // our rows say 38; we missed the back-fills
            pub._noteConsumedBatchSeq(40, 'test');
            expect(await pub._getNextBatchSeq()).to.equal(41);
        });

        it('never walks the seq BACKWARDS on a stale observation', async function () {
            const pub = mkPub(41);
            pub._noteConsumedBatchSeq(38, 'test');
            expect(await pub._getNextBatchSeq()).to.equal(41);
        });

        it('keeps the highest floor it has seen and ignores a lower one', function () {
            const pub = mkPub(0);
            pub._noteConsumedBatchSeq(40, 'test');
            pub._noteConsumedBatchSeq(12, 'test');
            expect(pub._observedConsumedBatchSeq).to.equal(40);
        });

        it('ignores an implausible jump, so a Byzantine member cannot burn the numbering', async function () {
            const pub = mkPub(7);
            pub._noteConsumedBatchSeq(7 + pub._archiveSeqFloorMaxJump + 1, 'test');
            expect(await pub._getNextBatchSeq()).to.equal(7);
        });

        it('ignores a non-numeric observation', function () {
            const pub = mkPub(0);
            pub._noteConsumedBatchSeq('not-a-seq', 'test');
            pub._noteConsumedBatchSeq(null, 'test');
            expect(pub._observedConsumedBatchSeq).to.equal(-1);
        });
    });

    describe('_seqRefusalCanonical', function () {

        it('is tagged so a refusal can never be replayed as a co-signature or an announcement', function () {
            const pub = mkPub(0);
            const refusal = pub._seqRefusalCanonical(38, 40);
            expect(refusal).to.equal('XANCSEQ|38|40');
            expect(refusal).to.not.equal(pub._finalizedCanonical(38, '40', 0));
            expect(refusal.indexOf('XANCFIN')).to.equal(-1);
            expect(refusal.indexOf('XANCV2')).to.equal(-1);
        });

        it('binds BOTH seqs, so a refusal for one round cannot stand in for another', function () {
            const pub = mkPub(0);
            expect(pub._seqRefusalCanonical(38, 40)).to.not.equal(pub._seqRefusalCanonical(39, 40));
            expect(pub._seqRefusalCanonical(38, 40)).to.not.equal(pub._seqRefusalCanonical(38, 41));
        });
    });
});
