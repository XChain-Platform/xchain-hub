'use strict';

const crypto           = require('crypto');
const sinon            = require('sinon');
const { expect }       = require('chai');
const OracleConsensus  = require('../../src/OracleConsensus');
const { createMockHub }       = require('../helpers/mockHub');
const { VALIDATORS_3, VALIDATORS_4, VALIDATORS_7, VALIDATORS_10, VALIDATORS_13,
        buildSubmissions, buildUniformSubmissions, SAMPLE_PRICES } = require('../helpers/fixtures');

describe('OracleConsensus', function () {

    let hub, pm, oc, oracleRound;

    beforeEach(function () {
        hub = createMockHub();
        pm  = hub._peerManager;
        oracleRound = {
            getSubmissions: sinon.stub().returns(new Map())
        };
        oc = new OracleConsensus(hub, oracleRound);
    });

    afterEach(function () {
        sinon.restore();
    });

    // -----------------------------------------------------------------
    // _aggregate() — trimmed median
    // -----------------------------------------------------------------

    describe('_aggregate() — trimmed median', function () {

        function submissionsForPair(prices) {
            let entries = prices.map((p, i) => ({
                sender: 'validator-' + i,
                prices: [{ coinPair: 'BTC/USD', price: String(p) }]
            }));
            return buildSubmissions(entries);
        }

        it('single submission — returns that value', function () {
            let subs = submissionsForPair([100000]);
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('100000.00000000');
        });

        it('two submissions — returns average (median of 2)', function () {
            let subs = submissionsForPair([100000, 100002]);
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('100001.00000000');
        });

        it('three submissions — returns middle value', function () {
            let subs = submissionsForPair([100000, 100010, 100005]);
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('100005.00000000');
        });

        it('all identical values — returns that value', function () {
            let subs = submissionsForPair([50000, 50000, 50000, 50000, 50000]);
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('50000.00000000');
        });

        it('7 submissions — trims top and bottom 15% (1 each)', function () {
            // 7 * 0.15 = 1.05, floor = 1 → trim 1 from each end
            let prices = [90000, 99000, 100000, 100100, 100200, 101000, 110000];
            let subs = submissionsForPair(prices);
            // After trim: [99000, 100000, 100100, 100200, 101000] → median = 100100
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('100100.00000000');
        });

        it('10 submissions — trims 1 from each end', function () {
            // 10 * 0.15 = 1.5, floor = 1
            let prices = [1, 100, 101, 102, 103, 104, 105, 106, 107, 999];
            let subs = submissionsForPair(prices);
            // After trim: [100, 101, 102, 103, 104, 105, 106, 107] → median = (103+104)/2 = 103.5
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('103.50000000');
        });

        it('outlier resistance — extreme outlier in 7 submissions is trimmed', function () {
            let prices = [100000, 100001, 100002, 100003, 100004, 100005, 999999];
            let subs = submissionsForPair(prices);
            // After trim: [100001, 100002, 100003, 100004, 100005] → median = 100003
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('100003.00000000');
        });

        it('returns 8-decimal fixed-point string', function () {
            let subs = submissionsForPair([1.5]);
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('1.50000000');
        });

        it('returns null for no submissions', function () {
            expect(oc._aggregate(new Map(), 'BTC/USD')).to.be.null;
        });

        it('returns null for unknown coin pair', function () {
            let subs = submissionsForPair([100]);
            expect(oc._aggregate(subs, 'ETH/USD')).to.be.null;
        });

        it('ignores zero and negative prices', function () {
            let entries = [
                { sender: 'v1', prices: [{ coinPair: 'BTC/USD', price: '0' }] },
                { sender: 'v2', prices: [{ coinPair: 'BTC/USD', price: '-100' }] },
                { sender: 'v3', prices: [{ coinPair: 'BTC/USD', price: '50000' }] }
            ];
            let subs = buildSubmissions(entries);
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('50000.00000000');
        });

        it('ignores NaN prices', function () {
            let entries = [
                { sender: 'v1', prices: [{ coinPair: 'BTC/USD', price: 'not-a-number' }] },
                { sender: 'v2', prices: [{ coinPair: 'BTC/USD', price: '42000' }] }
            ];
            let subs = buildSubmissions(entries);
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('42000.00000000');
        });
    });

    // -----------------------------------------------------------------
    // _aggregateAll()
    // -----------------------------------------------------------------

    describe('_aggregateAll()', function () {
        it('aggregates all unique coin pairs from submissions', function () {
            let entries = [
                { sender: 'v1', prices: [
                    { coinPair: 'BTC/USD', price: '100000' },
                    { coinPair: 'LTC/USD', price: '80' }
                ]},
                { sender: 'v2', prices: [
                    { coinPair: 'BTC/USD', price: '100002' },
                    { coinPair: 'LTC/USD', price: '82' }
                ]}
            ];
            let subs = buildSubmissions(entries);
            let result = oc._aggregateAll(subs);
            expect(result).to.have.lengthOf(2);
            let btc = result.find(r => r.coinPair === 'BTC/USD');
            let ltc = result.find(r => r.coinPair === 'LTC/USD');
            expect(btc.price).to.equal('100001.00000000');
            expect(ltc.price).to.equal('81.00000000');
        });

        it('returns empty array for empty submissions', function () {
            expect(oc._aggregateAll(new Map())).to.deep.equal([]);
        });
    });

    // -----------------------------------------------------------------
    // _getQuorum()
    // -----------------------------------------------------------------

    describe('_getQuorum()', function () {
        it('N=1 → 0 (single node, no consensus needed)', function () {
            oc.setValidatorSet([{ pubkey: 'a', addr: 'a' }]);
            expect(oc._getQuorum()).to.equal(0);
        });

        it('N=3 → 1', function () {
            oc.setValidatorSet(VALIDATORS_3);
            expect(oc._getQuorum()).to.equal(1);
        });

        it('N=4 → 3', function () {
            oc.setValidatorSet(VALIDATORS_4);
            expect(oc._getQuorum()).to.equal(3);
        });

        it('N=7 → 5', function () {
            oc.setValidatorSet(VALIDATORS_7);
            expect(oc._getQuorum()).to.equal(5);
        });

        it('N=10 → 7', function () {
            oc.setValidatorSet(VALIDATORS_10);
            expect(oc._getQuorum()).to.equal(7);
        });

        it('N=13 → 9', function () {
            oc.setValidatorSet(VALIDATORS_13);
            expect(oc._getQuorum()).to.equal(9);
        });

        it('empty validator set falls back to peer count', function () {
            oc.setValidatorSet([]);
            pm.getPeerStatus.returns([{ state: 'open' }, { state: 'open' }]);
            // N = 2 peers + 1 self = 3 → f=0, quorum = 1
            expect(oc._getQuorum()).to.equal(1);
        });
    });

    // -----------------------------------------------------------------
    // _getLeader()
    // -----------------------------------------------------------------

    describe('_getLeader()', function () {
        it('returns validator at round % N', function () {
            oc.setValidatorSet(VALIDATORS_3);
            expect(oc._getLeader(0)).to.equal(VALIDATORS_3[0]);
            expect(oc._getLeader(1)).to.equal(VALIDATORS_3[1]);
            expect(oc._getLeader(2)).to.equal(VALIDATORS_3[2]);
            expect(oc._getLeader(3)).to.equal(VALIDATORS_3[0]); // wraps
        });

        it('returns null for empty validator set', function () {
            oc.setValidatorSet([]);
            expect(oc._getLeader(0)).to.be.null;
        });
    });

    // -----------------------------------------------------------------
    // _digest()
    // -----------------------------------------------------------------

    describe('_digest()', function () {
        it('returns a hex SHA-256 hash', function () {
            let d = oc._digest(1, [{ coinPair: 'BTC/USD', price: '100000' }]);
            expect(d).to.match(/^[0-9a-f]{64}$/);
        });

        it('same inputs produce same digest', function () {
            let prices = [{ coinPair: 'BTC/USD', price: '100000' }];
            expect(oc._digest(1, prices)).to.equal(oc._digest(1, prices));
        });

        it('different round produces different digest', function () {
            let prices = [{ coinPair: 'BTC/USD', price: '100000' }];
            expect(oc._digest(1, prices)).to.not.equal(oc._digest(2, prices));
        });
    });

    // -----------------------------------------------------------------
    // finalizeRound()
    // -----------------------------------------------------------------

    describe('finalizeRound()', function () {

        it('skips already-finalized rounds', async function () {
            oc.finalized.add(5);
            await oc.finalizeRound(5);
            expect(hub.db.doQuery.callCount).to.equal(0);
        });

        it('stores skipped round when no submissions', async function () {
            oracleRound.getSubmissions.returns(new Map());
            await oc.finalizeRound(5);
            expect(hub.db.doQuery.called).to.be.true;
            let firstCall = hub.db.doQuery.getCall(0);
            expect(firstCall.args[0]).to.include('skipped');
        });

        it('single-node (quorum=0) stores directly and emits event', async function () {
            oc.setValidatorSet([]);
            pm.getPeerStatus.returns([]); // N = 0 + 1 = 1 → quorum 0

            let entries = [
                { sender: pm.validatorAddr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] }
            ];
            oracleRound.getSubmissions.returns(buildSubmissions(entries));

            let emitted = null;
            oc.on('round:finalized', (data) => { emitted = data; });

            await oc.finalizeRound(1);

            expect(hub.db.doQuery.called).to.be.true;
            expect(emitted).to.not.be.null;
            expect(emitted.round).to.equal(1);
            expect(emitted.prices[0].coinPair).to.equal('BTC/USD');
        });

        it('non-leader does not propose', async function () {
            oc.setValidatorSet(VALIDATORS_3);
            // Round 0 leader is VALIDATORS_3[0], but our addr is different
            pm.validatorAddr = 'ws://not-a-leader:10001';

            let entries = [
                { sender: 'v1', prices: [{ coinPair: 'BTC/USD', price: '100000' }] }
            ];
            oracleRound.getSubmissions.returns(buildSubmissions(entries));

            await oc.finalizeRound(0);
            expect(pm.broadcast.called).to.be.false;
        });

        it('leader proposes and broadcasts ORACLE_PROPOSE', async function () {
            oc.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr; // Make us the leader for round 0

            let entries = [
                { sender: 'v1', prices: [{ coinPair: 'BTC/USD', price: '100000' }] },
                { sender: 'v2', prices: [{ coinPair: 'BTC/USD', price: '100002' }] }
            ];
            oracleRound.getSubmissions.returns(buildSubmissions(entries));

            await oc.finalizeRound(0);

            // First broadcast should be ORACLE_PROPOSE
            expect(pm.broadcast.called).to.be.true;
            let [type, data] = pm.broadcast.getCall(0).args;
            expect(type).to.equal('ORACLE_PROPOSE');
            expect(data.round).to.equal(0);
            expect(data.prices).to.be.an('array');
            expect(data.digest).to.be.a('string');

            // Clean up timer
            let pending = oc.pendingRounds.get(0);
            if (pending && pending.timer) clearTimeout(pending.timer);
        });
    });

    // -----------------------------------------------------------------
    // PBFT message flow
    // -----------------------------------------------------------------

    describe('PBFT message flow', function () {

        beforeEach(function () {
            // Use VALIDATORS_4 (quorum=3) to prevent auto-completion
            oc.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
        });

        afterEach(function () {
            for (let [, pending] of oc.pendingRounds) {
                if (pending.timer) clearTimeout(pending.timer);
            }
        });

        it('PREPARE from peer is recorded', function () {
            let prices = [{ coinPair: 'BTC/USD', price: '100000.00000000' }];
            let digest = oc._digest(1, prices);

            oc.pendingRounds.set(1, {
                prices, digest, prepares: new Set(), commits: new Set(),
                finalized: false, timer: null
            });

            oc._handlePrepare({
                sender: VALIDATORS_4[1].addr,
                data: { round: 1, digest }
            });

            expect(oc.pendingRounds.get(1).prepares.has(VALIDATORS_4[1].addr)).to.be.true;
        });

        it('PREPARE with wrong digest is rejected', function () {
            let prices = [{ coinPair: 'BTC/USD', price: '100000.00000000' }];
            let digest = oc._digest(1, prices);

            oc.pendingRounds.set(1, {
                prices, digest, prepares: new Set(), commits: new Set(),
                finalized: false, timer: null
            });

            oc._handlePrepare({
                sender: VALIDATORS_4[1].addr,
                data: { round: 1, digest: 'wrong-digest' }
            });

            expect(oc.pendingRounds.get(1).prepares.size).to.equal(0);
        });

        it('reaching prepare quorum broadcasts COMMIT', function () {
            let prices = [{ coinPair: 'BTC/USD', price: '100000.00000000' }];
            let digest = oc._digest(1, prices);

            // N=4, quorum=3. Start with 2 prepares.
            oc.pendingRounds.set(1, {
                prices, digest,
                prepares: new Set([VALIDATORS_4[0].addr, VALIDATORS_4[1].addr]),
                commits: new Set(),
                finalized: false, timer: null
            });

            // Third prepare → quorum met
            oc._handlePrepare({
                sender: VALIDATORS_4[2].addr,
                data: { round: 1, digest }
            });

            expect(pm.broadcast.called).to.be.true;
            let [type] = pm.broadcast.getCall(0).args;
            expect(type).to.equal('ORACLE_COMMIT');
        });

        it('reaching commit quorum stores snapshot and emits event', async function () {
            let prices = [{ coinPair: 'BTC/USD', price: '100000.00000000' }];
            let digest = oc._digest(1, prices);

            oracleRound.getSubmissions.returns(new Map());

            // N=4, quorum=3. Start with 2 commits.
            oc.pendingRounds.set(1, {
                prices, digest,
                prepares: new Set([VALIDATORS_4[0].addr, VALIDATORS_4[1].addr, VALIDATORS_4[2].addr]),
                commits:  new Set([VALIDATORS_4[0].addr, VALIDATORS_4[1].addr]),
                finalized: false, timer: null, _commitSent: true
            });

            let emitted = null;
            oc.on('round:finalized', (data) => { emitted = data; });

            // Third commit → quorum met
            oc._handleCommit({
                sender: VALIDATORS_4[2].addr,
                data: { round: 1, digest }
            });

            await new Promise(r => setTimeout(r, 20));

            expect(hub.db.doQuery.called).to.be.true;
            expect(emitted).to.not.be.null;
            expect(emitted.round).to.equal(1);
            expect(oc.finalized.has(1)).to.be.true;
        });

        it('duplicate votes from same sender are counted once', function () {
            let prices = [{ coinPair: 'BTC/USD', price: '100000.00000000' }];
            let digest = oc._digest(1, prices);

            oc.pendingRounds.set(1, {
                prices, digest, prepares: new Set(), commits: new Set(),
                finalized: false, timer: null
            });

            oc._handlePrepare({ sender: VALIDATORS_4[1].addr, data: { round: 1, digest } });
            oc._handlePrepare({ sender: VALIDATORS_4[1].addr, data: { round: 1, digest } });

            expect(oc.pendingRounds.get(1).prepares.size).to.equal(1);
        });
    });
});
