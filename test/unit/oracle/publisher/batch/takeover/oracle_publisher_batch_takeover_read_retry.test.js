/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************/

'use strict';

const {
    sinon,
    expect,
    ME,
    PEER1,
    PEER2,
    makeDb,
    makePublisher,
    bufferedFixture,
    cleanupPublisherBatch
} = require('../oracle_publisher_batch.test.js');

let logs;
let clock;

// A follower whose takeover read fails has already lost the timer that brought it
// there, and the window is memoized, so the decline itself has to put it back on
// the clock or one DB fault cancels this hub's cover for the window.

// ME is rank 0 of three, so window 1 (rounds 6..11) belongs to PEER1.
async function followerOf(opts) {
    opts = opts || {};
    let snapshots = [];
    for (let round of (opts.landed || [])) snapshots.push({ round_number: round, batch: true, status: 'finalized' });
    for (let r = 0; r < 12; r++) snapshots.push({ round_number: r, status: 'finalized' });
    let h = makePublisher({
        publishers: [ME, PEER1, PEER2],
        db:  makeDb({ snapshots: snapshots }),
        cfg: { ORACLE_PUBLISH_FAILOVER_WINDOW_BLOCKS: '2' }
    });
    await h.p.start();
    for (let r = 0; r < 12; r++) h.p._buffer.set(r, bufferedFixture(r));
    return h;
}

function dbDown(h) {
    let working = h.hub.db.doQuery;
    h.hub.db.doQuery = sinon.stub().rejects(new Error('hub db down'));
    return () => { h.hub.db.doQuery = working; };
}

function captureLogsAndClean() {
    beforeEach(function () {
        logs = { log: [], warn: [], error: [] };
        sinon.stub(console, 'log').callsFake((...a) => logs.log.push(a.join(' ')));
        sinon.stub(console, 'warn').callsFake((...a) => logs.warn.push(a.join(' ')));
        sinon.stub(console, 'error').callsFake((...a) => logs.error.push(a.join(' ')));
    });
    afterEach(function () {
        if (clock) { clock.restore(); clock = null; }
        cleanupPublisherBatch();
    });
}

describe('oracle publisher batch: takeover re-armed after an unreadable on-chain check', function () {
    captureLogsAndClean();

    it('re-attempts the takeover once the DB is back, past the on-chain check', async function () {
        let h = await followerOf({ landed: [99] });
        await h.p.observationFeedProven();
        h.p._lastRankState = { publisherCount: 3 };   // what the follower's election records
        clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        let restore = dbDown(h);
        expect(await h.p.attemptTakeover(1)).to.equal(false);
        expect(h.p.getStats().takeoverPending, 'the decline re-armed itself').to.equal(1);
        expect(h.p.getStats().takeoverAttempts).to.equal(0);
        restore();
        let step = h.p.failoverWindowBlocks * h.p.approxBlockMs;
        await clock.tickAsync(2 * step);
        await h.p._windowChain;
        expect(h.p.getStats().takeoverAttempts, 'not on the next rank\'s slot').to.equal(0);
        await clock.tickAsync(step);
        await h.p._windowChain;
        let s = h.p.getStats();
        expect(s.takeoverAttempts, 'the retry passed the read check and the election').to.equal(1);
        expect(s.takeoverDeclinedReadError).to.equal(1);
        expect(s.takeoverReadRetryExhausted).to.equal(0);
        expect(h.p._takeoverReadRetries.has(1)).to.equal(false);
    });

    it('gives up after the retry budget with an error, a counter and no broadcast', async function () {
        let h = await followerOf({ landed: [99] });
        await h.p.observationFeedProven();
        clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        dbDown(h);
        expect(await h.p.attemptTakeover(1)).to.equal(false);
        for (let i = 0; i < 6; i++) {
            await clock.tickAsync(h.p.takeoverReadRetryDelayMs());
            await h.p._windowChain;
        }
        let s = h.p.getStats();
        expect(s.takeoverDeclinedReadError).to.equal(7);
        expect(s.takeoverReadRetryExhausted).to.equal(1);
        expect(s.takeoverPending).to.equal(0);
        expect(s.takeoverAttempts).to.equal(0);
        expect(h.broadcasts).to.have.length(0);
        expect(logs.error.some(l => /no longer covers it until restart/.test(l))).to.equal(true);
    });
});

describe('oracle publisher batch: read-error takeover retry state', function () {
    captureLogsAndClean();

    it('drops a pending read retry when the window lands or the publisher stops', async function () {
        let h = await followerOf({ landed: [99] });
        await h.p.observationFeedProven();
        clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        dbDown(h);
        await h.p.attemptTakeover(1);
        await h.p.attemptTakeover(0);
        expect(h.p._takeoverReadRetries.size).to.equal(2);
        h.p.noteBatchLanded(6, 11);
        expect(h.p._takeoverTimers.has(1)).to.equal(false);
        expect(h.p._takeoverReadRetries.has(1)).to.equal(false);
        h.p.stop();
        expect(h.p._takeoverReadRetries.size).to.equal(0);
        expect(h.p._takeoverTimers.size).to.equal(0);
    });

    it('re-arms on a DB error in the feed proof but not on a feed that read cleanly and is dark', async function () {
        let dark = await followerOf({});
        expect(await dark.p.attemptTakeover(1)).to.equal(false);
        expect(dark.p.getStats().takeoverDeclinedUnproven).to.equal(1);
        expect(dark.p.getStats().takeoverPending, 'a deaf feed declines for good').to.equal(0);

        let h = await followerOf({ landed: [99] });
        h.hub.db.hasPriceSnapshotsByConsensusProof = sinon.stub().rejects(new Error('hub db down'));
        expect(await h.p.attemptTakeover(1)).to.equal(false);
        expect(h.p.getStats().takeoverDeclinedUnproven).to.equal(1);
        expect(h.p.getStats().takeoverPending, 'the read error re-armed it').to.equal(1);
        expect(h.broadcasts).to.have.length(0);
    });
});
