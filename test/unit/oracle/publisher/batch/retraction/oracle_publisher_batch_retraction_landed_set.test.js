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
    makeDb,
    makePublisher,
    cleanupPublisherBatch
} = require('../oracle_publisher_batch.test.js');

// A round shed after its batch landed is remembered as landed, which exempts it from
// the bounds fill and the coverage self-check. A retraction removes the batch from
// the chain, so the exemption has to go with it even when the restore cannot put the
// round back in the buffer; otherwise a window is signed with a hole in it.

const WINDOW = [0, 1, 2, 3, 4, 5];

// A publisher whose window 0 landed (every round shed) and whose restore read fails.
async function landedWindow() {
    let db = makeDb();
    db.findV0PriceSnapshotsForRounds = async () => { throw new Error('read failed'); };
    db.findPriceSnapshotsByRoundNumberAndStatus = async () => [{ round_number: 5 }];
    let h = makePublisher({ db: db, cfg: { ORACLE_BATCH_GRACE_MS: 60000 } });
    await h.p.start();
    for (let r of WINDOW) h.p._buffer.set(r, bufferedFixture(r));
    h.p.noteBatchLanded(0, 5, null);
    expect(h.p._buffer.size).to.equal(0);
    sinon.stub(h.p, 'roundsCarriedByChain').resolves(new Set());
    return h;
}

function heldRounds(numbers) {
    return numbers.map(r => bufferedFixture(r));
}

const unmarksWhenNotCarried = async function () {
    let h = await landedWindow();
    expect(h.p.isRoundLanded(5), 'landed before the retraction').to.equal(true);

    await h.p.clearPublishedMarkers([5], new Set());

    expect(h.p.isRoundLanded(5)).to.equal(false);
    expect(h.p.isRoundLanded(4), 'a round the retraction did not name stays landed').to.equal(true);
};

const keepsWhenCarried = async function () {
    let h = await landedWindow();

    await h.p.clearPublishedMarkers([5], new Set([5]));

    expect(h.p.isRoundLanded(5)).to.equal(true);
};

const fillNoLongerExempts = async function () {
    let h = await landedWindow();
    let signer = { fillWindowBounds: sinon.stub().resolves(true) };

    expect(await h.p.fillWindowToBounds(signer, 0, 5, heldRounds([0, 1, 2, 3, 4]), 800004)).to.equal(true);
    expect(signer.fillWindowBounds.called, 'a landed round needs no fill (control)').to.equal(false);

    await h.p.clearPublishedMarkers([5], new Set());
    await h.p.fillWindowToBounds(signer, 0, 5, heldRounds([0, 1, 2, 3, 4]), 800004);

    expect(signer.fillWindowBounds.calledOnce).to.equal(true);
    expect(Array.from(signer.fillWindowBounds.firstCall.args[4])).to.not.include(5);
};

const coverageNoLongerWavesThrough = async function () {
    let h = await landedWindow();
    let held = heldRounds([0, 1, 2, 3, 4]);

    expect(await h.p.windowCoverageComplete(0, 5, held), 'landed round is no hole (control)').to.equal(true);

    await h.p.clearPublishedMarkers([5], new Set());

    expect(await h.p.windowCoverageComplete(0, 5, held)).to.equal(false);
};

function registerRetractionLandedSet() {
    afterEach(function () {
        cleanupPublisherBatch();
    });
    it('forgets a retracted round the chain no longer carries', unmarksWhenNotCarried);
    it('keeps the landed record of a retracted round the chain still carries', keepsWhenCarried);
    it('asks for a retracted unrestored round in the bounds fill instead of exempting it', fillNoLongerExempts);
    it('holds the window back on a retracted unrestored round in the coverage check', coverageNoLongerWavesThrough);
}

describe('OraclePublisher retraction and the landed-round record', registerRetractionLandedSet);
