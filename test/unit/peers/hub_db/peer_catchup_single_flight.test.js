'use strict';
const sinon = require('sinon');
const { expect } = require('chai');
const { rememberCatchupHub } = require('../../../../src/peers/hub_db/catchup_context.js');
const { verifyCapabilitySnapshotRow } = require('../../../../src/oracle/price_aggregator/capability_catchup_verifier.js');
const { makeCatchup } = require('./helpers/peer_catchup_harness.js');

const CAPABILITY = 'price';
const PUBKEY = 'bb'.repeat(32);

function capabilityRows(count, blocks) {
    return Array.from({ length: count }, (_, i) => ({
        id: i + 1, snapshot_block: 1000 + (i % blocks), capability: CAPABILITY,
        signing_pubkey: PUBKEY, source: '', amount: '5'
    }));
}

function capabilityHarness(rows, snapshot, held) {
    const db = { name: 'catchup-db' };
    const read = sinon.stub().callsFake(async () => snapshot);
    rememberCatchupHub({ db, network: 'regtest', capabilitySnapshot: { getSnapshot: read, getWeightSnapshot: read } });
    const catchup = makeCatchup({
        db, tables: ['capability_snapshots'], pageSize: 1000, indexerReadIntervalMs: 0,
        getVerifier: () => verifyCapabilitySnapshotRow,
        hasRow: async () => held === true,
        storeRow: async () => {},
        fetchPage: async () => ({ table: 'capability_snapshots', rows })
    });
    return { catchup, read };
}

function slowPage() {
    return sinon.stub().callsFake(() => new Promise(resolve => setTimeout(
        () => resolve({ table: 'price_snapshots', rows: [] }), 60)));
}

describe('hub DB peer catch-up single flight', function () {
    afterEach(function () { sinon.restore(); });

    it('starts no second walk when the retry timer fires during a walk', async function () {
        const clock = sinon.useFakeTimers();
        const fetchPage = slowPage();
        const catchup = makeCatchup({ fetchPage, retryIntervalMs: 25 });
        catchup.state.markBehind('price_snapshots');
        const first = catchup.start();
        await clock.tickAsync(200);
        await first;
        catchup.stop();
        expect(catchup.runningPromise).to.equal(null);
        expect(fetchPage.callCount).to.equal(1);
    });

    it('does not re-walk a caught-up hub on the retry timer', async function () {
        const clock = sinon.useFakeTimers();
        const fetchPage = slowPage();
        const catchup = makeCatchup({ fetchPage, retryIntervalMs: 25 });
        catchup.start();
        await clock.tickAsync(2000);
        catchup.stop();
        expect(fetchPage.callCount).to.equal(1);
        expect(catchup.allCaughtUp()).to.equal(true);
    });

    it('reads the indexer at most once per snapshot block in a walk', async function () {
        const snapshot = { validators: [{ pubkey: PUBKEY, amount: '5' }] };
        const { catchup, read } = capabilityHarness(capabilityRows(400, 4), snapshot);
        await catchup.run();
        expect(read.callCount).to.be.at.most(4);
        expect(catchup.tableCaughtUp('capability_snapshots')).to.equal(true);
    });

    it('does not re-read a failed snapshot block for every row and leaves the table behind', async function () {
        const { catchup, read } = capabilityHarness(capabilityRows(400, 4), null);
        await catchup.run();
        expect(read.callCount).to.be.at.most(4);
        expect(catchup.tableCaughtUp('capability_snapshots')).to.equal(false);
    });

    it('reads the indexer for no row the hub already holds', async function () {
        const { catchup, read } = capabilityHarness(capabilityRows(400, 4), null, true);
        await catchup.run();
        expect(read.callCount).to.equal(0);
        expect(catchup.tableCaughtUp('capability_snapshots')).to.equal(true);
    });

    it('backs the retry spacing off while a table stays behind', async function () {
        const clock = sinon.useFakeTimers();
        const fetchPage = sinon.stub().rejects(new Error('down'));
        const catchup = makeCatchup({ fetchPage, retryIntervalMs: 25, maxRetryIntervalMs: 100 });
        catchup.start();
        await clock.tickAsync(1000);
        catchup.stop();
        expect(fetchPage.callCount).to.be.within(5, 14);
    });
});
