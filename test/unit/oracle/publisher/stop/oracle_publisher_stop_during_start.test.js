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

const { EventEmitter } = require('node:events');
const {
    sinon,
    expect,
    bufferedFixture,
    makePublisher,
    cleanupPublisherBatch,
} = require('../batch/oracle_publisher_batch.test.js');

function gatedPublisher() {
    const h = makePublisher({ db: {} });
    h.hub.oracleConsensus = new EventEmitter();
    h.p.encoder = {};
    h.p.dogeAddress = 'wallet-address';
    h.p.confirmCheckIntervalMs = 1000;
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    sinon.stub(h.p, 'hydratePublishedMarkers').returns(gate);
    return { h, release };
}

function expectRails(h, armed) {
    expect(h.hub.oracleConsensus.listenerCount('round:finalized')).to.equal(armed ? 1 : 0);
    for (const timer of ['_catchupTimer', '_catchupSweepTimer', '_confirmTimer']) {
        if (armed) expect(h.p[timer], timer).to.not.equal(null);
        else expect(h.p[timer], timer).to.equal(null);
    }
}

describe('OraclePublisher stop during start', function () {
    afterEach(function () {
        cleanupPublisherBatch();
    });

    it('arms every publish rail after marker hydration completes', async function () {
        const { h, release } = gatedPublisher();
        const starting = h.p.start();
        h.p._buffer.set(0, bufferedFixture(0));
        release();

        await starting;

        expectRails(h, true);
    });

    it('leaves every publish rail stopped when stop wins the hydration race', async function () {
        const { h, release } = gatedPublisher();
        const starting = h.p.start();
        h.p._buffer.set(0, bufferedFixture(0));
        h.p.stop();
        release();

        await starting;

        expectRails(h, false);
    });

    it('does not arm direct watchdog or rail calls after stop', function () {
        const { h } = gatedPublisher();
        h.p.stop();

        h.p.startConfirmationWatchdog();
        h.p.armPublishRails();

        expectRails(h, false);
    });

    it('does not reconcile against the chain after stop', async function () {
        const h = makePublisher();
        const reconcile = sinon.stub(h.p, 'reconcileBacklogAgainstChain').resolves();
        h.p.stop();

        expect(await h.p.reconcileThenSweep()).to.equal(0);
        expect(reconcile.called).to.equal(false);
    });
});
