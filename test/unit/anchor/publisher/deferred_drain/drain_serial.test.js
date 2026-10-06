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

// The three deferred-announcement drains run from their own timer and from the head of
// every flush. Each pass walks a copy of its queue and awaits slow indexer lookups, so two
// overlapping passes would hold the same entry and verify and apply it twice. Passes of
// one drain run one at a time, and a caller that arrives mid-pass gets a fresh pass rather
// than the running one, so flush still sees an entry queued after that pass began.

const { expect }           = require('chai');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');
const { serialPass }       = require('../../../../../src/anchor/publisher/drain_serial.js');

// A promise the test resolves by hand, standing in for a slow indexer lookup.
function held() {
    let release;
    let promise = new Promise((resolve) => { release = resolve; });
    return { promise, release };
}

// Let every queued microtask and timer callback run.
function settle() { return new Promise((resolve) => setImmediate(resolve)); }

const CP_ROW = { chain: 'BTC', network: 'regtest', block_index: 494, checkpoint_seq: 7, snapshot_block: 100, anchor_txid: null };

function makePub() {
    let pub = new StateAnchorPublisher({ db: {}, getIdentity: () => null, hubDbBroadcaster: null });
    pub.db = { getStateCheckpointByChain: async () => [Object.assign({}, CP_ROW)] };
    pub.lookups = [];
    pub.verifyAnchorOnChain = () => { let h = held(); pub.lookups.push(h); return h.promise; };
    pub.verifyArchiveCheckpointOnChain = () => { let h = held(); pub.lookups.push(h); return h.promise; };
    pub.verifyFinalizedAgainstLocal = async () => true;
    pub.applied = [];
    pub.applyBundleDone = async (d) => { pub.applied.push('bundle:' + d.txid); };
    pub.applyFinalized = async (d) => { pub.applied.push('finalized:' + d.txid); };
    pub.recordRewardAttestation = async (...a) => { pub.applied.push('reward:' + a[7]); };
    return pub;
}

function queueBundleDone(pub, txid) {
    let d = { network: 'regtest', snapshot_block: 100, txid: txid,
        sections: [{ chain: 'BTC', block_index: 494, checkpoint_seq: 7 }] };
    pub._deferredBundleDone.set('regtest|100|' + txid, { d: d, sender: 'aa'.repeat(32), at: Date.now() });
}

function queueFinalized(pub, txid) {
    let d = { batch_seq: 3, txid: txid, matches: [] };
    pub._deferredFinalized.set('regtest|3|' + txid, { d: d, sender: 'aa'.repeat(32), calls: [], rewards: [], quorumRows: {}, at: Date.now() });
}

function queueReward(pub, txid) {
    pub._deferredRewardAttest.set('reward|' + txid, { chain: 'BTC', network: 'regtest', blockIndex: 494,
        checkpointSeq: 7, txid: txid, anchorVersion: 0, rewardType: 'anchor_bundle', roundReference: 100,
        snapshotBlock: 100, publisher: 'cd'.repeat(32), attestSigs: [], at: Date.now() });
}

// Release every lookup in flight with `verdict`, then let the passes run on.
async function releaseAll(pub, verdict) {
    for (let i = 0; i < 10 && pub.lookups.length; i++) {
        pub.lookups.splice(0).forEach(h => h.release(verdict));
        await settle();
    }
}

describe('serialPass: one pass at a time per drain', function () {
    it('never overlaps two passes, and every caller arriving mid-pass shares one fresh pass', async function () {
        let owner = {}, running = 0, maxRunning = 0, starts = 0, gates = [];
        let run = async () => {
            starts++; running++; maxRunning = Math.max(maxRunning, running);
            let h = held(); gates.push(h); await h.promise; running--;
        };
        let first = serialPass(owner, 'slot', run);
        let second = serialPass(owner, 'slot', run);
        let third = serialPass(owner, 'slot', run);
        expect(second).to.equal(third);
        expect(starts).to.equal(1);
        gates[0].release(); await settle();
        expect(starts, 'the queued pass starts once the first settles').to.equal(2);
        gates[1].release(); await Promise.all([first, second, third]);
        expect(maxRunning).to.equal(1);
        expect(owner.slot).to.deep.equal({ running: null, next: null });
    });

    it('clears the slot after a pass rejects, so the next call runs a new pass', async function () {
        let owner = {}, starts = 0;
        let err = await serialPass(owner, 'slot', async () => { starts++; throw new Error('indexer down'); })
            .then(() => null, e => e);
        expect(err && err.message).to.equal('indexer down');
        await settle();
        await serialPass(owner, 'slot', async () => { starts++; });
        expect(starts).to.equal(2);
    });
});

describe('deferred drains: overlapping callers apply each entry once', function () {
    for (let [name, queue, drain] of [
        ['BUNDLE_DONE', queueBundleDone, 'drainDeferredBundleDone'],
        ['FINALIZED', queueFinalized, 'drainDeferredFinalized'],
        ['reward attestation', queueReward, 'drainDeferredRewardAttest'],
    ]) {
        it(name + ': a second call during a slow pass does not re-apply the same entry', async function () {
            let pub = makePub();
            queue(pub, 'aa'.repeat(32));
            let first = pub[drain]();
            await settle();
            let second = pub[drain]();
            await settle();
            expect(pub.lookups, 'only one pass reached the indexer').to.have.lengthOf(1);
            await releaseAll(pub, 'verified');
            await Promise.all([first, second]);
            expect(pub.applied).to.have.lengthOf(1);
        });
    }
});

describe('flush ordering: drainDeferredAnnouncements sees an entry queued mid-pass', function () {
    it('applies a BUNDLE_DONE queued after a running timer pass began, before it resolves', async function () {
        let pub = makePub();
        queueBundleDone(pub, 'aa'.repeat(32));
        let timerPass = pub.drainDeferredBundleDone();
        await settle();
        queueBundleDone(pub, 'bb'.repeat(32));
        let resolved = false;
        let flushDrain = pub.drainDeferredAnnouncements().then(() => { resolved = true; });
        await settle();
        expect(resolved, 'flush waits for the running pass').to.equal(false);
        await releaseAll(pub, 'verified');
        await Promise.all([timerPass, flushDrain]);
        expect(pub.applied).to.include('bundle:' + 'bb'.repeat(32));
        expect(pub.applied.filter(a => a === 'bundle:' + 'aa'.repeat(32))).to.have.lengthOf(1);
    });
});
