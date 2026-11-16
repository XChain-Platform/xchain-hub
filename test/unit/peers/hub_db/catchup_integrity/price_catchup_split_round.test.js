'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const sinon = require('sinon');
const { expect } = require('chai');
const { setup, producerRows, walkOf, storedPairs, withId } = require('../helpers/price_round_fixtures.js');
const { HUB_SCHEMA_VERSION } = require('../../../../../src/hub_schema_version.js');

function skippedMarker(env, id, round) {
    return Object.assign(withId(producerRows(env, round, id)[0], id),
        { coin_pair: 'DOGE/USD', price: null, validator_count: 0, consensus_proof: '[]', status: 'skipped' });
}

describe('price catch-up of a producer round whose rows are served on different pages', function () {
    afterEach(function () { sinon.restore(); });

    it('verifies a round whole when its second row starts the next page after another round', async function () {
        const env = setup();
        const [sevenBtc, sevenLtc] = producerRows(env, 7, 1);
        const [eightBtc, eightLtc] = producerRows(env, 8, 3);
        const rows = [withId(sevenBtc, 1), withId(eightBtc, 2), withId(eightLtc, 3), withId(sevenLtc, 4)];
        const { catchup, logger } = walkOf(env, rows, 2);
        await catchup.run();
        expect(storedPairs(env.db)).to.deep.equal(['7|BTC/USD', '7|LTC/USD', '8|BTC/USD', '8|LTC/USD']);
        expect(logger.warn.called).to.equal(false);
        expect(catchup.refusals.size()).to.equal(0);
        expect(catchup.tableCaughtUp('price_snapshots')).to.equal(true);
    });

    it('verifies a round whole when a skipped row ends the page between its two rows', async function () {
        const env = setup();
        const [sevenBtc, sevenLtc] = producerRows(env, 7, 1);
        const rows = [withId(sevenBtc, 1), skippedMarker(env, 2, 6), withId(sevenLtc, 3)];
        const { catchup, logger } = walkOf(env, rows, 2);
        await catchup.run();
        expect(storedPairs(env.db)).to.deep.equal(['7|BTC/USD', '7|LTC/USD']);
        expect(logger.warn.called).to.equal(false);
        expect(catchup.refusals.size()).to.equal(0);
    });

    it('verifies a round whose rows are several pages apart', async function () {
        const env = setup();
        const [sevenBtc, sevenLtc] = producerRows(env, 7, 1);
        const rows = [withId(sevenBtc, 1)].concat(producerRows(env, 8, 2), producerRows(env, 9, 4),
            producerRows(env, 10, 6), [withId(sevenLtc, 8)]);
        const { catchup, logger } = walkOf(env, rows, 2);
        await catchup.run();
        expect(storedPairs(env.db)).to.have.length(8);
        expect(storedPairs(env.db)).to.include.members(['7|BTC/USD', '7|LTC/USD']);
        expect(logger.warn.called).to.equal(false);
    });

});

describe('price catch-up of a split producer round that still fails at the end of the walk', function () {
    afterEach(function () { sinon.restore(); });

    it('counts, logs and remembers a forged round whose rows are split once, when the walk ends', async function () {
        const env = setup();
        const [sevenBtc, sevenLtc] = producerRows(env, 7, 1, { forged: true });
        const rows = [withId(sevenBtc, 1)].concat(producerRows(env, 8, 2), [withId(sevenLtc, 4)]);
        const { catchup, logger } = walkOf(env, rows, 2);
        await catchup.run();
        expect(storedPairs(env.db)).to.deep.equal(['8|BTC/USD', '8|LTC/USD']);
        expect(logger.warn.calledWithMatch('insufficient quorum')).to.equal(true);
        expect(logger.warn.calledWithMatch('2 price_snapshots row(s)')).to.equal(true);
        expect(catchup.refusals.size()).to.equal(1);
        expect(catchup.tableCaughtUp('price_snapshots')).to.equal(true);
    });

    it('verifies a refused round again once the peer serves its missing row, and not before', async function () {
        const env = setup();
        const [sevenBtc, sevenLtc] = producerRows(env, 7, 1);
        const rows = [withId(sevenBtc, 1)].concat(producerRows(env, 8, 2));
        const { catchup, logger } = walkOf(env, rows, 2);
        await catchup.run();
        expect(storedPairs(env.db)).to.deep.equal(['8|BTC/USD', '8|LTC/USD']);
        expect(catchup.refusals.size()).to.equal(1);
        const verified = env.hub.capabilitySnapshot.getSnapshot.callCount;
        await catchup.run();
        expect(env.hub.capabilitySnapshot.getSnapshot.callCount).to.be.at.most(verified + 2);
        expect(logger.warn.calledWithMatch('already known')).to.equal(true);
        rows.push(withId(sevenLtc, 4));
        env.db.setFinalizedPriceSnapshotRound.resetHistory();
        await catchup.run();
        expect(storedPairs(env.db)).to.include.members(['7|BTC/USD', '7|LTC/USD']);
    });
});

function fragmentedRows(env, count) {
    const target = producerRows(env, 20, 1)[0];
    const rows = [];
    for (let index = 0; index < count; index++) {
        rows.push(withId(target, index * 2 + 1));
        rows.push(skippedMarker(env, index * 2 + 2, 100 + index));
    }
    return rows;
}

describe('price catch-up bounds for a fragmented producer round', function () {
    afterEach(function () { sinon.restore(); });

    it('checks each fragment local-held state once instead of rescanning the pool', async function () {
        const env = setup();
        const rows = fragmentedRows(env, 20);
        const hasRow = sinon.stub().resolves(false);
        const { catchup } = walkOf(env, rows, 2, { hasRow });
        await catchup.run();
        expect(hasRow.callCount).to.equal(rows.length);
        expect(env.hub.capabilitySnapshot.getSnapshot.callCount).to.be.at.most(2);
    });

    it('settles and remembers a round that exceeds the per-round row cap', async function () {
        const env = setup();
        const rows = fragmentedRows(env, 3);
        const { catchup, logger } = walkOf(env, rows, 2, { maxPooledRowsPerRound: 2 });
        await catchup.run();
        expect(logger.warn.calledWithMatch('producer round exceeded catch-up row limit')).to.equal(true);
        expect(catchup.refusals.size()).to.equal(1);
    });

    it('remembers a pooled refusal when a later page fetch fails', async function () {
        const env = setup();
        const rows = fragmentedRows(env, 1);
        const fetchPage = sinon.stub();
        fetchPage.onFirstCall().resolves({ table: 'price_snapshots', schema_version: HUB_SCHEMA_VERSION, rows });
        fetchPage.onSecondCall().rejects(new Error('later page failed'));
        const { catchup, logger } = walkOf(env, rows, 2, { fetchPage });
        await catchup.run();
        expect(catchup.refusals.size()).to.equal(1);
        expect(logger.warn.calledWithMatch('later page failed')).to.equal(true);
    });
});
