'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const sinon = require('sinon');
const { expect } = require('chai');
const { setup, producerRows, walkOf, storedPairs, withId } = require('../helpers/price_round_fixtures.js');

// A split round the full pool turned away is joined on the NEXT walk through a reserved slot. Nothing
// but the retry timer starts that walk, and the timer only walks a table that is behind.

function capacityRows(env, forged) {
    const refused = producerRows(env, 5, 1, { forged: true });
    const [targetBtc, targetLtc] = producerRows(env, 7, 3, { forged });
    const middle = producerRows(env, 8, 4);
    return refused.concat([withId(targetBtc, 3)], middle, [withId(targetLtc, 6)]);
}

function byteCappedRows(env) {
    const [targetBtc, targetLtc] = producerRows(env, 7, 1);
    const rows = [withId(targetBtc, 1)].concat(producerRows(env, 8, 2), [withId(targetLtc, 4)]);
    return { rows, cap: Buffer.byteLength(JSON.stringify(rows[0])) + 1 };
}

describe('price catch-up retry walks for queued split producer rounds', function () {
    let clock = null;
    afterEach(function () {
        if (clock) { clock.restore(); clock = null; }
        sinon.restore();
    });

    it('joins a queued split round through the retry timer with no manual walk', async function () {
        clock = sinon.useFakeTimers({ now: Date.now() });
        const env = setup();
        const { catchup } = walkOf(env, capacityRows(env, false), 2, { maxPooledRounds: 1, retryIntervalMs: 1000 });
        try {
            await catchup.start();
            expect(storedPairs(env.db)).to.not.include('7|BTC/USD');
            expect(catchup.splitRetryRounds.get('price_snapshots').size).to.equal(1);
            expect(catchup.tableCaughtUp('price_snapshots'), 'a queued split round keeps it behind').to.equal(false);
            await clock.tickAsync(1000);
            if (catchup.runningPromise) await catchup.runningPromise;
            expect(storedPairs(env.db)).to.include.members(['7|BTC/USD', '7|LTC/USD']);
            expect(catchup.tableCaughtUp('price_snapshots')).to.equal(true);
        } finally {
            catchup.stop();
        }
    });

    it('ends caught up once a queued split round is refused on its retry walk', async function () {
        const env = setup();
        const { catchup } = walkOf(env, capacityRows(env, true), 2, { maxPooledRounds: 1 });
        await catchup.run();
        expect(catchup.tableCaughtUp('price_snapshots')).to.equal(false);
        await catchup.run();
        expect(catchup.splitRetryRounds.get('price_snapshots').size).to.equal(0);
        expect(catchup.tableCaughtUp('price_snapshots')).to.equal(true);
    });

    it('holds the table behind for one retry walk only when the byte cap keeps turning a round away', async function () {
        const env = setup();
        const { rows, cap } = byteCappedRows(env);
        const { catchup } = walkOf(env, rows, 2, { maxPooledBytesPerWalk: cap });
        await catchup.run();
        expect(catchup.splitRetryRounds.get('price_snapshots').size).to.equal(1);
        expect(catchup.tableCaughtUp('price_snapshots')).to.equal(false);
        await catchup.run();
        expect(catchup.splitRetryRounds.get('price_snapshots').size, 'still queued for the reserve').to.equal(1);
        expect(catchup.tableCaughtUp('price_snapshots'), 'but no longer pinning the table behind').to.equal(true);
    });
});

describe('price catch-up hold bound for a peer serving a fresh split round every walk', function () {
    afterEach(function () { sinon.restore(); });

    it('stops holding the table behind after a bounded run of walks that each queue a fresh split round', async function () {
        const env = setup();
        const rows = [];
        const { catchup } = walkOf(env, rows, 2, { maxPooledRounds: 1 });
        const behind = [];
        for (let walk = 0; walk < 5; walk++) {
            const base = 100 * (walk + 1);
            const [targetBtc, targetLtc] = producerRows(env, 1000 + walk, base + 3, { forged: true });
            rows.splice(0, rows.length, ...producerRows(env, 5, base + 1, { forged: true }), withId(targetBtc, base + 3),
                ...producerRows(env, 2000 + walk, base + 4), withId(targetLtc, base + 6));
            await catchup.run();
            behind.push(!catchup.tableCaughtUp('price_snapshots'));
        }
        expect(behind).to.deep.equal([true, true, true, false, false]);
        rows.splice(0, rows.length);
        await catchup.run();
        expect(catchup.splitRetryHolds.get('price_snapshots'), 'a walk queuing nothing new ends the run').to.equal(0);
        expect(catchup.tableCaughtUp('price_snapshots')).to.equal(true);
    });
});
