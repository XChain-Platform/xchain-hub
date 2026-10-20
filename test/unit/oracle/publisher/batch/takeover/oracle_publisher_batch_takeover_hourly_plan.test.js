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
const { createWindowPlan } = require('../../../../../../src/oracle/publisher/window_plan');

// Past the hourly switch a window is wider than batchWindowRounds, so takeover's
// guards must read the plan's range or they look at rounds the window does not hold.
// Plan: 2-round windows below round 12 (switch window 6), 6-round windows from it,
// so window 7 is rounds 18..23 while the pre-switch arithmetic would say 14..15.
const SWITCHED = { firstRound: 12, smallRounds: 2, largeRounds: 6 };

async function switchedFollower(opts) {
    let snapshots = [{ round_number: opts.landed, batch: true, status: 'finalized' }];
    let h = makePublisher({
        publishers: [ME, PEER1, PEER2],
        db:  makeDb({ snapshots: snapshots }),
        cfg: { ORACLE_PUBLISH_FAILOVER_WINDOW_BLOCKS: '2' }
    });
    await h.p.start();
    h.p.batchWindowRounds = SWITCHED.smallRounds;
    h.p.windowPlan = createWindowPlan(SWITCHED);
    for (let r = 0; r < 24; r++) h.p._buffer.set(r, bufferedFixture(r));
    return h;
}

describe('oracle publisher batch: takeover under a switched hourly window plan', function () {
    afterEach(function () { cleanupPublisherBatch(); });

    it('declines when the leader landed a round inside the plan range of the window', async function () {
        let h = await switchedFollower({ landed: 20 });
        sinon.stub(console, 'warn');
        expect(await h.p.attemptTakeover(7)).to.equal(false);
        expect(h.p.getStats().takeoverAttempts).to.equal(0);
        expect(h.broadcasts).to.have.length(0);
    });

    it('asks the co-signature memo about the plan range of the window', async function () {
        let h = await switchedFollower({ landed: 99 });
        sinon.stub(console, 'warn');
        h.signer.coSignedAt = sinon.stub().returns(Date.now() - 1000);
        expect(await h.p.attemptTakeover(7)).to.equal(false);
        expect(h.signer.coSignedAt.firstCall.args).to.deep.equal([18, 23]);
        expect(h.p.getStats().takeoverDeferred).to.equal(1);
    });
});
