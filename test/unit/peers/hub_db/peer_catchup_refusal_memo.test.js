'use strict';
const sinon = require('sinon');
const { expect } = require('chai');
const { rememberCatchupHub } = require('../../../../src/peers/hub_db/catchup_context.js');
const { createRefusalMemo } = require('../../../../src/peers/hub_db/refusal_memo.js');
const { PEER, makeCatchup } = require('./helpers/peer_catchup_harness.js');

const SKIPPED = [
    { id: 11, round_number: 5, coin_pair: 'BTC/USD', status: 'skipped' },
    { id: 12, round_number: 6, coin_pair: 'BTC/USD', status: 'skipped' }
];

// Serves the given rows on the first page of every walk, then an empty page.
function servingRows(rowsForWalk) {
    let walk = 0;
    return sinon.stub().callsFake(async (peer, table, cursor) => {
        if (cursor !== 0) return { table, rows: [] };
        walk += 1;
        return { table, rows: rowsForWalk(walk) };
    });
}

function refusingVerifier() {
    return sinon.stub().resolves({ ok: false, reason: 'price snapshot is not finalized' });
}

function memoCatchup(verifier, fetchPage, extra) {
    const logger = { warn: sinon.stub(), error: sinon.stub() };
    const catchup = makeCatchup(Object.assign({ getVerifier: () => verifier, fetchPage, logger,
        hasRow: async () => false, storeRow: sinon.stub().resolves() }, extra));
    return { catchup, logger };
}

function warnLines(logger, text) {
    return logger.warn.getCalls().map(call => String(call.args[0])).filter(line => line.includes(text));
}

describe('hub DB peer catch-up refusal memo', function () {
    afterEach(function () { sinon.restore(); });

    it('does not re-verify a row refused for a local reason on the next walk', async function () {
        const verifier = refusingVerifier();
        const { catchup } = memoCatchup(verifier, servingRows(() => SKIPPED));
        await catchup.run();
        await catchup.run();
        expect(verifier.callCount).to.equal(2);
        expect(catchup.tableCaughtUp('price_snapshots')).to.equal(true);
    });

    it('verifies a remembered row again once its content changes', async function () {
        const verifier = refusingVerifier();
        const finalized = Object.assign({}, SKIPPED[0], { status: 'finalized', price: '1' });
        const { catchup } = memoCatchup(verifier, servingRows(walk => (walk === 1 ? SKIPPED : [finalized, SKIPPED[1]])));
        await catchup.run();
        await catchup.run();
        expect(verifier.callCount).to.equal(3);
        expect(verifier.lastCall.args[0]).to.include({ id: 11, status: 'finalized' });
    });

    it('does not remember a row refused after a failed indexer read', async function () {
        const db = { name: 'refusal-memo-db' };
        const read = sinon.stub().resolves(null);
        rememberCatchupHub({ db, network: 'regtest', capabilitySnapshot: { getSnapshot: read, getWeightSnapshot: read } });
        const verifier = sinon.stub().callsFake(async (row, context) => {
            await context.readCapabilitySnapshot('getSnapshot', 'price', 1000);
            return { ok: false, reason: 'local capability snapshot unavailable' };
        });
        const { catchup } = memoCatchup(verifier, servingRows(() => SKIPPED.slice(0, 1)), { db, indexerReadIntervalMs: 0 });
        await catchup.run();
        await catchup.run();
        expect(verifier.callCount).to.equal(2);
        expect(catchup.refusals.size()).to.equal(0);
        expect(catchup.tableCaughtUp('price_snapshots')).to.equal(false);
    });

    it('logs one summary line per walk for rows already refused', async function () {
        const { catchup, logger } = memoCatchup(refusingVerifier(), servingRows(() => SKIPPED));
        await catchup.run();
        await catchup.run();
        expect(warnLines(logger, 'verifier refused')).to.have.length(2);
        const summaries = warnLines(logger, 'price_snapshots row(s) from ' + PEER + ' refused');
        expect(summaries).to.deep.equal([
            'Hub DB peer catch-up: 2 price_snapshots row(s) from ' + PEER + ' refused (0 already known)',
            'Hub DB peer catch-up: 2 price_snapshots row(s) from ' + PEER + ' refused (2 already known)'
        ]);
    });

    it('evicts the oldest refusal once the memo is full', function () {
        const memo = createRefusalMemo({ maxEntries: 2 });
        const keys = SKIPPED.concat([{ id: 13, status: 'skipped' }]).map(row => memo.keyFor('peer', 'price_snapshots', row));
        keys.forEach(key => memo.remember(key));
        expect(memo.size()).to.equal(2);
        expect(memo.has(keys[0])).to.equal(false);
        expect(memo.has(keys[2])).to.equal(true);
    });
});
