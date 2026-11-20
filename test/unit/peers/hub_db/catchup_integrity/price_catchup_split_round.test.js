'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const sinon = require('sinon');
const { expect } = require('chai');
const { setup, producerRows, walkOf, storedPairs, withId } = require('../helpers/price_round_fixtures.js');
const { HUB_SCHEMA_VERSION } = require('../../../../../src/hub_schema_version.js');
const { processRoundGroup, settlePooledRounds } = require('../../../../../src/peers/hub_db/price_round_walk.js');
const { verifyPriceSnapshot } = require('../../../../../src/oracle/price_aggregator/catchup_verifiers.js');

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

function capacityRows(env, forged) {
    const refused = producerRows(env, 5, 1, { forged: true });
    const [targetBtc, targetLtc] = producerRows(env, 7, 3, { forged });
    const middle = producerRows(env, 8, 4);
    return refused.concat([withId(targetBtc, 3)], middle, [withId(targetLtc, 6)]);
}

describe('price catch-up pool capacity for split producer rounds', function () {
    afterEach(function () { sinon.restore(); });

    it('reserves a bounded retry so a split round can join on the next walk', async function () {
        const env = setup();
        const { catchup, logger } = walkOf(env, capacityRows(env, false), 2, { maxPooledRounds: 1 });
        await catchup.run();
        expect(storedPairs(env.db)).to.not.include('7|BTC/USD');
        const capacityLine = logger.warn.getCalls().map(call => call.args[0])
            .find(line => String(line).includes('not joined: producer round pool is full'));
        expect(capacityLine).to.match(/: .+ \(not joined: producer round pool is full\)/);
        expect(logger.warn.calledWithMatch('2 capacity turn-away(s); 1 split round(s) queued')).to.equal(true);

        await catchup.run();
        expect(storedPairs(env.db)).to.include.members(['7|BTC/USD', '7|LTC/USD']);
    });

    it('does not reserve the same joined refusal again without a new row', async function () {
        const env = setup();
        const { catchup, logger } = walkOf(env, capacityRows(env, true), 2, { maxPooledRounds: 1 });
        await catchup.run();
        await catchup.run();
        expect(catchup.splitRetryRounds.get('price_snapshots').size).to.equal(0);

        logger.warn.resetHistory();
        await catchup.run();
        expect(storedPairs(env.db)).to.not.include('7|BTC/USD');
        expect(logger.warn.calledWithMatch('0 split round(s) queued')).to.equal(true);
    });
});

describe('price catch-up capacity tracking bounds for split producer rounds', function () {
    afterEach(function () { sinon.restore(); });

    it('does not memoize a joined row set that the walk byte cap prevented checking', async function () {
        const env = setup();
        const [targetBtc, targetLtc] = producerRows(env, 7, 1);
        const middle = producerRows(env, 8, 2);
        const rows = [withId(targetBtc, 1)].concat(middle, [withId(targetLtc, 4)]);
        const firstBytes = Buffer.byteLength(JSON.stringify(rows[0]));
        const { catchup, logger } = walkOf(env, rows, 2, { maxPooledBytesPerWalk: firstBytes + 1 });
        await catchup.run();
        expect(catchup.refusals.size()).to.equal(0);
        expect(logger.warn.calledWithMatch('not joined: producer round exceeded catch-up walk byte limit'))
            .to.equal(true);

        catchup.maxPooledBytesPerWalk = Number.MAX_SAFE_INTEGER;
        await catchup.run();
        expect(storedPairs(env.db)).to.include.members(['7|BTC/USD', '7|LTC/USD']);
    });

    it('keeps no row data for rounds turned away by pool capacity', async function () {
        const { catchup, walk } = stubWalk({ ok: false, reason: 'incomplete round', deferred: true }, 1);
        for (let index = 0; index < 64; index++) {
            const row = { id: index + 1, coin_pair: 'PAIR' + index, payload: 'x'.repeat(131072) };
            await processRoundGroup(catchup, walk, 'round-' + index, [row]);
        }
        const outsidePool = Object.assign({}, walk, { pool: null });
        const retained = JSON.stringify(outsidePool, (name, value) => {
            if (value instanceof Map || value instanceof Set) return Array.from(value);
            return typeof value === 'bigint' ? value.toString(16) : value;
        });
        expect(walk.capacityTurnedAway).to.equal(63);
        expect(Buffer.byteLength(retained)).to.be.below(64 * 1024);
    });

    it('does not queue a split retry for fragments refused outright', async function () {
        const { catchup, walk } = stubWalk({ ok: false, reason: 'bad signature' }, 0);
        await processRoundGroup(catchup, walk, 'round-7', [{ id: 3, coin_pair: 'BTC/USD' }]);
        await processRoundGroup(catchup, walk, 'round-7', [{ id: 6, coin_pair: 'LTC/USD' }]);
        await settlePooledRounds(catchup, walk);
        expect(walk.capacityTurnedAway || 0).to.equal(0);
        expect(catchup.splitRetryRounds.get('price_snapshots').size).to.equal(0);
    });
});

