'use strict';
const sinon = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');
const PeerManager = require('../../../../src/peers/manager.js');
const { PEER, VALIDATOR_ADDR, SIGNING_PUBKEY, peerManager, makeCatchup } = require('./helpers/peer_catchup_harness.js');
afterEach(function () { sinon.restore(); });
describe('hub DB peer catch-up without a peer registry', function () {
    it('fetches from a chain signer', async function () {
        const pm = peerManager(true);
        delete pm.registryHasPubkey;
        const fetchPage = sinon.stub().resolves({ table: 'price_snapshots', rows: [] });
        const catchup = makeCatchup({ peerManager: pm, fetchPage });
        await catchup.start();
        catchup.stop();
        expect(fetchPage.calledOnceWithExactly(PEER, 'price_snapshots', 0, 2)).to.equal(true);
        expect(catchup.tableCaughtUp('price_snapshots')).to.equal(true);
    });
});
describe('hub DB peer catch-up lifecycle', function () {
    it('is registered in the peer manager listener roster', function () {
        expect(PeerManager.LISTENER_ROSTER).to.deep.include({
            event: 'peer:connect', subscriber: 'HubDbPeerCatchup'
        });
    });
    it('runs again when a peer link reconnects', async function () {
        const pm = peerManager(true);
        const fetchPage = sinon.stub().resolves({ table: 'price_snapshots', rows: [] });
        const catchup = makeCatchup({ peerManager: pm, fetchPage });
        await catchup.start();
        pm.emit('peer:connect', PEER);
        await catchup.runningPromise;
        catchup.stop();
        expect(fetchPage.callCount).to.equal(2);
    });
    it('attaches at hub startup through the admission source hook', async function () {
        let options;
        const start = sinon.stub().resolves();
        function CatchupStub(opts) {
            options = opts;
            this.start = start;
        }
        const HubDbAdmissionSampling = proxyquire('../../../../src/peers/hub_db/admission_sampling.js', {
            './peer_catchup.js': CatchupStub
        });
        const sampler = new HubDbAdmissionSampling();
        const db = { doQuery: sinon.stub() };
        const pm = peerManager(false);
        sampler.db = db;
        sampler.admissionSampleMs = 60000;
        const hub = { peerManager: pm };
        expect(sampler.attachAdmissionSource(hub)).to.equal(true);
        await Promise.resolve();
        expect(start.calledOnce).to.equal(true);
        expect(options.db).to.equal(db);
        expect(options.peerManager).to.equal(pm);
        expect(hub.peerCatchup).to.be.instanceOf(CatchupStub);
    });
});
describe('hub DB peer catch-up retry lifecycle', function () {
    it('retries after a connected peer is registered and clears its timer on stop', async function () {
        const clock = sinon.useFakeTimers();
        const pm = peerManager(true);
        pm.validatorPubkeys.clear();
        pm.effectiveSignerSet = new Set();
        const fetchPage = sinon.stub().resolves({ table: 'price_snapshots', rows: [] });
        const catchup = makeCatchup({ peerManager: pm, fetchPage, retryIntervalMs: 25 });
        await catchup.start();
        expect(fetchPage.called).to.equal(false);
        pm.validatorPubkeys.set(VALIDATOR_ADDR, SIGNING_PUBKEY);
        await clock.tickAsync(25);
        expect(fetchPage.calledOnceWithExactly(PEER, 'price_snapshots', 0, 2)).to.equal(true);
        expect(catchup.isCaughtUp()).to.equal(true);
        catchup.stop();
        expect(clock.countTimers()).to.equal(0);
    });
});
