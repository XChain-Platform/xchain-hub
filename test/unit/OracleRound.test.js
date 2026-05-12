'use strict';

const sinon          = require('sinon');
const { expect }     = require('chai');
const proxyquire     = require('proxyquire');
const { createMockHub }     = require('../helpers/mockHub');
const { buildSubmissions }  = require('../helpers/fixtures');

describe('OracleRound', function () {

    let hub, pm, or, mockPriceFetcher, OracleRound;

    beforeEach(function () {
        // Stub PriceFetcher to avoid real HTTP
        mockPriceFetcher = {
            fetchPrices: sinon.stub().resolves([
                { coinPair: 'BTC/USD', price: '100000.00000000', sources: 2 }
            ])
        };

        OracleRound = proxyquire('../../src/OracleRound', {
            './PriceFetcher': function () { return mockPriceFetcher; }
        });

        hub = createMockHub({
            p2pConfig: {
                ORACLE_ROUND_INTERVAL:   '60000',
                ORACLE_SUBMISSION_WINDOW: '30000'
            }
        });
        pm = hub._peerManager;
        or = new OracleRound(hub);
    });

    afterEach(function () {
        sinon.restore();
    });

    // -----------------------------------------------------------------
    // Configuration
    // -----------------------------------------------------------------

    describe('configuration', function () {
        it('reads round interval from config', function () {
            // Config values are strings; OracleRound may or may not parse
            expect(Number(or.roundInterval)).to.equal(60000);
        });

        it('reads submission window from config', function () {
            expect(Number(or.submissionWindow)).to.equal(30000);
        });

        it('uses defaults when config is empty', function () {
            let or2 = new OracleRound(createMockHub({ p2pConfig: {} }));
            expect(or2.roundInterval).to.equal(600000);
            expect(or2.submissionWindow).to.equal(180000);
        });
    });

    // -----------------------------------------------------------------
    // _executeRound()
    // -----------------------------------------------------------------

    describe('_executeRound()', function () {

        it('fetches prices and broadcasts ORACLE_PRICE_SUBMIT', async function () {
            await or._executeRound();

            expect(mockPriceFetcher.fetchPrices.calledOnce).to.be.true;
            expect(pm.broadcast.calledOnce).to.be.true;
            let [type, data] = pm.broadcast.getCall(0).args;
            expect(type).to.equal('ORACLE_PRICE_SUBMIT');
            expect(data.prices).to.deep.equal([
                { coinPair: 'BTC/USD', price: '100000.00000000', sources: 2 }
            ]);
        });

        it('records own submission in local map', async function () {
            await or._executeRound();

            let round = or.getCurrentRound();
            let subs = or.getSubmissions(round);
            expect(subs).to.be.an.instanceOf(Map);
            expect(subs.has(pm.validatorAddr)).to.be.true;
        });

        it('skips round when price fetch returns empty', async function () {
            mockPriceFetcher.fetchPrices.resolves([]);
            await or._executeRound();

            expect(pm.broadcast.called).to.be.false;
        });

        it('skips round when price fetch throws', async function () {
            mockPriceFetcher.fetchPrices.rejects(new Error('API down'));
            await or._executeRound();

            expect(pm.broadcast.called).to.be.false;
        });
    });

    // -----------------------------------------------------------------
    // Peer submission handling
    // -----------------------------------------------------------------

    describe('peer submission handling', function () {

        it('records peer submission for current round', async function () {
            await or._executeRound(); // sets currentRound
            let round = or.getCurrentRound();

            or._handleMessage({
                type:   'ORACLE_PRICE_SUBMIT',
                sender: 'ws://peer-1:10001',
                data: {
                    round:  round,
                    prices: [{ coinPair: 'BTC/USD', price: '100001', sources: 1 }],
                    sources: 1,
                    timestamp: Date.now()
                }
            });

            let subs = or.getSubmissions(round);
            expect(subs.has('ws://peer-1:10001')).to.be.true;
        });

        it('first submission wins (duplicate sender ignored)', async function () {
            await or._executeRound();
            let round = or.getCurrentRound();

            or._handleMessage({
                type: 'ORACLE_PRICE_SUBMIT', sender: 'ws://peer-1:10001',
                data: { round, prices: [{ coinPair: 'BTC/USD', price: '111' }], sources: 1, timestamp: Date.now() }
            });
            or._handleMessage({
                type: 'ORACLE_PRICE_SUBMIT', sender: 'ws://peer-1:10001',
                data: { round, prices: [{ coinPair: 'BTC/USD', price: '222' }], sources: 1, timestamp: Date.now() }
            });

            let subs = or.getSubmissions(round);
            let sub = subs.get('ws://peer-1:10001');
            expect(sub.prices[0].price).to.equal('111'); // first wins
        });

        it('ignores non-ORACLE_PRICE_SUBMIT messages', function () {
            or._handleMessage({ type: 'HEARTBEAT', sender: 'x', data: {} });
            expect(or.getSubmissions(0)).to.be.undefined;
        });
    });

    // -----------------------------------------------------------------
    // getSubmissionsInfo()
    // -----------------------------------------------------------------

    describe('getSubmissionsInfo()', function () {
        it('returns info object', async function () {
            await or._executeRound();
            let info = or.getSubmissionsInfo();
            expect(info).to.have.property('currentRound');
            expect(info).to.have.property('roundInterval');
            expect(info).to.have.property('submissionWindow');
        });
    });
});
