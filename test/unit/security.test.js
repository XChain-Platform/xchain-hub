'use strict';

const sinon          = require('sinon');
const { expect }     = require('chai');
const proxyquire     = require('proxyquire');
const { createMockHub }    = require('../helpers/mockHub');
const { VALIDATORS_3, VALIDATORS_4, makeValidator, SAMPLE_PRICES,
        buildSubmissions } = require('../helpers/fixtures');

describe('Security Hardening', function () {

    afterEach(function () {
        sinon.restore();
    });

    // =================================================================
    // PeerManager — Signature enforcement
    // =================================================================

    describe('PeerManager — Signature enforcement', function () {
        const PeerManager = require('../../src/PeerManager');

        it('REQUIRE_SIGNATURES defaults to true when not specified', function () {
            let pm = new PeerManager({ P2P_VALIDATOR_ADDR: 'ws://a:1' }, null);
            expect(pm.requireSigs).to.be.true;
        });

        it('REQUIRE_SIGNATURES can be disabled by setting false', function () {
            let pm = new PeerManager({ P2P_VALIDATOR_ADDR: 'ws://a:1', REQUIRE_SIGNATURES: false }, null);
            expect(pm.requireSigs).to.be.false;
        });

        it('rejects unsigned messages when requireSigs is true', function () {
            let pm = new PeerManager({ P2P_VALIDATOR_ADDR: 'ws://a:1', REQUIRE_SIGNATURES: true }, null);
            pm.validatorPubkeys = new Map();
            let envelope = { type: 'TEST', id: 'x1', sender: 'ws://peer:1', timestamp: Date.now(), data: {} };
            expect(pm._verifySignature(envelope)).to.be.false;
        });

        it('accepts unsigned messages when requireSigs is false', function () {
            let pm = new PeerManager({ P2P_VALIDATOR_ADDR: 'ws://a:1', REQUIRE_SIGNATURES: false }, null);
            let envelope = { type: 'TEST', id: 'x1', sender: 'ws://peer:1', timestamp: Date.now(), data: {} };
            expect(pm._verifySignature(envelope)).to.be.true;
        });
    });

    // =================================================================
    // PeerManager — Dedup cache bounds
    // =================================================================

    describe('PeerManager — Dedup cache bounds', function () {
        const PeerManager = require('../../src/PeerManager');

        it('evicts oldest entry when dedup cache reaches max', function () {
            let pm = new PeerManager({ P2P_VALIDATOR_ADDR: 'ws://a:1', P2P_DEDUP_CACHE_MAX: '5' }, null);
            for (let i = 0; i < 5; i++) {
                pm._addToDedup('id-' + i);
            }
            expect(pm.seenIds.size).to.equal(5);
            pm._addToDedup('id-5');
            expect(pm.seenIds.size).to.equal(5);
            expect(pm.seenIds.has('id-0')).to.be.false;
            expect(pm.seenIds.has('id-5')).to.be.true;
        });
    });

    // =================================================================
    // PeerManager — Peer address validation
    // =================================================================

    describe('PeerManager — Peer address validation', function () {
        const PeerManager = require('../../src/PeerManager');

        it('rejects peer addresses without port', function () {
            let pm = new PeerManager({ P2P_VALIDATOR_ADDR: 'ws://a:1' }, null);
            pm._connectToPeer('not-a-valid-addr');
            expect(pm.peers.has('not-a-valid-addr')).to.be.false;
        });

        it('rejects peer addresses with scheme prefix', function () {
            let pm = new PeerManager({ P2P_VALIDATOR_ADDR: 'ws://a:1' }, null);
            pm._connectToPeer('ws://peer.example.com:10001');
            expect(pm.peers.has('ws://peer.example.com:10001')).to.be.false;
        });

        it('rejects empty string', function () {
            let pm = new PeerManager({ P2P_VALIDATOR_ADDR: 'ws://a:1' }, null);
            pm._connectToPeer('');
            expect(pm.peers.has('')).to.be.false;
        });
    });

    // =================================================================
    // PeerManager — Per-peer rate limiting
    // =================================================================

    describe('PeerManager — Per-peer rate limiting', function () {
        const PeerManager = require('../../src/PeerManager');

        it('allows messages within rate limit', function () {
            let pm = new PeerManager({ P2P_VALIDATOR_ADDR: 'ws://a:1', P2P_MSG_RATE_LIMIT: '10' }, null);
            for (let i = 0; i < 10; i++) {
                expect(pm._checkMsgRate('peer-1')).to.be.true;
            }
        });

        it('rejects messages exceeding rate limit', function () {
            let pm = new PeerManager({ P2P_VALIDATOR_ADDR: 'ws://a:1', P2P_MSG_RATE_LIMIT: '5' }, null);
            for (let i = 0; i < 5; i++) {
                pm._checkMsgRate('peer-1');
            }
            expect(pm._checkMsgRate('peer-1')).to.be.false;
        });

        it('rate limits are per-peer (independent)', function () {
            let pm = new PeerManager({ P2P_VALIDATOR_ADDR: 'ws://a:1', P2P_MSG_RATE_LIMIT: '2' }, null);
            pm._checkMsgRate('peer-1');
            pm._checkMsgRate('peer-1');
            expect(pm._checkMsgRate('peer-1')).to.be.false;
            // peer-2 should still be allowed
            expect(pm._checkMsgRate('peer-2')).to.be.true;
        });
    });

    // =================================================================
    // PeerManager — Invalid JSON logging
    // =================================================================

    describe('PeerManager — Invalid JSON logging', function () {
        const PeerManager = require('../../src/PeerManager');

        it('logs warning for invalid JSON instead of silent discard', function () {
            let pm = new PeerManager({ P2P_VALIDATOR_ADDR: 'ws://a:1', REQUIRE_SIGNATURES: false }, null);
            let warnStub = sinon.stub(console, 'warn');
            let mockWs = { _peerAddr: null };
            pm._handleInbound(mockWs, 'not-json{{{', null);
            expect(warnStub.calledWith(sinon.match('P2P: Invalid JSON'))).to.be.true;
        });
    });

    // =================================================================
    // Consensus — Sequence monotonicity
    // =================================================================

    describe('Consensus — Sequence monotonicity', function () {
        const Consensus = require('../../src/Consensus');

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
                sender: VALIDATORS_4[1].addr,
                data: { seq: 3, configDigest: digest, config: config }
            };
            consensus._handlePrePrepare(envelope);
            expect(consensus.pendingProposals.has(3)).to.be.false;
            expect(warnStub.calledWith(sinon.match(/stale seq/))).to.be.true;
        });

        it('accepts PRE_PREPARE with seq > lastAppliedSeq', function () {
            consensus.lastAppliedSeq = 2;
            let config = { a: 1 };
            let digest = consensus._digest(config);
            let envelope = {
                type: 'PBFT_PRE_PREPARE',
                sender: VALIDATORS_4[0].addr,
                data: { seq: 3, configDigest: digest, config: config }
            };
            consensus._handlePrePrepare(envelope);
            expect(consensus.pendingProposals.has(3)).to.be.true;
            let p = consensus.pendingProposals.get(3);
            if (p.timer) clearTimeout(p.timer);
        });
    });

    // =================================================================
    // Consensus — Minimum quorum warning
    // =================================================================

    describe('Consensus — Minimum quorum warning', function () {
        const Consensus = require('../../src/Consensus');

        it('logs warning when quorum=0 and minValidators > 1', async function () {
            let hub = createMockHub();
            let consensus = new Consensus(hub);
            consensus.minValidators = 3;
            consensus.setValidatorSet([]);
            hub._peerManager.getPeerStatus.returns([]);
            let warnStub = sinon.stub(console, 'warn');
            await consensus.propose({ x: 1 });
            expect(warnStub.calledWith(sinon.match(/single-node mode/))).to.be.true;
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
    });

    // =================================================================
    // OracleConsensus — Minimum submissions
    // =================================================================

    describe('OracleConsensus — Minimum submissions', function () {
        const OracleConsensus = require('../../src/OracleConsensus');

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
            let storeSkipped = sinon.stub(oc, '_storeSkippedRound').resolves();

            await oc.finalizeRound(1);
            expect(storeSkipped.calledOnce).to.be.true;
        });

        it('proceeds when submissions >= minSubmissions', async function () {
            oc.minSubmissions = 1;
            let submissions = new Map();
            submissions.set('v1', { prices: SAMPLE_PRICES, sources: 2, timestamp: Date.now() });
            oracleRound.getSubmissions.returns(submissions);
            let storeSkipped = sinon.stub(oc, '_storeSkippedRound');
            let storeSnapshot = sinon.stub(oc, '_storeSnapshot').resolves();

            await oc.finalizeRound(1);
            expect(storeSkipped.called).to.be.false;
            expect(storeSnapshot.calledOnce).to.be.true;
        });
    });

    // =================================================================
    // OracleConsensus — Price sanity bounds
    // =================================================================

    describe('OracleConsensus — Price sanity bounds', function () {
        const OracleConsensus = require('../../src/OracleConsensus');

        let oc;

        beforeEach(function () {
            let hub = createMockHub();
            oc = new OracleConsensus(hub, { getSubmissions: sinon.stub() });
        });

        it('_aggregate() rejects prices >= 10,000,000', function () {
            let subs = buildSubmissions([
                { sender: 'v1', prices: [{ coinPair: 'BTC/USD', price: '10000000' }] },
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
                { sender: 'v1', prices: [{ coinPair: 'BTC/USD', price: '99999999' }] },
                { sender: 'v2', prices: [{ coinPair: 'BTC/USD', price: '-5' }] }
            ]);
            let result = oc._aggregate(subs, 'BTC/USD');
            expect(result).to.be.null;
        });
    });

    // =================================================================
    // OracleRound — Price validation
    // =================================================================

    describe('OracleRound — Submission validation', function () {
        const OracleRound = require('../../src/OracleRound');

        let hub, oracleRound;

        beforeEach(function () {
            hub = createMockHub();
            hub._peerManager.validatorPubkeys = new Map();
            oracleRound = new OracleRound(hub);
            oracleRound.currentRound = 5;
            oracleRound.roundStartTime = Date.now();
            oracleRound.submissions.set(5, new Map());
        });

        it('filters out invalid prices from submissions', function () {
            let envelope = {
                type: 'ORACLE_PRICE_SUBMIT',
                sender: 'ws://peer-1:10001',
                timestamp: Date.now(),
                data: {
                    round: 5,
                    prices: [
                        { coinPair: 'BTC/USD', price: '100000', sources: 1 },
                        { coinPair: 'LTC/USD', price: '-5', sources: 1 },
                        { coinPair: 'DOGE/USD', price: '99999999', sources: 1 }
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
    });

    // =================================================================
    // CrossChainEngine — Chain validation
    // =================================================================

    describe('CrossChainEngine — Chain validation', function () {
        const CrossChainEngine = require('../../src/CrossChainEngine');

        let hub, pm, engine;

        beforeEach(function () {
            hub = createMockHub();
            pm  = hub._peerManager;
            engine = new CrossChainEngine(hub);
            engine.setValidatorSet([]);
            pm.getPeerStatus.returns([]);
        });

        afterEach(function () {
            for (let [, pending] of engine.pendingAttestations) {
                if (pending.timer) clearTimeout(pending.timer);
            }
        });

        it('requestAttestation throws for invalid sourceChain', async function () {
            try {
                await engine.requestAttestation('ETH', 1, 'BTC');
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.include('Invalid sourceChain');
            }
        });

        it('requestAttestation throws for invalid destChain', async function () {
            try {
                await engine.requestAttestation('BTC', 1, 'XRP');
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.include('Invalid destChain');
            }
        });

        it('requestAttestation throws for non-positive sourceActionIndex', async function () {
            try {
                await engine.requestAttestation('BTC', 0, 'LTC');
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.include('sourceActionIndex');
            }
        });

        it('requestAttestation succeeds for valid parameters', async function () {
            hub.db.doQuery.resolves([]);
            let result = await engine.requestAttestation('BTC', 1, 'LTC');
            expect(result).to.have.property('attestationId', 'BTC:1:LTC');
            expect(result.status).to.equal('attested');
        });

        it('_handlePropose rejects invalid attestation ID format', function () {
            let digest = engine._digest('invalid-format', 3);
            let envelope = {
                sender: 'ws://v:1',
                data: { attestationId: 'invalid-format', digest: digest, confirmations: 3 }
            };
            engine._handlePropose(envelope);
            expect(engine.pendingAttestations.size).to.equal(0);
        });

        it('_handlePropose accepts valid attestation ID format', function () {
            let attestationId = 'BTC:1:LTC';
            let digest = engine._digest(attestationId, 3);
            let envelope = {
                sender: 'ws://v:1',
                data: { attestationId, digest, confirmations: 3, sourceChain: 'BTC', sourceActionIndex: 1, destChain: 'LTC' }
            };
            engine._handlePropose(envelope);
            expect(engine.pendingAttestations.has(attestationId)).to.be.true;
            let p = engine.pendingAttestations.get(attestationId);
            if (p.timer) clearTimeout(p.timer);
        });
    });

    // =================================================================
    // ReorgHandler — Parameter validation and rate limiting
    // =================================================================

    describe('ReorgHandler — Parameter validation', function () {
        const ReorgHandler = require('../../src/ReorgHandler');

        let hub, handler;

        beforeEach(function () {
            hub = createMockHub();
            handler = new ReorgHandler(hub);
            handler.setValidatorSet([]);
            hub._peerManager.getPeerStatus.returns([]);
        });

        afterEach(function () {
            for (let [, pending] of handler.pendingReorgs) {
                if (pending.timer) clearTimeout(pending.timer);
            }
        });

        it('reportReorg throws for invalid chain', async function () {
            try {
                await handler.reportReorg('ETH', 100, Date.now());
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.include('Invalid chain');
            }
        });

        it('reportReorg throws for negative reorgHeight', async function () {
            try {
                await handler.reportReorg('BTC', -5, Date.now());
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.include('non-negative integer');
            }
        });

        it('reportReorg throws for future timestamp beyond 5 minutes', async function () {
            let futureTs = Date.now() + 400000;
            try {
                await handler.reportReorg('BTC', 100, futureTs);
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.include('future');
            }
        });

        it('reportReorg rate limits per chain (1 per 60s)', async function () {
            handler.reorgRateTracker.set('BTC', Date.now());
            try {
                await handler.reportReorg('BTC', 100, Date.now());
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.include('Rate limit');
            }
        });

        it('reportReorg allows different chains within rate limit window', async function () {
            handler.reorgRateTracker.set('BTC', Date.now());
            hub.db.doQuery.resolves([]);
            // LTC should succeed since it has no rate limit entry
            await handler.reportReorg('LTC', 100, Date.now());
            // Should not throw
        });

        it('reportReorg succeeds with valid parameters', async function () {
            hub.db.doQuery.resolves([]);
            await handler.reportReorg('BTC', 100, Date.now());
            // Should not throw
        });
    });

    // =================================================================
    // Governance — Voter authorization
    // =================================================================

    describe('Governance — Voter authorization', function () {
        const Governance = require('../../src/Governance');

        let hub, gov;

        beforeEach(function () {
            hub = createMockHub();
            gov = new Governance(hub);
            gov.setValidatorSet(VALIDATORS_3);
        });

        afterEach(function () {
            if (gov._tallyTimer) clearInterval(gov._tallyTimer);
        });

        it('vote() throws when voter is not an active validator', async function () {
            hub._identity.getPubkeyHex.returns('ff'.repeat(32));
            hub.db.doQuery.resolves([{
                proposal_id: 'p1', status: 'voting',
                voting_end: new Date(Date.now() + 86400000).toISOString()
            }]);
            try {
                await gov.vote('p1', 'approve');
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.include('not an active validator');
            }
        });

        it('vote() succeeds when voter is a validator', async function () {
            hub._identity.getPubkeyHex.returns(VALIDATORS_3[0].pubkey);
            hub.db.doQuery
                .onFirstCall().resolves([{
                    proposal_id: 'p1', status: 'voting',
                    voting_end: new Date(Date.now() + 86400000).toISOString()
                }])
                .onSecondCall().resolves([]);
            let result = await gov.vote('p1', 'approve');
            expect(result.vote).to.equal('approve');
        });
    });

    // =================================================================
    // Governance — Length limits
    // =================================================================

    describe('Governance — Length limits', function () {
        const Governance = require('../../src/Governance');

        let hub, gov;

        beforeEach(function () {
            hub = createMockHub();
            gov = new Governance(hub);
            gov.setValidatorSet(VALIDATORS_3);
            hub._identity.getPubkeyHex.returns(VALIDATORS_3[0].pubkey);
        });

        afterEach(function () {
            if (gov._tallyTimer) clearInterval(gov._tallyTimer);
        });

        it('propose() throws when parameter name > 255 chars', async function () {
            try {
                await gov.propose('x'.repeat(256), '1', '2', 'rationale');
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.include('255');
            }
        });

        it('propose() throws when rationale > 2000 chars', async function () {
            hub.db.doQuery.resolves([]);
            try {
                await gov.propose('SOME_PARAM', '1', '2', 'x'.repeat(2001));
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.include('2000');
            }
        });

        it('propose() accepts parameter name at 255 chars', async function () {
            hub.db.doQuery.resolves([]);
            let result = await gov.propose('x'.repeat(255), '100', '110', 'reason');
            expect(result).to.have.property('proposalId');
        });
    });

    // =================================================================
    // RewardTracker — Participant validation
    // =================================================================

    describe('RewardTracker — Participant validation', function () {
        const RewardTracker = require('../../src/RewardTracker');

        let hub, rt;

        beforeEach(function () {
            hub = createMockHub();
            hub.p2pConfig = { ORACLE_REWARD_PER_ROUND: '10.00000000' };
            rt = new RewardTracker(hub);
        });

        it('skips invalid pubkey formats', async function () {
            let participants = ['not-hex', '00'.repeat(32), 'zz'.repeat(32)];
            await rt.distributeRewards(1, participants);
            // Only '00'.repeat(32) is valid 64-hex
            expect(hub.db.doQuery.callCount).to.equal(1);
            expect(hub.db.doQuery.getCall(0).args[1][0]).to.equal('00'.repeat(32));
        });

        it('returns early with no valid participants', async function () {
            await rt.distributeRewards(1, ['not-hex', 'short']);
            expect(hub.db.doQuery.callCount).to.equal(0);
        });

        it('throws for invalid reward amount', async function () {
            rt.rewardPerRound = 'NaN';
            try {
                await rt.distributeRewards(1, ['00'.repeat(32)]);
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.include('Invalid reward amount');
            }
        });

        it('throws for negative reward amount', async function () {
            rt.rewardPerRound = '-5';
            try {
                await rt.distributeRewards(1, ['00'.repeat(32)]);
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.include('Invalid reward amount');
            }
        });
    });

    // =================================================================
    // SlashDetector — Input validation
    // =================================================================

    describe('SlashDetector — Input validation', function () {
        const SlashDetector = require('../../src/SlashDetector');

        let hub, sd;

        beforeEach(function () {
            hub = createMockHub();
            hub.p2pConfig = { SLASH_DEVIATION_THRESHOLD: '0.05', SLASH_MISSED_ROUNDS_THRESHOLD: '30' };
            sd = new SlashDetector(hub);
        });

        it('skips slash proposal for invalid pubkey format', async function () {
            await sd._recordSlashProposal('invalid', 'price_deviation', 1, '{}');
            expect(hub.db.doQuery.callCount).to.equal(0);
        });

        it('records slash proposal for valid pubkey format', async function () {
            await sd._recordSlashProposal('aa'.repeat(32), 'price_deviation', 1, '{}');
            expect(hub.db.doQuery.callCount).to.equal(1);
        });

        it('bounds deviation tracking array per validator', function () {
            let pubkey = 'bb'.repeat(32);
            // Fill with 1001 deviations (all recent, within 24h)
            let deviations = [];
            for (let i = 0; i < 1001; i++) {
                deviations.push({ round: i, timestamp: Date.now() });
            }
            sd.recentDeviations.set(pubkey, deviations);
            sd._trackDeviation(pubkey, 1002);
            expect(sd.recentDeviations.get(pubkey).length).to.be.at.most(1000);
        });
    });

    // =================================================================
    // XChainHub — Config structure validation
    // =================================================================

    describe('XChainHub — Config structure validation', function () {
        // Use proxyquire to get XChainHub without real DB
        let XChainHub;

        before(function () {
            XChainHub = proxyquire('../../src/XChainHub', {
                './db.js': function () {
                    return {
                        createDatabase: sinon.stub().resolves(),
                        verifyTables: sinon.stub().resolves(),
                        setParam: sinon.stub().resolves(),
                        doQuery: sinon.stub().resolves([]),
                        getAllConfigs: sinon.stub().resolves({}),
                        close: sinon.stub().resolves()
                    };
                }
            });
        });

        it('applyConfig() throws when config is a string', async function () {
            let h = new XChainHub('h', 3306, 'db', 'u', 'p');
            await h.start();
            try {
                await h.applyConfig('string-value');
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.include('non-null object');
            }
        });

        it('applyConfig() throws when config is null', async function () {
            let h = new XChainHub('h', 3306, 'db', 'u', 'p');
            await h.start();
            try {
                await h.applyConfig(null);
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.include('non-null object');
            }
        });

        it('applyConfig() throws when config is an array', async function () {
            let h = new XChainHub('h', 3306, 'db', 'u', 'p');
            await h.start();
            try {
                await h.applyConfig([1, 2, 3]);
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.include('non-null object');
            }
        });

        it('applyConfig() throws when value exceeds 1024 chars', async function () {
            let h = new XChainHub('h', 3306, 'db', 'u', 'p');
            await h.start();
            let config = { BTC: { mainnet: { indexer: { host: 'x'.repeat(1025) } } } };
            try {
                await h.applyConfig(config);
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.include('1024');
            }
        });

        it('applyConfig() coerces non-string values to strings', async function () {
            let h = new XChainHub('h', 3306, 'db', 'u', 'p');
            await h.start();
            let config = { BTC: { mainnet: { indexer: { port: 8080 } } } };
            await h.applyConfig(config);
            expect(h.db.setParam.calledWith('BTC', 'mainnet', 'indexer', 'port', '8080')).to.be.true;
        });

        it('applyConfig() accepts valid config', async function () {
            let h = new XChainHub('h', 3306, 'db', 'u', 'p');
            await h.start();
            let config = { BTC: { mainnet: { indexer: { host: 'localhost', port: '8080' } } } };
            await h.applyConfig(config);
            expect(h.db.setParam.callCount).to.equal(2);
        });

        it('applyConfig() ignores non-object nested levels', async function () {
            let h = new XChainHub('h', 3306, 'db', 'u', 'p');
            await h.start();
            let config = { BTC: 'invalid' };
            await h.applyConfig(config);
            expect(h.db.setParam.callCount).to.equal(0);
        });
    });

    // =================================================================
    // PriceFetcher — Response validation
    // =================================================================

    describe('PriceFetcher — Response validation', function () {
        const PriceFetcher = require('../../src/PriceFetcher');

        it('rejects prices >= 10,000,000 from CoinGecko', async function () {
            let pf = new PriceFetcher({ COINGECKO_API_KEY: '', PRICE_FETCH_TIMEOUT: 5000 });
            let axios = require('axios');
            sinon.stub(axios, 'get').resolves({
                data: {
                    bitcoin: { usd: 99999999 },
                    litecoin: { usd: 85 },
                    dogecoin: { usd: 0.15 }
                }
            });
            let result = await pf.fetchFromCoinGecko();
            expect(result['BTC/USD']).to.be.undefined;
            expect(result['LTC/USD']).to.equal(85);
            expect(result['DOGE/USD']).to.equal(0.15);
        });

        it('rejects negative prices from CoinGecko', async function () {
            let pf = new PriceFetcher({ COINGECKO_API_KEY: '', PRICE_FETCH_TIMEOUT: 5000 });
            let axios = require('axios');
            sinon.stub(axios, 'get').resolves({
                data: {
                    bitcoin: { usd: -100 },
                    litecoin: { usd: 85 },
                    dogecoin: { usd: 0 }
                }
            });
            let result = await pf.fetchFromCoinGecko();
            expect(result['BTC/USD']).to.be.undefined;
            expect(result['LTC/USD']).to.equal(85);
            expect(result['DOGE/USD']).to.be.undefined;
        });

        it('handles null data in CoinGecko response', async function () {
            let pf = new PriceFetcher({ COINGECKO_API_KEY: '', PRICE_FETCH_TIMEOUT: 5000 });
            let axios = require('axios');
            sinon.stub(axios, 'get').resolves({
                data: { bitcoin: null, litecoin: { usd: 85 } }
            });
            let result = await pf.fetchFromCoinGecko();
            expect(result['BTC/USD']).to.be.undefined;
            expect(result['LTC/USD']).to.equal(85);
        });
    });

    // =================================================================
    // db — Query timeout configuration
    // =================================================================

    describe('db — Query timeout configuration', function () {

        it('connectionPoolParams includes queryTimeout', function () {
            let mockPool = { getConnection: sinon.stub(), end: sinon.stub() };
            let mariadbStub = { createPool: sinon.stub().returns(mockPool) };
            let Database = proxyquire('../../src/db', { 'mariadb': mariadbStub });

            let origEnv = process.env.DB_QUERY_TIMEOUT;
            process.env.DB_QUERY_TIMEOUT = '45000';
            let db = new Database('host', 3306, 'testdb', 'user', 'pass');
            let poolArgs = mariadbStub.createPool.getCall(0).args[0];
            expect(poolArgs.queryTimeout).to.equal(45000);
            if (origEnv === undefined) delete process.env.DB_QUERY_TIMEOUT;
            else process.env.DB_QUERY_TIMEOUT = origEnv;
        });

        it('connectionPoolParams defaults queryTimeout to 30000', function () {
            let mockPool = { getConnection: sinon.stub(), end: sinon.stub() };
            let mariadbStub = { createPool: sinon.stub().returns(mockPool) };
            let Database = proxyquire('../../src/db', { 'mariadb': mariadbStub });

            let origEnv = process.env.DB_QUERY_TIMEOUT;
            delete process.env.DB_QUERY_TIMEOUT;
            let db = new Database('host', 3306, 'testdb', 'user', 'pass');
            let poolArgs = mariadbStub.createPool.getCall(0).args[0];
            expect(poolArgs.queryTimeout).to.equal(30000);
            if (origEnv !== undefined) process.env.DB_QUERY_TIMEOUT = origEnv;
        });
    });

    // =================================================================
    // db — Object serialization warning
    // =================================================================

    describe('db — Object serialization in doQuery', function () {

        it('serializes objects with JSON.stringify instead of toString', async function () {
            let mockPool = {
                getConnection: sinon.stub().resolves({
                    query: sinon.stub().resolves([]),
                    release: sinon.stub()
                }),
                end: sinon.stub()
            };
            let mariadbStub = { createPool: sinon.stub().returns(mockPool) };
            let Database = proxyquire('../../src/db', { 'mariadb': mariadbStub });
            let db = new Database('host', 3306, 'testdb', 'user', 'pass');

            let warnStub = sinon.stub(console, 'warn');
            let obj = { key: 'value' };
            await db.doQuery('SELECT ?', [obj]);

            expect(warnStub.calledWith(sinon.match('object arg serialized'))).to.be.true;

            let conn = await mockPool.getConnection();
            let queryCall = conn.query.getCall(0);
            expect(queryCall.args[1][0]).to.equal(JSON.stringify(obj));
        });
    });

    // =================================================================
    // API — Input validation helpers
    // =================================================================

    describe('API — Input validation helpers', function () {
        // We test the validation functions by capturing the controller via proxyquire
        let controller;

        before(async function () {
            let mockApp = {
                use: sinon.stub(),
                listen: sinon.stub().callsFake((port, host, cb) => { if (cb) cb(); })
            };
            let mockExpress = sinon.stub().returns(mockApp);
            mockExpress.json = sinon.stub().returns(sinon.stub());

            let mockHub = {
                start: sinon.stub().resolves(),
                startP2P: sinon.stub().resolves(),
                startConsensus: sinon.stub().resolves(),
                startOracle: sinon.stub().resolves(),
                startCrossChain: sinon.stub().resolves(),
                startReorgHandler: sinon.stub().resolves(),
                startGovernance: sinon.stub().resolves(),
                getPriceSnapshots: sinon.stub().resolves([]),
                getPrice: sinon.stub().resolves(null),
                getFeeQuote: sinon.stub().resolves({}),
                getOracle: sinon.stub().returns(null),
                getCrossChain: sinon.stub().returns(null),
                getAllConfigs: sinon.stub().resolves({}),
                getValidators: sinon.stub().resolves([]),
                getReorgHistory: sinon.stub().resolves([]),
                getSwaps: sinon.stub().resolves([]),
                reportReorg: sinon.stub().resolves()
            };

            let capturedMethods;
            let jsonRouterStub = function ({ methods }) {
                capturedMethods = methods;
                return sinon.stub();
            };

            // Set required env vars temporarily
            let origEnv = {};
            let requiredVars = {
                HUB_DB_HOST: 'localhost', HUB_DB_PORT: '3306', HUB_DB_NAME: 'testdb',
                HUB_DB_USER: 'root', HUB_DB_PASS: 'pass', HUB_PORT: '9999'
            };
            for (let [k, v] of Object.entries(requiredVars)) {
                origEnv[k] = process.env[k];
                process.env[k] = v;
            }

            try {
                proxyquire('../../src/api', {
                    'dotenv': { config: sinon.stub() },
                    'express': mockExpress,
                    'helmet': sinon.stub().returns(sinon.stub()),
                    'cors': sinon.stub().returns(sinon.stub()),
                    'express-rate-limit': sinon.stub().returns(sinon.stub()),
                    'express-json-rpc-router': jsonRouterStub,
                    './XChainHub': function () { return mockHub; }
                });
            } finally {
                for (let [k, v] of Object.entries(origEnv)) {
                    if (v === undefined) delete process.env[k];
                    else process.env[k] = v;
                }
            }

            // Wait for async startApi() to complete
            await new Promise(resolve => setTimeout(resolve, 100));

            controller = capturedMethods;
        });

        it('getfeequote rejects invalid chain', async function () {
            let result = await controller.getfeequote({ action: 'ISSUE', chain: 'ETH' });
            expect(result.error).to.include('BTC');
        });

        it('getfeequote accepts valid chain', async function () {
            let result = await controller.getfeequote({ action: 'ISSUE', chain: 'BTC' });
            expect(result.error).to.be.undefined;
        });

        it('getpricesnapshots rejects negative limit', async function () {
            let result = await controller.getpricesnapshots({ limit: -5 });
            expect(result.error).to.include('limit');
        });

        it('getpricesnapshots rejects limit > 1000', async function () {
            let result = await controller.getpricesnapshots({ limit: 1001 });
            expect(result.error).to.include('limit');
        });

        it('getpricesnapshots accepts limit = 1000', async function () {
            let result = await controller.getpricesnapshots({ limit: 1000 });
            expect(result).to.be.an('array');
        });

        it('getpricesnapshots accepts no limit (defaults)', async function () {
            let result = await controller.getpricesnapshots({});
            expect(result).to.be.an('array');
        });

        it('reportreorg rejects invalid chain', async function () {
            let result = await controller.reportreorg({ chain: 'ETH', reorg_height: '100', timestamp: String(Date.now()) });
            expect(result.error).to.include('BTC');
        });

        it('reportreorg rejects negative reorg_height', async function () {
            let result = await controller.reportreorg({ chain: 'BTC', reorg_height: '-1', timestamp: String(Date.now()) });
            expect(result.error).to.include('non-negative integer');
        });

        it('getreorghistory rejects limit > 1000', async function () {
            let result = await controller.getreorghistory({ limit: 5000 });
            expect(result.error).to.include('limit');
        });

        it('requestattestation rejects invalid source_chain', async function () {
            let result = await controller.requestattestation({ source_chain: 'ETH', source_action_index: 1, dest_chain: 'BTC' });
            expect(result.error).to.include('BTC');
        });

        it('initiateswap rejects invalid dest_chain', async function () {
            let result = await controller.initiateswap({ source_chain: 'BTC', source_action_index: 1, dest_chain: 'ETH' });
            expect(result.error).to.include('BTC');
        });
    });
});