describe('price catch-up reserve retries for split producer rounds', function () {
    afterEach(function () { sinon.restore(); });

    it('reserves a retry again when a refused round is served with corrected content under the same ids', async function () {
        const env = setup();
        const rows = capacityRows(env, false);
        const original = rows[5];
        rows[5] = Object.assign({}, original, { price: '81' });
        const { catchup } = walkOf(env, rows, 2, { maxPooledRounds: 1 });
        for (let walk = 0; walk < 3; walk++) await catchup.run();
        expect(storedPairs(env.db)).to.not.include('7|BTC/USD');

        rows[5] = original;
        await catchup.run();
        await catchup.run();
        expect(storedPairs(env.db)).to.include.members(['7|BTC/USD', '7|LTC/USD']);
    });

    it('keeps a split round queued when its reserved joined check gets a retryable verdict', async function () {
        const env = setup();
        const { catchup } = walkOf(env, capacityRows(env, false), 2, { maxPooledRounds: 1 });
        let failJoined = false;
        catchup.getVerifier = () => async (row, context) => {
            const rows = context && context.priceRoundRows;
            if (failJoined && Array.isArray(rows) && rows.length === 2 && Number(rows[0].round_number) === 7) {
                failJoined = false;
                return { ok: false, reason: 'validator lookup failed', retry: true };
            }
            return verifyPriceSnapshot(row, context);
        };
        await catchup.run();
        failJoined = true;
        await catchup.run();
        expect(storedPairs(env.db)).to.not.include('7|BTC/USD');
        expect(catchup.splitRetryRounds.get('price_snapshots').size).to.equal(1);

        await catchup.run();
        expect(storedPairs(env.db)).to.include.members(['7|BTC/USD', '7|LTC/USD']);
    });

    it('settles a queued round whose joined check finds it not mirrored instead of queuing it again', async function () {
        const { catchup, walk } = stubWalk(null, 0);
        catchup.verifyWalkRow = async (owner, row, rows) => (rows.length === 2
            ? { ok: false, reason: 'price snapshot is not finalized', notMirrored: true }
            : { ok: false, reason: 'incomplete round', deferred: true });
        const rounds = [['round-6', splitFragments(1, 'PAIR', 2)]];
        expect((await stubPass(catchup, walk, rounds)).size).to.equal(1);
        expect((await stubPass(catchup, walk, rounds)).size).to.equal(0);
        expect((await stubPass(catchup, walk, rounds)).size).to.equal(0);
    });
});

