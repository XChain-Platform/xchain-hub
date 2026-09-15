'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const sinon          = require('sinon');
const { expect }     = require('chai');
const { createMockHub } = require('../helpers/mockHub');
const { PRICE_MAX }        = require('../../src/constants.js');
const { VALIDATORS_4, SAMPLE_PRICES,
        buildSubmissions, makeFederationSnapshot, pubkeyForTestSender } = require('../helpers/fixtures');
// A price strictly above the accepted (0, PRICE_MAX) band, used as the
// out-of-bounds sentinel so these bound tests track PRICE_MAX (widened over time
// from 10M) instead of a hardcoded literal that silently rots.
const OVER_CAP_PRICE = String(PRICE_MAX * 2);

// =================================================================
// Consensus: Sequence monotonicity
// =================================================================
function sequenceMonotonicitySuite() {
        const Consensus = require('../../src/consensus/pbft');

        let hub, pm, consensus;

        beforeEach(function () {
            hub = createMockHub();
            pm  = hub._peerManager;
            consensus = new Consensus(hub);
            consensus.setValidatorSet(VALIDATORS_4);
        });

        afterEach(function () {
            for (let [, prop] of consensus.pendingProposals) {
                if (prop.timer) clearTimeout(prop.timer);
            }
        });

        it('rejects PRE_PREPARE with seq <= lastAppliedSeq', function () {
            consensus.lastAppliedSeq = 5;
            let warnStub = sinon.stub(console, 'warn');
            let config = { a: 1 };
            let digest = consensus._digest(config);
            let envelope = {
                type: 'PBFT_PRE_PREPARE',
                sender: VALIDATORS_4[1].addr,                       // leader for (seq 3, view 2): (3+2)%4 = 1
                sig_pubkey: VALIDATORS_4[1].pubkey,
                data: { seq: 3, view: 2, configDigest: digest, config: config }
            };
            consensus.handlePrePrepare(envelope);
            expect(consensus.pendingProposals.has(3)).to.be.false;
            expect(warnStub.calledWith(sinon.match(/stale seq/))).to.be.true;
        });

        it('accepts PRE_PREPARE with seq > lastAppliedSeq', async function () {
            consensus.lastAppliedSeq = 2;
            let config = { a: 1 };
            let digest = consensus._digest(config);
            // Federation guard: with a 4-member validator set this hub is federated
            // regardless of MIN_VALIDATORS, so it declines to PREPARE unless the
            // PRE_PREPARE carries a block height and a deterministic snapshot
            // resolves. Supply both; the seq-monotonicity contract under test is
            // unaffected.
            hub.capabilitySnapshot = {
                getActiveValidatorSnapshot: sinon.stub().returns(makeFederationSnapshot(VALIDATORS_4, 800000)),
                getQuorum: sinon.stub().returns(3)
            };
            hub._resolveBtcLatestBlock = sinon.stub().resolves(800000);
            let envelope = {
                type: 'PBFT_PRE_PREPARE',
                sender: VALIDATORS_4[0].addr,                       // leader for (seq 3, view 1): (3+1)%4 = 0
                sig_pubkey: VALIDATORS_4[0].pubkey,
                data: { seq: 3, view: 1, configDigest: digest, config: config, btcBlockHeight: 800000 }
            };
            await consensus.handlePrePrepare(envelope);
            expect(consensus.pendingProposals.has(3)).to.be.true;
            let p = consensus.pendingProposals.get(3);
            if (p.timer) clearTimeout(p.timer);
        });
    }

