'use strict';

const EventEmitter = require('events');
const sinon = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');
const HubDbPeerCatchup = require('../../../../src/peers/hub_db/peer_catchup.js');

const PEER = 'ws://validator02.example:10002';

function peerManager(connected) {
    const pm = new EventEmitter();
    pm.peers = new Map();
    pm.validatorPubkeys = new Map([[PEER, 'aa'.repeat(32)]]);
    pm.effectiveSignerSet = new Set(['aa'.repeat(32)]);
    if (connected) pm.peers.set(PEER, { state: 'open' });
    return pm;
}

function makeCatchup(overrides) {
    const opts = overrides || {};
    return new HubDbPeerCatchup({
        db: opts.db || { doQuery: sinon.stub().resolves({ affectedRows: 1 }) },
        peerManager: opts.peerManager || peerManager(true),
        tables: opts.tables || ['price_snapshots'],
        getVerifier: opts.getVerifier || (() => async () => true),
        fetchPage: opts.fetchPage,
        pageSize: opts.pageSize || 2,
        warnIntervalMs: 60000,
        logger: opts.logger || { warn: sinon.stub(), error: sinon.stub() }
    });
}

describe('hub DB peer catch-up', function () {
    afterEach(function () { sinon.restore(); });

    it('pages to the end, assigns local ids, and flips the table caught up', async function () {
        const db = { doQuery: sinon.stub().resolves({ affectedRows: 1 }) };
        const fetchPage = sinon.stub();
        fetchPage.onFirstCall().resolves({
            table: 'price_snapshots',
            rows: [{ id: 41, round_number: 7 }, { id: 44, round_number: 8 }]
        });
        fetchPage.onSecondCall().resolves({ table: 'price_snapshots', rows: [] });
        const catchup = makeCatchup({ db, fetchPage });

        await catchup.start();
        catchup.stop();

        expect(fetchPage.firstCall.args.slice(0, 4)).to.deep.equal([PEER, 'price_snapshots', 0, 2]);
        expect(fetchPage.secondCall.args[2]).to.equal(44);
        expect(db.doQuery.callCount).to.equal(2);
        expect(db.doQuery.firstCall.args[0]).to.not.include('(id,');
        expect(db.doQuery.firstCall.args[0]).to.include('ON DUPLICATE KEY UPDATE id = id');
        expect(catchup.tableCaughtUp('price_snapshots')).to.equal(true);
    });

    it('skips a row already held by its content unique key', async function () {
        const db = { doQuery: sinon.stub().resolves({ affectedRows: 0 }) };
        const catchup = makeCatchup({
            db,
            fetchPage: sinon.stub().resolves({
                table: 'price_snapshots', rows: [{ id: 9, round_number: 3, coin_pair: 'BTC/USD' }]
            })
        });

        await catchup.start();
        catchup.stop();

        expect(db.doQuery.calledOnce).to.equal(true);
        expect(db.doQuery.firstCall.args[1]).to.deep.equal([3, 'BTC/USD']);
        expect(catchup.tableCaughtUp('price_snapshots')).to.equal(true);
    });

    it('logs a verifier refusal and does not insert the row', async function () {
        const logger = { warn: sinon.stub(), error: sinon.stub() };
        const db = { doQuery: sinon.stub().resolves({ affectedRows: 1 }) };
        const catchup = makeCatchup({
            db,
            logger,
            getVerifier: () => async () => ({ ok: false, reason: 'bad quorum' }),
            fetchPage: sinon.stub().resolves({
                table: 'price_snapshots', rows: [{ id: 12, round_number: 4 }]
            })
        });

        await catchup.start();
        catchup.stop();

        expect(db.doQuery.called).to.equal(false);
        expect(logger.warn.calledWithMatch('bad quorum')).to.equal(true);
        expect(catchup.tableCaughtUp('price_snapshots')).to.equal(true);
    });

    it('leaves every table not caught up and logs when no signer peer is reachable', async function () {
        const logger = { warn: sinon.stub(), error: sinon.stub() };
        const fetchPage = sinon.stub();
        const catchup = makeCatchup({
            peerManager: peerManager(false),
            tables: ['price_snapshots', 'oracle_prices'],
            logger,
            fetchPage
        });

        await catchup.start();
        catchup.warnIfNoPeer();
        catchup.stop();

        expect(fetchPage.called).to.equal(false);
        expect(catchup.caughtUpState()).to.deep.equal({ price_snapshots: false, oracle_prices: false });
        expect(logger.warn.calledWithMatch('no connected signer-set peer')).to.equal(true);
        expect(logger.warn.callCount).to.equal(1);
    });

    it('does not fetch from a connected peer outside the effective signer set', async function () {
        const pm = peerManager(true);
        pm.effectiveSignerSet = new Set(['bb'.repeat(32)]);
        const fetchPage = sinon.stub();
        const catchup = makeCatchup({ peerManager: pm, fetchPage });

        await catchup.start();
        catchup.stop();

        expect(fetchPage.called).to.equal(false);
        expect(catchup.tableCaughtUp('price_snapshots')).to.equal(false);
    });

    it('skips an unregistered table and leaves it not caught up', async function () {
        const fetchPage = sinon.stub();
        const catchup = makeCatchup({ getVerifier: () => undefined, fetchPage });

        await catchup.start();
        catchup.stop();

        expect(fetchPage.called).to.equal(false);
        expect(catchup.tableCaughtUp('price_snapshots')).to.equal(false);
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

        expect(sampler.attachAdmissionSource({ peerManager: pm })).to.equal(true);
        await Promise.resolve();

        expect(start.calledOnce).to.equal(true);
        expect(options.db).to.equal(db);
        expect(options.peerManager).to.equal(pm);
    });
});
