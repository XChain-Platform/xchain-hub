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
    bufferedFixture,
    makePublisher,
    cleanupPublisherBatch,
} = require('../oracle_publisher_batch.test.js');

const HOUR = 3600000;
let clock;

// A short quorum looks the same whether peers refused the content or were down, so
// a window retired during an outage must come back once they recover, while still
// never taking a regular slot from the windows behind it.

async function retiredAfterOutage(rounds) {
    const signerOpts = { met: false };
    const h = makePublisher({
        signerOpts: signerOpts,
        cfg: { ORACLE_BATCH_CATCHUP_MAX_ATTEMPTS: 2, ORACLE_BATCH_CATCHUP_RETIRE_AFTER_MS: HOUR,
               ORACLE_BATCH_CATCHUP_INTERVAL_MS: HOUR },
    });
    await h.p.start();
    for (let round = 0; round < (rounds || 7); round++) h.p._buffer.set(round, bufferedFixture(round));
    await sweep(h.p);
    await sweep(h.p);
    clock.tick(HOUR);
    await sweep(h.p);
    h.signerOpts = signerOpts;
    return h;
}

async function sweep(publisher) {
    const queued = publisher.sweepBufferCatchup();
    await publisher._windowChain;
    return queued;
}

function quietClockAndClean() {
    beforeEach(function () {
        sinon.stub(console, 'log');
        sinon.stub(console, 'warn');
        sinon.stub(console, 'error');
        clock = sinon.useFakeTimers({ now: 1800000000000, toFake: ['Date'] });
    });
    afterEach(function () {
        clock.restore();
        cleanupPublisherBatch();
    });
}

describe('OraclePublisher catch-up retirement slow retry lane', function () {
    quietClockAndClean();

    it('re-proposes a window retired during an outage once its wait is over, and publishes it once', async function () {
        const h = await retiredAfterOutage();
        expect(h.p.getStats().batchCatchupRetiredWindows).to.equal(1);
        expect(h.p.getStats().batchCatchupRetiredPending).to.equal(1);
        expect(h.p._assembledWindows.has(0), 'retired is not assembled').to.equal(false);
        expect(h.p.pendingCatchupWindows()).to.deep.equal([]);
        expect(await sweep(h.p), 'not due yet').to.equal(0);

        h.signerOpts.met = true;
        clock.tick(HOUR);
        expect(await sweep(h.p)).to.equal(1);
        expect(h.broadcasts).to.have.length(1);
        const s = h.p.getStats();
        expect(s.batchCatchupRetiredPending).to.equal(0);
        expect(s.batchCatchupRetiredRecovered).to.equal(1);
        expect(s.batchCatchupRetiredWindows).to.equal(1);
        expect(h.p._catchupAttempts.has(0)).to.equal(false);
        expect(await sweep(h.p)).to.equal(0);
        expect(h.broadcasts).to.have.length(1);
    });

    it('waits twice as long after each failed retry, capped at 48 hours', async function () {
        const h = await retiredAfterOutage();
        const retryAt = [];
        for (let hour = 1; hour <= 200; hour++) {
            clock.tick(HOUR);
            if (await sweep(h.p)) retryAt.push(hour);
        }
        expect(retryAt.slice(0, 7)).to.deep.equal([1, 3, 7, 15, 31, 63, 111]);
        expect(h.p._retiredWindows.get(0).backoffMs).to.equal(48 * HOUR);
        expect(h.p._catchupAttempts.has(0), 'a retired failure does not restart the count').to.equal(false);
        expect(h.broadcasts).to.have.length(0);
    });
});

describe('OraclePublisher catch-up retirement slow lane bounds and exits', function () {
    quietClockAndClean();

    it('spends at most one extra slot per sweep on due retired windows', async function () {
        const h = makePublisher({
            signerOpts: { met: false },
            cfg: { ORACLE_BATCH_CATCHUP_MAX_ATTEMPTS: 2, ORACLE_BATCH_CATCHUP_RETIRE_AFTER_MS: HOUR,
                   ORACLE_BATCH_CATCHUP_INTERVAL_MS: HOUR },
        });
        await h.p.start();
        for (let round = 0; round < 61; round++) h.p._buffer.set(round, bufferedFixture(round));
        for (const w of [0, 1]) h.p._catchupAttempts.set(w, { count: 2, firstAt: Date.now() - 2 * HOUR });
        expect(await sweep(h.p), 'retiring costs no slot').to.equal(4);
        expect(Array.from(h.p._retiredWindows.keys())).to.deep.equal([0, 1]);
        expect(h.p.pendingCatchupWindows().length).to.be.above(4);
        clock.tick(HOUR);
        const before = h.signer.calls.length;
        expect(await sweep(h.p)).to.equal(5);
        const proposed = h.signer.calls.slice(before).map(c => c.first / 6);
        const retired = proposed.filter(w => h.p._retiredWindows.has(w));
        expect(retired).to.have.length(1);
    });

    it('leaves the slow lane when the window lands or is retracted', async function () {
        const h = await retiredAfterOutage(13);   // windows 0 and 1 closed and retired
        expect(Array.from(h.p._retiredWindows.keys())).to.deep.equal([0, 1]);
        h.p.noteBatchLanded(0, 5);
        expect(h.p._retiredWindows.has(0)).to.equal(false);
        await h.p.clearPublishedMarkers([6], new Set());
        expect(h.p._retiredWindows.has(1)).to.equal(false);
        expect(h.p.pendingCatchupWindows()).to.include(1);
    });

    it('sheds a due retired window the chain already carries instead of signing it again', async function () {
        const h = await retiredAfterOutage(13);
        clock.tick(HOUR);
        const fetch = sinon.stub(h.p, 'fetchLandedBatches')
            .resolves({ batches: [{ first_round: 0, last_round: 5, round_count: 6 }], truncated: false });
        const before = h.signer.calls.length;
        await h.p.reconcileThenSweep();
        await h.p._windowChain;
        expect(fetch.firstCall.args[0], 'the reconcile range reaches the retired window').to.equal(0);
        expect(h.p._retiredWindows.has(0)).to.equal(false);
        expect(h.p._buffer.has(0)).to.equal(false);
        expect(h.signer.calls.slice(before).map(c => c.first), 'only the uncarried window is retried').to.deep.equal([6]);
    });
});
