'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const sinon = require('sinon');
const { expect } = require('chai');
const { setup, producerRows, walkOf, withId } = require('../helpers/price_round_fixtures.js');

function writtenPairs(db) {
    return db.setFinalizedPriceSnapshotRound.getCalls().flatMap(call =>
        call.args[1].map(pair => call.args[0] + '|' + pair.coinPair)).sort();
}

function splitRows(env, laterRows) {
    const [sevenBtc] = producerRows(env, 7, 1);
    const eight = producerRows(env, 8, 2);
    return [withId(sevenBtc, 1), ...eight.map((row, index) => withId(row, index + 2)),
        withId(laterRows[1], 4)];
}

describe('price catch-up round write parity', function () {
    afterEach(function () { sinon.restore(); });

    it('stores every missing pair of a verified producer round in one writer call', async function () {
        const env = setup();
        const rows = producerRows(env, 7, 1);
        const { catchup } = walkOf(env, rows, 3);
        await catchup.run();
        expect(env.db.setFinalizedPriceSnapshotRound.calledOnce).to.equal(true);
        expect(env.db.setFinalizedPriceSnapshotRound.firstCall.args[1].map(pair => pair.coinPair))
            .to.deep.equal(['BTC/USD', 'LTC/USD']);
    });

    it('offers the complete producer group to a failing writer exactly once', async function () {
        const env = setup();
        env.db.setFinalizedPriceSnapshotRound.rejects(new Error('write failed'));
        const { catchup } = walkOf(env, producerRows(env, 7, 1), 3);
        await catchup.run();
        expect(env.db.setFinalizedPriceSnapshotRound.calledOnce).to.equal(true);
        expect(env.db.setFinalizedPriceSnapshotRound.firstCall.args[1]).to.have.length(2);
    });
});

describe('price catch-up completion from locally held round rows', function () {
    afterEach(function () { sinon.restore(); });

    it('verifies an unheld later fragment with the matching first fragment held locally', async function () {
        const env = setup();
        const seven = producerRows(env, 7, 1);
        const rows = splitRows(env, seven);
        env.db.findPriceSnapshotsForRound.callsFake(async round => Number(round) === 7 ? [seven[0]] : []);
        const { catchup, logger } = walkOf(env, rows, 2);
        await catchup.run();
        expect(writtenPairs(env.db)).to.include.members(['7|LTC/USD', '8|BTC/USD', '8|LTC/USD']);
        expect(writtenPairs(env.db)).not.to.include('7|BTC/USD');
        expect(catchup.refusals.size()).to.equal(0);
        expect(logger.warn.calledWithMatch('refused')).to.equal(false);
    });

    it('still refuses a forged later fragment when a different signed fragment is held', async function () {
        const env = setup();
        const honest = producerRows(env, 7, 1);
        const forged = producerRows(env, 7, 1, { forged: true });
        env.db.findPriceSnapshotsForRound.callsFake(async round => Number(round) === 7 ? [honest[0]] : []);
        const { catchup, logger } = walkOf(env, splitRows(env, forged), 2);
        await catchup.run();
        expect(writtenPairs(env.db)).not.to.include('7|LTC/USD');
        expect(catchup.refusals.size()).to.equal(1);
        expect(logger.warn.calledWithMatch('refused')).to.equal(true);
    });
});
