'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const {
    expect,
    bufferedFixture,
    makeDb,
    makePublisher,
    cleanupPublisherBatch
} = require('../oracle_publisher_batch.test.js');

function makeCoveragePublisher(rows) {
    const db = makeDb();
    db.findPriceSnapshotsByRoundNumberAndStatus = async () => rows;
    const h = makePublisher({ db });
    h.p.roundsCarriedByChain = async () => new Set();
    return h.p;
}

function heldRounds() {
    return [0, 1, 2, 3, 4].map(bufferedFixture);
}

describe('OraclePublisher batch-sourced coverage', function () {
    afterEach(cleanupPublisherBatch);

    it('accepts an unbuffered round whose finalized rows all came from a landed batch', async function () {
        const p = makeCoveragePublisher([
            { round_number: 5, proof_head: '{"batch"' },
            { round_number: 5, proof_head: '{"batch"' }
        ]);
        expect(await p.windowCoverageComplete(0, 5, heldRounds())).to.equal(true);
    });

    it('withholds an unbuffered self-finalized round when the chain read is unavailable', async function () {
        const p = makeCoveragePublisher([{ round_number: 5, proof_head: '[{"pubk' }]);
        expect(await p.windowCoverageComplete(0, 5, heldRounds())).to.equal(false);
    });

    it('withholds a round with both batch-sourced and self-finalized rows', async function () {
        const p = makeCoveragePublisher([
            { round_number: 5, proof_head: '{"batch"' },
            { round_number: 5, proof_head: '[{"pubk' }
        ]);
        expect(await p.windowCoverageComplete(0, 5, heldRounds())).to.equal(false);
    });
});