// =================================================================
// Consensus: Minimum quorum warning
// =================================================================
function minimumQuorumSuite() {
        const Consensus = require('../../src/consensus/pbft');

        it('refuses to propose (fail closed) when minValidators > 1 and no deterministic snapshot', async function () {
            // Hardened behavior (federation-split guard): a multi-hub federation with no
            // deterministic validator snapshot must not fall back to single-node apply
            // (which would let two hubs finalize the same config round over different local
            // sets). It fails closed instead. The mock hub resolves no capability snapshot,
            // so this exercises the refusal path.
            let hub = createMockHub();
            let consensus = new Consensus(hub);
            consensus.minValidators = 3;
            consensus.setValidatorSet([]);
            hub._peerManager.getPeerStatus.returns([]);
            let threw = null;
            try {
                await consensus.propose({ x: 1 });
            } catch (e) {
                threw = e;
            }
            expect(threw, 'propose must reject rather than apply unilaterally').to.exist;
            expect(threw.message).to.match(/deterministic|snapshot/i);
        });

        it('does not log warning when minValidators is 1', async function () {
            let hub = createMockHub();
            let consensus = new Consensus(hub);
            consensus.minValidators = 1;
            consensus.setValidatorSet([]);
            hub._peerManager.getPeerStatus.returns([]);
            let warnStub = sinon.stub(console, 'warn');
            await consensus.propose({ x: 1 });
            expect(warnStub.calledWith(sinon.match(/single-node mode/))).to.be.false;
        });
    }

// =================================================================
// OracleConsensus: Minimum submissions
// =================================================================
function minimumSubmissionsSuite() {
        const OracleConsensus = require('../../src/oracle/consensus');

        let hub, pm, oracleRound, oc;

        beforeEach(function () {
            hub = createMockHub();
            pm  = hub._peerManager;
            oracleRound = {
                getSubmissions: sinon.stub()
            };
            oc = new OracleConsensus(hub, oracleRound);
            oc.setValidatorSet([]);
            pm.getPeerStatus.returns([]);
        });

        afterEach(function () {
            for (let [, pending] of oc.pendingRounds) {
                if (pending.timer) clearTimeout(pending.timer);
            }
        });

        it('skips round when submissions < minSubmissions', async function () {
            oc.minSubmissions = 3;
            let submissions = new Map();
            submissions.set('validator-1', { prices: SAMPLE_PRICES, sources: 2, timestamp: Date.now() });
            oracleRound.getSubmissions.returns(submissions);
            let storeSkipped = sinon.stub(oc, 'storeSkippedRound').resolves();

            await oc.finalizeRound(1);
            expect(storeSkipped.calledOnce).to.be.true;
        });

        it('proceeds when submissions >= minSubmissions', async function () {
            oc.minSubmissions = 1;
            let submissions = new Map();
            submissions.set('v1', { prices: SAMPLE_PRICES, sources: 2, timestamp: Date.now() });
            oracleRound.getSubmissions.returns(submissions);
            let storeSkipped = sinon.stub(oc, 'storeSkippedRound');
            let storeSnapshot = sinon.stub(oc, '_storeSnapshot').resolves();

            await oc.finalizeRound(1);
            expect(storeSkipped.called).to.be.false;
            expect(storeSnapshot.calledOnce).to.be.true;
        });
    }

// =================================================================
// OracleConsensus: Price sanity bounds
// =================================================================
function priceSanitySuite() {
        const OracleConsensus = require('../../src/oracle/consensus');

        let oc;

        beforeEach(function () {
            let hub = createMockHub();
            oc = new OracleConsensus(hub, { getSubmissions: sinon.stub() });
        });

        it('_aggregate() rejects prices >= PRICE_MAX', function () {
            let subs = buildSubmissions([
                { sender: 'v1', prices: [{ coinPair: 'BTC/USD', price: OVER_CAP_PRICE }] },
                { sender: 'v2', prices: [{ coinPair: 'BTC/USD', price: '100000' }] }
            ]);
            let result = oc._aggregate(subs, 'BTC/USD');
            expect(result).to.equal('100000.00000000');
        });

        it('_aggregate() rejects prices <= 0', function () {
            let subs = buildSubmissions([
                { sender: 'v1', prices: [{ coinPair: 'BTC/USD', price: '-1' }] },
                { sender: 'v2', prices: [{ coinPair: 'BTC/USD', price: '100000' }] }
            ]);
            let result = oc._aggregate(subs, 'BTC/USD');
            expect(result).to.equal('100000.00000000');
        });

        it('_aggregate() returns null when all prices are out of bounds', function () {
            let subs = buildSubmissions([
                { sender: 'v1', prices: [{ coinPair: 'BTC/USD', price: OVER_CAP_PRICE }] },
                { sender: 'v2', prices: [{ coinPair: 'BTC/USD', price: '-5' }] }
            ]);
            let result = oc._aggregate(subs, 'BTC/USD');
            expect(result).to.be.null;
        });
    }

