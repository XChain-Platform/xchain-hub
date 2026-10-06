'use strict';
const sinon = require('sinon');
const { expect } = require('chai');
const { rememberCatchupHub } = require('../../../../src/peers/hub_db/catchup_context.js');
const { verifyCapabilitySnapshotRow } = require('../../../../src/oracle/price_aggregator/capability_catchup_verifier.js');
const { PEER, peerManager, makeCatchup, delayedPage } = require('./helpers/peer_catchup_harness.js');

const EMPTY_PAGE = { table: 'price_snapshots', rows: [] };

function rateLimited() {
    const err = new Error('Snapshot request returned HTTP 429');
    err.statusCode = 429;
    err.retryAfterMs = 60000;
    return err;
}

// A capability row whose signed snapshot the local indexer cannot serve.
function unreadableCapabilityCatchup() {
    const db = { name: 'stability-db' };
    const read = sinon.stub().resolves(null);
    rememberCatchupHub({ db, network: 'regtest', capabilitySnapshot: { getSnapshot: read, getWeightSnapshot: read } });
    const rows = [{ id: 1, snapshot_block: 1000, capability: 'price', signing_pubkey: 'bb'.repeat(32),
        source: '', amount: '5' }];
    const fetchPage = sinon.stub();
    fetchPage.onFirstCall().resolves({ table: 'capability_snapshots', rows: [] });
    fetchPage.resolves({ table: 'capability_snapshots', rows });
    return makeCatchup({
        db, tables: ['capability_snapshots'], pageSize: 1000, indexerReadIntervalMs: 0, fetchPage,
        getVerifier: () => verifyCapabilitySnapshotRow, hasRow: async () => false, storeRow: async () => {}
    });
}

describe('hub DB peer catch-up state stability', function () {
    afterEach(function () { sinon.restore(); });

    it('keeps a caught-up table caught up while a peer-connect walk runs', async function () {
        const clock = sinon.useFakeTimers();
        const pm = peerManager(true);
        const slow = delayedPage(60);
        const fetchPage = sinon.stub().callsFake((...args) => (fetchPage.callCount === 1 ? EMPTY_PAGE : slow(...args)));
        const catchup = makeCatchup({ peerManager: pm, fetchPage });
        catchup.start();
        await clock.tickAsync(0);
        expect(catchup.isCaughtUp()).to.equal(true);
        pm.emit('peer:connect', PEER);
        await clock.tickAsync(30);
        expect(catchup.runningPromise).to.not.equal(null);
        expect(catchup.isCaughtUp()).to.equal(true);
        await clock.tickAsync(100);
        catchup.stop();
        expect(fetchPage.callCount).to.equal(2);
        expect(catchup.isCaughtUp()).to.equal(true);
    });

    it('keeps a caught-up table caught up when every peer fails the re-walk', async function () {
        const fetchPage = sinon.stub();
        fetchPage.onFirstCall().resolves(EMPTY_PAGE);
        fetchPage.rejects(rateLimited());
        const catchup = makeCatchup({ fetchPage });
        await catchup.run();
        await catchup.run();
        expect(fetchPage.callCount).to.equal(2);
        expect(catchup.tableCaughtUp('price_snapshots')).to.equal(true);
        expect(catchup.isCaughtUp()).to.equal(true);
    });

    it('leaves a never-caught-up table behind when every peer fails', async function () {
        const catchup = makeCatchup({ fetchPage: sinon.stub().rejects(rateLimited()) });
        await catchup.run();
        expect(catchup.lastUsablePeerCount).to.equal(1);
        expect(catchup.tableCaughtUp('price_snapshots')).to.equal(false);
        expect(catchup.isCaughtUp()).to.equal(false);
    });

    it('marks a table behind when its walk hits a failed indexer read', async function () {
        const catchup = unreadableCapabilityCatchup();
        await catchup.run();
        expect(catchup.tableCaughtUp('capability_snapshots')).to.equal(true);
        await catchup.run();
        expect(catchup.tableCaughtUp('capability_snapshots')).to.equal(false);
        expect(catchup.isCaughtUp()).to.equal(false);
    });
});