describe('price catch-up reserve fairness for split producer rounds', function () {
    const deferred = { ok: false, reason: 'incomplete round', deferred: true };

    it('does not reserve a refused round of three fragments again on the walk after its joined check', async function () {
        const { catchup, walk } = stubWalk(deferred, 0);
        const rounds = [['round-9', splitFragments(1, 'PAIR', 3)]];
        expect((await stubPass(catchup, walk, rounds)).size).to.equal(1);
        expect((await stubPass(catchup, walk, rounds)).size).to.equal(0);
        expect((await stubPass(catchup, walk, rounds)).size).to.equal(0);
    });

    it('does not reserve a split round already refused whole while the pool had room', async function () {
        const { catchup, walk } = stubWalk(deferred, 1);
        const rounds = [['round-4', splitFragments(1, 'PAIR', 2)]];
        expect((await stubPass(catchup, walk, rounds)).size).to.equal(0);
        catchup.maxPooledRounds = 0;
        expect((await stubPass(catchup, walk, rounds)).size).to.equal(0);
    });

    it('does not queue a round served whole that the full pool turned away', async function () {
        const { catchup, walk } = stubWalk(deferred, 0);
        const rounds = [['round-3', [[{ id: 1, coin_pair: 'BTC/USD' }, { id: 2, coin_pair: 'LTC/USD' }]]]];
        expect((await stubPass(catchup, walk, rounds)).size).to.equal(0);
    });

    it('reaches a valid split round behind more refused split rounds than the reserve holds', async function () {
        const { catchup, stored } = starvationWalk(deferred);
        const rounds = starvationRounds(0);
        expect((await stubPass(catchup, catchup.walk, rounds)).size).to.equal(64);
        for (let pass = 0; pass < 8 && !stored.includes('GOOD'); pass++) await stubPass(catchup, catchup.walk, rounds);
        expect(stored).to.include('GOOD');
    });

    it('reaches a valid split round when peers serving it under their own ids alternate between walks', async function () {
        const { catchup, stored } = starvationWalk(deferred);
        const feeds = [starvationRounds(0), starvationRounds(5000)];
        for (let pass = 0; pass < 12 && !stored.includes('GOOD'); pass++) {
            await stubPass(catchup, catchup.walk, feeds[pass % 2]);
        }
        expect(stored).to.include('GOOD');
    });
});

// 200 refused split rounds ahead of one valid one; offset shifts every id and stamp, as another peer serves them.
function starvationRounds(offset) {
    const rounds = [];
    const stamp = rows => rows.map(([row]) => [Object.assign(row, { created_at: 'peer-' + offset })]);
    for (let index = 0; index < 200; index++) {
        rounds.push(['round-' + index, stamp(splitFragments(offset + index * 2 + 1, 'BAD', 2))]);
    }
    rounds.push(['round-good', stamp(splitFragments(offset + 1001, 'GOOD', 2))]);
    return rounds;
}

function starvationWalk(refusal) {
    const { catchup, walk } = stubWalk(null, 0);
    const stored = [];
    catchup.verifyWalkRow = async (owner, row, rows) => (rows.length === 2 && rows[0].coin_pair === 'GOOD'
        ? { ok: true } : refusal);
    catchup.storeRound = async (table, rows) => { stored.push(rows[0].coin_pair); };
    catchup.walk = walk;
    return { catchup, stored };
}

// One fragment per row, so with a full pool each fragment of the round is turned away on its own.
function splitFragments(firstId, pair, count) {
    return Array.from({ length: count }, (unused, index) => [{ id: firstId + index, coin_pair: pair }]);
}

async function stubPass(catchup, walk, rounds) {
    const fresh = Object.assign({}, walk);
    for (const [key, fragments] of rounds) {
        for (const fragment of fragments) await processRoundGroup(catchup, fresh, key, fragment);
    }
    await settlePooledRounds(catchup, fresh);
    return catchup.splitRetryRounds.get('price_snapshots');
}

function stubWalk(verdict, maxPooledRounds) {
    const catchup = {
        hasRow: async () => false,
        localRoundRows: async () => [],
        verifyWalkRow: async () => verdict,
        maxPooledRounds, maxPooledRowsPerRound: 256,
        maxPooledBytesPerRound: 2 * 1024 * 1024, maxPooledBytesPerWalk: 32 * 1024 * 1024,
        refusals: { keyForGroup: () => 'key', remember: () => {} },
        logger: { warn: () => {} }
    };
    const walk = { table: 'price_snapshots', peer: 'peer', refused: 0, knownRefused: 0, refusalLines: 0 };
    return { catchup, walk };
}
