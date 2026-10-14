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

// A takeover declined because the hub DB cannot answer "is this window on chain?"
// must be counted apart from "the leader landed", or the status hides this hub's fault.

// ME is rank 0 of three, so window 1 belongs to PEER1; `landed` proves the feed.
async function followerOf(opts) {
    opts = opts || {};
    let snapshots = [];
    if (opts.landed) snapshots.push({ round_number: opts.landed, batch: true, status: 'finalized' });
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

describe('oracle publisher batch: takeover declined on an unreadable on-chain check', function () {
    beforeEach(function () {
        logs = { log: [], warn: [], error: [] };
        sinon.stub(console, 'log').callsFake((...a) => logs.log.push(a.join(' ')));
        sinon.stub(console, 'warn').callsFake((...a) => logs.warn.push(a.join(' ')));
        sinon.stub(console, 'error').callsFake((...a) => logs.error.push(a.join(' ')));
    });
    afterEach(function () { cleanupPublisherBatch(); });

    it('counts every read-error decline apart from the deaf-feed decline, and still broadcasts nothing', async function () {
        let h = await followerOf({ landed: 99 });
        await h.p.observationFeedProven();          // prove the feed first
        expect(h.p.getStats().takeoverDeclinedReadError).to.equal(0);
        h.hub.db.doQuery = sinon.stub().rejects(new Error('hub db down'));
        expect(await h.p.attemptTakeover(1)).to.equal(false);
        expect(await h.p.attemptTakeover(2)).to.equal(false);
        let s = h.p.getStats();
        expect(s.takeoverDeclinedReadError).to.equal(2);
        expect(s.takeoverDeclinedUnproven).to.equal(0);
        expect(s.takeoverAttempts).to.equal(0);
        expect(h.broadcasts).to.have.length(0);
    });

    it('leaves the read-error count alone when the window really is on chain', async function () {
        // Window 1 covers rounds 6..11; seeing round 7 land is a readable "observed".
        let h = await followerOf({ landed: 7 });
        expect(await h.p.attemptTakeover(1)).to.equal(false);
        expect(h.p.getStats().takeoverDeclinedReadError).to.equal(0);
        expect(h.broadcasts).to.have.length(0);
    });
});
