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

        it('counts duplicate same-pair entries from one sender as a single data point', function () {
            // A sender may include N entries for the same pair in one submission.
            // Each sender must contribute at most one value, otherwise values.length
            // is inflated and the trim boundary (floor(N * 0.15)) shifts so the
            // duplicated outlier survives instead of being trimmed.
            //
            // Six honest senders at 100, plus one sender at 200 duplicated 20×.
            //   Deduped: [100×6, 200×1] → 7 values, trimCount=floor(7*0.15)=1,
            //            trim removes the 200 → median 100.
            //   If duplicates counted: [100×6, 200×20] → 26 values,
            //            trimCount=floor(26*0.15)=3, the 200s dominate → median 200.
            let entries = [
                { sender: 'v1', prices: [{ coinPair: 'BTC/USD', price: '100' }] },
                { sender: 'v2', prices: [{ coinPair: 'BTC/USD', price: '100' }] },
                { sender: 'v3', prices: [{ coinPair: 'BTC/USD', price: '100' }] },
                { sender: 'v4', prices: [{ coinPair: 'BTC/USD', price: '100' }] },
                { sender: 'v5', prices: [{ coinPair: 'BTC/USD', price: '100' }] },
                { sender: 'v6', prices: [{ coinPair: 'BTC/USD', price: '100' }] },
                { sender: 'attacker', prices: Array.from({ length: 20 },
                    () => ({ coinPair: 'BTC/USD', price: '200' })) }
            ];
            let subs = buildSubmissions(entries);
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('100.00000000');
        });

        it('uses the first valid entry per sender, skipping an invalid leading duplicate', function () {
            // The first entry for the pair is invalid (zero) and must be skipped;
            // the next valid entry is the sender's single data point. A single
            // valid value alone is returned as-is.
            let entries = [
                { sender: 'v1', prices: [
                    { coinPair: 'BTC/USD', price: '0' },       // skipped (invalid)
                    { coinPair: 'BTC/USD', price: '55000' },   // first valid → used
                    { coinPair: 'BTC/USD', price: '999999' }   // ignored (already have one)
                ]}
            ];
            let subs = buildSubmissions(entries);
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('55000.00000000');
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

            let emitCount = 0;
            let emitted = null;
            oc.on('round:finalized', (data) => { emitCount++; emitted = data; });

            let storeSpy = sinon.spy(oc, '_storeSnapshot');

            await oc.finalizeRound(1);

            expect(hub.db.doQuery.called).to.be.true;
            expect(emitted).to.not.be.null;
            expect(emitted.round).to.equal(1);
            expect(emitted.prices[0].coinPair).to.equal('BTC/USD');

            // The round must now be marked finalized so a repeat call is a no-op
            // (guards against a duplicate snapshot store / PRICE v0 broadcast).
            await oc.finalizeRound(1);
            expect(storeSpy.callCount).to.equal(1);
            expect(emitCount).to.equal(1);
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
                signatures: new Map(),
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
                signatures: new Map(),
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

    // -----------------------------------------------------------------
    // Fallback proposer election
    //
    // The deterministic leader sometimes has no submission for a round
    // (e.g. its price fetch failed). In that case the lowest-addr submitter
    // takes over as fallback proposer. A receiver decides whether an incoming
    // PROPOSE is a legitimate fallback by electing the lowest-addr submitter
    // from ITS OWN locally-observed submission map — never from the
    // submissionKeys list piggybacked on the PROPOSE, which is
    // attacker-controlled. A Byzantine proposer could otherwise claim a subset
    // whose lowest entry is its own address and elect itself fallback even when
    // the real leader submitted, injecting arbitrary prices into the round.
    //
    // The proposer still attaches its sorted submissionKeys as a diagnostic
    // hint, but receivers ignore it for the legitimacy check. The accepted cost
    // is a liveness edge case: if async gossip leaves a receiver's local view
    // lagging, it may reject a legitimate fallback and stall the round until the
    // finalization timeout re-elects.
    // -----------------------------------------------------------------

    describe('fallback proposer election', function () {

        afterEach(function () {
            for (let [, pending] of oc.pendingRounds) {
                if (pending.timer) clearTimeout(pending.timer);
            }
        });

        it('_proposeRound attaches the sorted submission keys to PROPOSE', function () {
            oc.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[3].addr;

            // Submitters arrive out of order in the map; submissionKeys must be sorted.
            let entries = [
                { sender: VALIDATORS_4[3].addr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] },
                { sender: VALIDATORS_4[1].addr, prices: [{ coinPair: 'BTC/USD', price: '100002' }] }
            ];
            let subs = buildSubmissions(entries);

            oc._proposeRound(7, subs, true, 100, 1700000000, null, 3);

            let [type, data] = pm.broadcast.getCall(0).args;
            expect(type).to.equal('ORACLE_PROPOSE');
            expect(data.submissionKeys).to.deep.equal(
                [VALIDATORS_4[1].addr, VALIDATORS_4[3].addr].sort()
            );
        });

        it('finalizeRound (leader path) includes submissionKeys in PROPOSE', async function () {
            oc.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr; // leader for round 0

            let entries = [
                { sender: VALIDATORS_4[0].addr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] },
                { sender: VALIDATORS_4[1].addr, prices: [{ coinPair: 'BTC/USD', price: '100002' }] }
            ];
            oracleRound.getSubmissions.returns(buildSubmissions(entries));

            await oc.finalizeRound(0);

            let [type, data] = pm.broadcast.getCall(0).args;
            expect(type).to.equal('ORACLE_PROPOSE');
            expect(data.submissionKeys).to.deep.equal(
                [VALIDATORS_4[0].addr, VALIDATORS_4[1].addr].sort()
            );
        });

        it('accepts a fallback PROPOSE when the sender is the lowest submitter in the local map', async function () {
            // We are validator-2 ("Hub A"), a receiver. Round 4 leader is v1
            // (4 % 4 = 0), which did not submit → the fallback path applies.
            oc.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[1].addr;

            let prices = [{ coinPair: 'BTC/USD', price: '100000.00000000' }];
            let digest = oc._digest(4, prices);

            // Local view {v3, v4}: lowest is v3, so a PROPOSE from v3 is a
            // legitimate fallback by our own observation.
            oracleRound.getSubmissions.returns(buildSubmissions([
                { sender: VALIDATORS_4[2].addr, prices },
                { sender: VALIDATORS_4[3].addr, prices }
            ]));

            await oc._handlePropose({
                sender: VALIDATORS_4[2].addr,
                data: {
                    round:          4,
                    prices,
                    digest,
                    submissionKeys: [VALIDATORS_4[2].addr, VALIDATORS_4[3].addr]
                }
            });

            expect(oc.pendingRounds.has(4)).to.be.true;
            expect(pm.broadcast.called).to.be.true;
            let [type] = pm.broadcast.getCall(0).args;
            expect(type).to.equal('ORACLE_PREPARE');
        });

        it('SECURITY: rejects a crafted PROPOSE whose submissionKeys claim the sender is the lone (lowest) submitter', async function () {
            // Attack path: a Byzantine validator (v4) sends a PROPOSE claiming
            // submissionKeys=[v4] — a single-element set whose lowest entry is
            // itself — to fraudulently elect itself fallback. Our local map
            // actually holds {v2, v4}, whose lowest is v2, so v4 is NOT a
            // legitimate fallback. Trusting the claimed list (the prior bug)
            // would accept the attacker's arbitrary prices; election from the
            // local map rejects it.
            oc.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[1].addr; // we are v2

            // Round 4 leader is v1 (absent), so the fallback branch is reachable.
            let prices = [{ coinPair: 'BTC/USD', price: '666666.00000000' }]; // attacker's fabricated price
            let digest = oc._digest(4, prices);

            oracleRound.getSubmissions.returns(buildSubmissions([
                { sender: VALIDATORS_4[1].addr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] },
                { sender: VALIDATORS_4[3].addr, prices: [{ coinPair: 'BTC/USD', price: '100002' }] }
            ]));

            await oc._handlePropose({
                sender: VALIDATORS_4[3].addr,
                data: {
                    round:          4,
                    prices,
                    digest,
                    submissionKeys: [VALIDATORS_4[3].addr]   // self-serving claim — must be ignored
                }
            });

            expect(oc.pendingRounds.has(4)).to.be.false;
            expect(pm.broadcast.called).to.be.false;
        });

        it('rejects a PROPOSE when the sender is not the lowest submitter in the local map', async function () {
            oc.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[1].addr;

            let prices = [{ coinPair: 'BTC/USD', price: '100000.00000000' }];
            let digest = oc._digest(4, prices);

            // Local view {v3, v4}: lowest is v3, so v4 is not a legitimate fallback.
            oracleRound.getSubmissions.returns(buildSubmissions([
                { sender: VALIDATORS_4[2].addr, prices },
                { sender: VALIDATORS_4[3].addr, prices }
            ]));

            await oc._handlePropose({
                sender: VALIDATORS_4[3].addr,
                data: {
                    round:          4,
                    prices,
                    digest,
                    submissionKeys: [VALIDATORS_4[2].addr, VALIDATORS_4[3].addr]
                }
            });

            expect(oc.pendingRounds.has(4)).to.be.false;
            expect(pm.broadcast.called).to.be.false;
        });

        it('elects from the local map regardless of whether submissionKeys is present', async function () {
            // submissionKeys is omitted entirely; the local map {v2, v4} still
            // governs. Lowest is v2, so v4's PROPOSE is rejected.
            oc.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[1].addr;

            let prices = [{ coinPair: 'BTC/USD', price: '100000.00000000' }];
            let digest = oc._digest(4, prices);

            oracleRound.getSubmissions.returns(buildSubmissions([
                { sender: VALIDATORS_4[1].addr, prices },
                { sender: VALIDATORS_4[3].addr, prices }
            ]));

            await oc._handlePropose({
                sender: VALIDATORS_4[3].addr,
                data: { round: 4, prices, digest }
            });

            expect(oc.pendingRounds.has(4)).to.be.false;
            expect(pm.broadcast.called).to.be.false;
        });
    });

    // -----------------------------------------------------------------
    // Leader-timeout fallback (post-submission leader crash)
    //
    // A leader can gossip (and have peers record) its submission and then crash
    // before broadcasting ORACLE_PROPOSE. The plain no-submission fallback never
    // fires because every hub sees leaderSubmitted === true, so the round would
    // otherwise stall until the full finalization timeout. After a shorter
    // leader-timeout grace with no PROPOSE, the lowest-addr submitter OTHER THAN
    // the dead leader takes over; receivers accept that fallback only once their
    // own grace (measured from the block-driven round-ready time) has elapsed, so
    // an early/malicious fallback cannot usurp a still-alive leader.
    // -----------------------------------------------------------------

    describe('leader-timeout fallback', function () {

        let clock;

        afterEach(function () {
            if (clock) { clock.restore(); clock = null; }
            for (let [, t] of oc.leaderTimers) clearTimeout(t);
            for (let [, pending] of oc.pendingRounds) {
                if (pending.timer) clearTimeout(pending.timer);
            }
        });

        it('elected fallback proposes after the grace when the leader submitted but never proposed', async function () {
            clock = sinon.useFakeTimers();
            oc.setValidatorSet(VALIDATORS_4);
            // Round 0 leader is VALIDATORS_4[0] (validator-1). We are validator-2,
            // the lowest-addr submitter excluding the leader → the elected fallback.
            pm.validatorAddr = VALIDATORS_4[1].addr;

            let prices = [{ coinPair: 'BTC/USD', price: '100000' }];
            // Leader submitted (and gossiped), then crashed before proposing.
            oracleRound.getSubmissions.returns(buildSubmissions([
                { sender: VALIDATORS_4[0].addr, prices },   // leader
                { sender: VALIDATORS_4[1].addr, prices },   // us (fallback)
                { sender: VALIDATORS_4[2].addr, prices }
            ]));

            await oc.finalizeRound(0);

            // A leader-timeout timer must be armed, and nothing proposed yet.
            expect(oc.leaderTimers.has(0)).to.be.true;
            expect(pm.broadcast.called).to.be.false;

            // Before the grace elapses, still no PROPOSE.
            clock.tick(oc.leaderTimeout - 1);
            expect(pm.broadcast.called).to.be.false;

            // Past the grace (+ skew buffer) the fallback takes over and proposes.
            clock.tick(oc.leaderTimeout + 5000);
            expect(pm.broadcast.called).to.be.true;
            let [type, data] = pm.broadcast.getCall(0).args;
            expect(type).to.equal('ORACLE_PROPOSE');
            expect(data.round).to.equal(0);
        });

        it('non-elected follower does not arm a leader-timeout timer', async function () {
            clock = sinon.useFakeTimers();
            oc.setValidatorSet(VALIDATORS_4);
            // We are validator-3; the elected fallback is validator-2, so we wait.
            pm.validatorAddr = VALIDATORS_4[2].addr;

            let prices = [{ coinPair: 'BTC/USD', price: '100000' }];
            oracleRound.getSubmissions.returns(buildSubmissions([
                { sender: VALIDATORS_4[0].addr, prices },
                { sender: VALIDATORS_4[1].addr, prices },
                { sender: VALIDATORS_4[2].addr, prices }
            ]));

            await oc.finalizeRound(0);

            expect(oc.leaderTimers.has(0)).to.be.false;
            clock.tick(oc.leaderTimeout + 5000);
            expect(pm.broadcast.called).to.be.false;
        });

        it('aborts the takeover if a PROPOSE arrives during the grace', async function () {
            clock = sinon.useFakeTimers();
            oc.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[1].addr; // elected fallback

            // Round 4 leader is VALIDATORS_4[0] (4 % 4 === 0). Round 4 (not 0)
            // because _handlePropose rejects the falsy round 0.
            let prices = [{ coinPair: 'BTC/USD', price: '100000' }];
            oracleRound.getSubmissions.returns(buildSubmissions([
                { sender: VALIDATORS_4[0].addr, prices },
                { sender: VALIDATORS_4[1].addr, prices },
                { sender: VALIDATORS_4[2].addr, prices }
            ]));

            await oc.finalizeRound(4);
            expect(oc.leaderTimers.has(4)).to.be.true;

            // The (real) leader's PROPOSE lands mid-grace → pendingRounds populated.
            let digest = oc._digest(4, prices);
            await oc._handlePropose({
                sender: VALIDATORS_4[0].addr,
                data: { round: 4, prices, digest }
            });
            expect(oc.pendingRounds.has(4)).to.be.true;
            let proposeCalls = pm.broadcast.getCalls().filter(c => c.args[0] === 'ORACLE_PROPOSE').length;

            // Firing the grace must NOT add a second (fallback) PROPOSE.
            clock.tick(oc.leaderTimeout + 5000);
            let afterCalls = pm.broadcast.getCalls().filter(c => c.args[0] === 'ORACLE_PROPOSE').length;
            expect(afterCalls).to.equal(proposeCalls);
        });

        it('receiver rejects a leader-timeout fallback PROPOSE before the grace, accepts it after', async function () {
            clock = sinon.useFakeTimers({ now: 1700000000000 });
            oc.setValidatorSet(VALIDATORS_4);
            // We are validator-3, a plain receiver. Round 4 leader is validator-1
            // (submitted); the legitimate post-crash fallback is validator-2.
            pm.validatorAddr = VALIDATORS_4[2].addr;

            let prices = [{ coinPair: 'BTC/USD', price: '100000.00000000' }];
            let digest = oc._digest(4, prices);
            oracleRound.getSubmissions.returns(buildSubmissions([
                { sender: VALIDATORS_4[0].addr, prices },   // leader submitted
                { sender: VALIDATORS_4[1].addr, prices }    // fallback
            ]));

            // Learn the round is ready (sets roundReadyAt for the grace clock).
            await oc.finalizeRound(4);
            expect(pm.broadcast.called).to.be.false;

            // Fallback PROPOSE from validator-2 BEFORE the grace → rejected.
            await oc._handlePropose({
                sender: VALIDATORS_4[1].addr,
                data: { round: 4, prices, digest }
            });
            expect(oc.pendingRounds.has(4)).to.be.false;
            expect(pm.broadcast.called).to.be.false;

            // After the grace, the same fallback PROPOSE is accepted.
            clock.tick(oc.leaderTimeout);
            await oc._handlePropose({
                sender: VALIDATORS_4[1].addr,
                data: { round: 4, prices, digest }
            });
            expect(oc.pendingRounds.has(4)).to.be.true;
            let [type] = pm.broadcast.getCall(0).args;
            expect(type).to.equal('ORACLE_PREPARE');
        });

        it('SECURITY: after the grace, only the lowest non-leader submitter is accepted as fallback', async function () {
            clock = sinon.useFakeTimers({ now: 1700000000000 });
            oc.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[2].addr; // receiver (validator-3)

            let prices = [{ coinPair: 'BTC/USD', price: '666666.00000000' }];
            let digest = oc._digest(4, prices);
            // Round 4 leader (v1) submitted; submitters {v1, v2, v4}. Lowest
            // non-leader is v2, so a PROPOSE from v4 must be rejected even after
            // the grace.
            oracleRound.getSubmissions.returns(buildSubmissions([
                { sender: VALIDATORS_4[0].addr, prices },
                { sender: VALIDATORS_4[1].addr, prices },
                { sender: VALIDATORS_4[3].addr, prices }
            ]));

            await oc.finalizeRound(4);
            clock.tick(oc.leaderTimeout);

            await oc._handlePropose({
                sender: VALIDATORS_4[3].addr,   // v4 — not the lowest non-leader
                data: { round: 4, prices, digest }
            });
            expect(oc.pendingRounds.has(4)).to.be.false;
            expect(pm.broadcast.called).to.be.false;
        });
    });
});
