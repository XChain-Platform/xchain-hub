'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A deferred BUNDLE_DONE or FINALIZED whose anchor has verified on DOGE stays queued
// until its back-fill succeeds. A thrown DB read or write keeps the entry for the next
// pass; a decided rejection, a content mismatch and TTL expiry still drop it.

const { expect }           = require('chai');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');

const CP_ROW = { chain: 'BTC', network: 'regtest', block_index: 494, checkpoint_seq: 7, snapshot_block: 100, anchor_txid: null };
const TXID = 'aa'.repeat(32);

// Calls `fn` and throws on the first `failures` calls.
function failingThen(failures, fn) {
    let calls = 0;
    let wrapped = async (...a) => {
        calls++;
        if (calls <= failures) throw new Error('transient db error');
        return fn(...a);
    };
    wrapped.calls = () => calls;
    return wrapped;
}

function makePub(verdict) {
    let pub = new StateAnchorPublisher({ db: {}, getIdentity: () => null, hubDbBroadcaster: null });
    pub.db = { getStateCheckpointByChain: async () => [Object.assign({}, CP_ROW)] };
    pub.verifyAnchorOnChain = async () => verdict || 'verified';
    pub.verifyArchiveCheckpointOnChain = async () => verdict || 'verified';
    pub.verifyFinalizedAgainstLocal = async () => true;
    pub.applied = [];
    pub.applyBundleDone = async (d) => { pub.applied.push('bundle:' + d.txid); };
    pub.applyFinalized = async (d) => { pub.applied.push('finalized:' + d.txid); };
    return pub;
}

function queueBundleDone(pub, at) {
    let d = { network: 'regtest', snapshot_block: 100, txid: TXID,
        sections: [{ chain: 'BTC', block_index: 494, checkpoint_seq: 7 }] };
    pub._deferredBundleDone.set('regtest|100|' + TXID, { d: d, sender: 'cd'.repeat(32), at: at || Date.now() });
}

function queueFinalized(pub, at) {
    let d = { batch_seq: 3, txid: TXID, matches: [] };
    pub._deferredFinalized.set('3|' + TXID + '|x', { d: d, sender: 'cd'.repeat(32), calls: [], rewards: [],
        quorumRows: {}, at: at || Date.now() });
}

describe('deferred drains: an entry is dequeued only after its back-fill succeeds', function () {
    it('BUNDLE_DONE: a failed applyBundleDone keeps the entry and the next pass stamps it', async function () {
        let pub = makePub();
        pub.applyBundleDone = failingThen(1, async (d) => { pub.applied.push('bundle:' + d.txid); });
        queueBundleDone(pub);
        await pub.runBundleDoneDrain();
        expect(pub._deferredBundleDone.size, 'retained after the failed back-fill').to.equal(1);
        await pub.runBundleDoneDrain();
        expect(pub._deferredBundleDone.size).to.equal(0);
        expect(pub.applyBundleDone.calls()).to.equal(2);
        expect(pub.applied).to.deep.equal(['bundle:' + TXID]);
    });

    it('FINALIZED: a failed applyFinalized keeps the entry and the next pass stamps it', async function () {
        let pub = makePub();
        pub.applyFinalized = failingThen(1, async (d) => { pub.applied.push('finalized:' + d.txid); });
        queueFinalized(pub);
        await pub.runFinalizedDrain();
        expect(pub._deferredFinalized.size, 'retained after the failed back-fill').to.equal(1);
        await pub.runFinalizedDrain();
        expect(pub._deferredFinalized.size).to.equal(0);
        expect(pub.applyFinalized.calls()).to.equal(2);
        expect(pub.applied).to.deep.equal(['finalized:' + TXID]);
    });

    it('FINALIZED: a thrown content re-check keeps the entry and the next pass applies it', async function () {
        let pub = makePub();
        pub.verifyFinalizedAgainstLocal = failingThen(1, async () => true);
        queueFinalized(pub);
        await pub.runFinalizedDrain();
        expect(pub._deferredFinalized.size).to.equal(1);
        expect(pub.applied).to.have.lengthOf(0);
        await pub.runFinalizedDrain();
        expect(pub._deferredFinalized.size).to.equal(0);
        expect(pub.applied).to.deep.equal(['finalized:' + TXID]);
    });
});

describe('deferred drains: decided rejections and expiry still drop the entry', function () {
    it('FINALIZED: a content mismatch still drops the entry without applying it', async function () {
        let pub = makePub();
        pub.verifyFinalizedAgainstLocal = async () => false;
        queueFinalized(pub);
        await pub.runFinalizedDrain();
        expect(pub._deferredFinalized.size).to.equal(0);
        expect(pub.applied).to.have.lengthOf(0);
    });

    it('a rejected on-chain verdict still drops the entry in both drains', async function () {
        let pub = makePub('rejected:mismatch');
        queueBundleDone(pub);
        queueFinalized(pub);
        await pub.runBundleDoneDrain();
        await pub.runFinalizedDrain();
        expect(pub._deferredBundleDone.size).to.equal(0);
        expect(pub._deferredFinalized.size).to.equal(0);
        expect(pub.applied).to.have.lengthOf(0);
    });

    it('an expired entry is still dropped even while its back-fill keeps failing', async function () {
        let pub = makePub();
        pub.applyBundleDone = failingThen(99, async () => {});
        pub.applyFinalized = failingThen(99, async () => {});
        let stale = Date.now() - pub.announceRetryTtlMs - 1000;
        queueBundleDone(pub, stale);
        queueFinalized(pub, stale);
        await pub.runBundleDoneDrain();
        await pub.runFinalizedDrain();
        expect(pub._deferredBundleDone.size).to.equal(0);
        expect(pub._deferredFinalized.size).to.equal(0);
        expect(pub.applyBundleDone.calls()).to.equal(0);
        expect(pub.applyFinalized.calls()).to.equal(0);
    });
});