function registerSubmissionFilterTest(getOracleRound) {
    it('filters out invalid prices from submissions', function () {
        let oracleRound = getOracleRound();
        let envelope = {
            type: 'ORACLE_PRICE_SUBMIT',
            sender: 'ws://peer-1:10001',
            sig_pubkey: pubkeyForTestSender('ws://peer-1:10001'),
            timestamp: Date.now(),
            data: {
                round: 5,
                prices: [
                    { coinPair: 'BTC/USD', price: '100000', sources: 1 },
                    { coinPair: 'LTC/USD', price: '-5', sources: 1 },
                    { coinPair: 'DOGE/USD', price: OVER_CAP_PRICE, sources: 1 }
                ],
                sources: 3
            }
        };
        oracleRound._handleMessage(envelope);
        let subs = oracleRound.submissions.get(5);
        expect(subs.has('ws://peer-1:10001')).to.be.true;
        let sub = subs.get('ws://peer-1:10001');
        expect(sub.prices).to.have.length(1);
        expect(sub.prices[0].coinPair).to.equal('BTC/USD');
    });
}

// =================================================================
// OracleRound: Price validation
// =================================================================
function submissionValidationSuite() {
        const OracleRound = require('../../src/oracle/round');

        let hub, oracleRound;

        beforeEach(function () {
            hub = createMockHub();
            hub._peerManager.validatorPubkeys = new Map();
            oracleRound = new OracleRound(hub);
            oracleRound.currentRound = 5;
            oracleRound.roundStartTime = Date.now();
            oracleRound.submissions.set(5, new Map());
        });

        registerSubmissionFilterTest(() => oracleRound);

        it('rejects submission with all invalid prices', function () {
            let envelope = {
                type: 'ORACLE_PRICE_SUBMIT',
                sender: 'ws://peer-2:10001',
                timestamp: Date.now(),
                data: {
                    round: 5,
                    prices: [
                        { coinPair: 'BTC/USD', price: '-1', sources: 1 },
                        { coinPair: 'LTC/USD', price: 'NaN', sources: 1 }
                    ],
                    sources: 2
                }
            };
            oracleRound._handleMessage(envelope);
            let subs = oracleRound.submissions.get(5);
            expect(subs.has('ws://peer-2:10001')).to.be.false;
        });

        it('enforces max submissions per round', function () {
            oracleRound.maxSubmissionsPerRound = 2;
            let subs = oracleRound.submissions.get(5);
            subs.set('existing-1', { prices: SAMPLE_PRICES, sources: 2, timestamp: Date.now() });
            subs.set('existing-2', { prices: SAMPLE_PRICES, sources: 2, timestamp: Date.now() });

            let envelope = {
                type: 'ORACLE_PRICE_SUBMIT',
                sender: 'ws://peer-3:10001',
                timestamp: Date.now(),
                data: { round: 5, prices: SAMPLE_PRICES, sources: 2 }
            };
            oracleRound._handleMessage(envelope);
            expect(subs.size).to.equal(2);
            expect(subs.has('ws://peer-3:10001')).to.be.false;
        });
    }

function securityHardeningSuite() {
    afterEach(function () {
        sinon.restore();
    });
    describe('Consensus: Sequence monotonicity', sequenceMonotonicitySuite);
    describe('Consensus: Minimum quorum warning', minimumQuorumSuite);
    describe('OracleConsensus: Minimum submissions', minimumSubmissionsSuite);
    describe('OracleConsensus: Price sanity bounds', priceSanitySuite);
    describe('OracleRound: Submission validation', submissionValidationSuite);
}

describe('Security Hardening', securityHardeningSuite);
