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

// A rank-wake or interval flush dropped because an earlier flush still holds the
// mutex must be visible in getAnchorStats: whether a flush is in flight, when it
// started, how many ticks were skipped and when the last skip happened.

const { expect }           = require('chai');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');
const ValidatorIdentity    = require('../../../../../src/validators/identity');

function buildPub() {
    const identity = new ValidatorIdentity('11'.repeat(32));
    const hub = {
        db: { async doQuery() { return []; } },
        network: 'regtest',
        capabilitySnapshot: null,
        capabilityRegistry: null,
        getIdentity:    () => identity,
        getPeerManager: () => ({ broadcast() {}, on() {}, removeListener() {} }),
        p2pConfig: {},
        resolveBtcLatestBlock: async () => 100
    };
    return new StateAnchorPublisher(hub);
}

describe('StateAnchorPublisher flush skip visibility', function () {
    it('reports an in-flight flush and counts a tick skipped behind it', async function () {
        const pub = buildPub();
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        pub.drainDeferredAnnouncements = () => gate;
        pub.sweepAnchorStamps = async () => 0;
        pub.flushRefusal = async () => ({ anchored: [], archive: 'none', skipped: 'test_stop' });

        const idle = pub.getAnchorStats();
        expect(idle.flushInFlight).to.equal(false);
        expect(idle.flushStartedAt).to.equal(null);
        expect(idle.flushesSkippedInFlight).to.equal(0);
        expect(idle.lastFlushSkippedAt).to.equal(null);

        const first = pub.flush();
        const busy = pub.getAnchorStats();
        expect(busy.flushInFlight).to.equal(true);
        expect(busy.flushStartedAt).to.be.a('number');

        const second = await pub.flush();
        expect(second.skipped).to.equal('already_flushing');
        const skipped = pub.getAnchorStats();
        expect(skipped.flushesSkippedInFlight).to.equal(1);
        expect(skipped.lastFlushSkippedAt).to.be.a('number');

        release();
        await first;
        const done = pub.getAnchorStats();
        expect(done.flushInFlight).to.equal(false);
        expect(done.flushStartedAt).to.equal(null);
        expect(done.flushesSkippedInFlight).to.equal(1);
    });
});
