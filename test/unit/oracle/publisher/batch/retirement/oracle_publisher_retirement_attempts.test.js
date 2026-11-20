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

const {
    sinon,
    expect,
    bufferedFixture,
    makePublisher,
    cleanupPublisherBatch,
} = require('../oracle_publisher_batch.test.js');

async function publisherWithClosedWindow(opts) {
    const h = makePublisher(
        Object.assign(
            {
                cfg: { ORACLE_BATCH_CATCHUP_MAX_ATTEMPTS: 2, ORACLE_BATCH_CATCHUP_RETIRE_AFTER_MS: 0 },
            },
            opts,
        ),
    );
    await h.p.start();
    for (let round = 0; round < 7; round++) h.p._buffer.set(round, bufferedFixture(round));
    return h;
}

async function runSweeps(publisher, count) {
    for (let i = 0; i < count; i++) {
        publisher.sweepBufferCatchup();
        await publisher._windowChain;
    }
}

function expectNotRetired(h) {
    expect(h.p.getStats().batchCatchupRetiredWindows).to.equal(0);
    expect(h.p.pendingCatchupWindows()).to.deep.equal([0]);
    expect(h.p._catchupAttempts.has(0)).to.equal(false);
}

describe('OraclePublisher catch-up retirement attempts', function () {
    afterEach(function () {
        cleanupPublisherBatch();
    });

    const preSigningFailures = [
        ['bounds fill failure', (p) => sinon.stub(p, 'fillWindowToBounds').resolves(false)],
        ['coverage failure', (p) => sinon.stub(p, 'windowCoverageComplete').resolves(false)],
        ['unresolved publisher set', (p) => sinon.stub(p, 'getActiveOraclePublishPubkeys').resolves([])],
    ];

    for (const [name, failBeforeSigning] of preSigningFailures) {
        it('does not retire after repeated ' + name, async function () {
            const h = await publisherWithClosedWindow();
            failBeforeSigning(h.p);

            await runSweeps(h.p, 6);

            expectNotRetired(h);
            expect(h.signer.calls).to.have.length(0);
        });
    }

    it('counts only signing rounds that return below quorum', async function () {
        const h = await publisherWithClosedWindow({ signerOpts: { met: false } });
        const fill = sinon.stub(h.p, 'fillWindowToBounds').resolves(false);
        await runSweeps(h.p, 3);
        expectNotRetired(h);
        fill.restore();

        await runSweeps(h.p, 2);
        expect(h.p._catchupAttempts.get(0).count).to.equal(2);
        expect(h.p.getStats().batchCatchupRetiredWindows).to.equal(0);

        await runSweeps(h.p, 1);
        expect(h.signer.calls).to.have.length(2);
        expect(h.p.getStats().batchCatchupRetiredWindows).to.equal(1);
        expect(h.p.pendingCatchupWindows()).to.deep.equal([]);
    });
});
