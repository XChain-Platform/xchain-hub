'use strict';
const http = require('http');
const sinon = require('sinon');
const { expect } = require('chai');
const HubDbPeerCatchup = require('../../../../src/peers/hub_db/peer_catchup.js');
const { PEER, peerManager, priceDb, makeCatchup } = require('./helpers/peer_catchup_harness.js');

const OTHER_PEER = 'ws://validator03.example:10002';
const OTHER_PUBKEY = 'cc'.repeat(32);

function twoPeerManager() {
    const pm = peerManager(true);
    pm.validatorPubkeys.set('rValidator03', OTHER_PUBKEY);
    pm.effectiveSignerSet.add(OTHER_PUBKEY);
    pm.peers.set(OTHER_PEER, { state: 'open', inbound: false, feedUrl: OTHER_PEER, validatorAddr: 'rValidator03' });
    return pm;
}

function rateLimited(retryAfterMs) {
    const err = new Error('Snapshot request returned HTTP 429');
    err.statusCode = 429;
    err.retryAfterMs = retryAfterMs;
    return err;
}

function callsTo(fetchPage, peer) {
    return fetchPage.getCalls().filter(call => call.args[0] === peer).length;
}

const EMPTY_PAGE = { table: 'price_snapshots', rows: [] };

function registerRequestTests() {
    it('walks a table in pages of 10000 rows by default', async function () {
        const fetchPage = sinon.stub().resolves(EMPTY_PAGE);
        const catchup = new HubDbPeerCatchup({
            db: priceDb(), peerManager: peerManager(true), tables: ['price_snapshots'],
            getVerifier: () => async () => true, fetchPage,
            logger: { warn: sinon.stub(), error: sinon.stub() }
        });
        await catchup.run();
        expect(fetchPage.firstCall.args[3]).to.equal(10000);
        expect(HubDbPeerCatchup.DEFAULT_PAGE_SIZE).to.equal(10000);
    });

    it('carries the status and Retry-After of a refused snapshot request', async function () {
        const server = http.createServer((req, res) => {
            res.writeHead(429, { 'Retry-After': '7', 'Content-Type': 'application/json' });
            res.end('{"error":"rate limited"}');
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            const url = new URL('http://127.0.0.1:' + server.address().port + '/hub-db/snapshot/price_snapshots');
            const err = await HubDbPeerCatchup.requestJson(url, '', 5000).then(() => null, e => e);
            expect(err).to.be.instanceOf(Error);
            expect(err.message).to.equal('Snapshot request returned HTTP 429');
            expect(err.statusCode).to.equal(429);
            expect(err.retryAfterMs).to.equal(7000);
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });
}

function registerBackoffTests() {
    it('backs off a peer that answered 429 until its Retry-After passes', async function () {
        const clock = sinon.useFakeTimers();
        const fetchPage = sinon.stub().callsFake(async (peer) => {
            if (peer === PEER) throw rateLimited(60000);
            throw new Error('down');
        });
        const catchup = makeCatchup({ peerManager: twoPeerManager(), fetchPage, retryIntervalMs: 5000 });
        catchup.start();
        await clock.tickAsync(59000);
        expect(callsTo(fetchPage, PEER)).to.equal(1);
        expect(callsTo(fetchPage, OTHER_PEER)).to.be.above(1);
        await clock.tickAsync(2000);
        catchup.stop();
        expect(callsTo(fetchPage, PEER)).to.equal(2);
    });

    it('walks the next peer while one is backed off', async function () {
        const fetchPage = sinon.stub().callsFake(async (peer) => {
            if (peer === PEER) throw rateLimited(60000);
            return EMPTY_PAGE;
        });
        const catchup = makeCatchup({ peerManager: twoPeerManager(), fetchPage });
        await catchup.run();
        expect(catchup.tableCaughtUp('price_snapshots')).to.equal(true);
        await catchup.run();
        expect(callsTo(fetchPage, PEER)).to.equal(1);
        expect(callsTo(fetchPage, OTHER_PEER)).to.equal(2);
        expect(catchup.feedBackoff.isBackedOff(PEER)).to.equal(true);
    });

    it('clears a peer backoff once a walk completes', async function () {
        const clock = sinon.useFakeTimers();
        const fetchPage = sinon.stub();
        fetchPage.onFirstCall().rejects(new Error('down'));
        fetchPage.resolves(EMPTY_PAGE);
        const catchup = makeCatchup({ fetchPage, retryIntervalMs: 5000 });
        catchup.start();
        await clock.tickAsync(0);
        expect(catchup.feedBackoff.isBackedOff(PEER)).to.equal(true);
        await clock.tickAsync(5000);
        catchup.stop();
        expect(fetchPage.callCount).to.equal(2);
        expect(catchup.tableCaughtUp('price_snapshots')).to.equal(true);
        expect(catchup.feedBackoff.isBackedOff(PEER)).to.equal(false);
        await catchup.run();
        expect(fetchPage.callCount).to.equal(3);
    });
}

describe('hub DB peer catch-up feed backoff', function () {
    afterEach(function () { sinon.restore(); });
    registerRequestTests();
    registerBackoffTests();
});
