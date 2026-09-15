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
const { VALIDATORS_4, pubkeyForTestSender } = require('../helpers/fixtures');

function registerAttestationIdTests(getEngine) {
    it('_handlePropose rejects invalid attestation ID format', function () {
        let engine = getEngine();
        let digest = engine._digest('invalid-format', 3);
        let envelope = {
            sender: 'ws://v:1',
            data: { attestationId: 'invalid-format', digest: digest, confirmations: 3 }
        };
        engine._handlePropose(envelope);
        expect(engine.pendingAttestations.size).to.equal(0);
    });

    it('_handlePropose accepts valid attestation ID format', async function () {
        let engine = getEngine();
        // A follower now also verifies the proposed source action against its own
        // indexer before co-signing (anti-forgery hardening). That path has its own
        // coverage; here we stub it true to exercise the format-acceptance branch this
        // test targets, mirroring the '_handlePropose rejects invalid format' twin above.
        sinon.stub(engine, 'verifySourceAction').resolves(true);
        // A follower also refuses to PREPARE over a 0 quorum (empty cross_chain
        // snapshot / bootstrap fail-closed guard). The mock has no chain-pair set
        // or peers, so resolveQuorum would return 0; stub a real federation
        // quorum so this test exercises the accept branch, not the 0-quorum guard.
        sinon.stub(engine, 'resolveQuorum').resolves(3);
        let attestationId = 'BTC:1:LTC';
        let digest = engine._digest(attestationId, 3);
        let envelope = {
            sender: 'ws://v:1',
            sig_pubkey: pubkeyForTestSender('ws://v:1'),
            data: { attestationId, digest, confirmations: 3, sourceChain: 'BTC', sourceActionIndex: 1, destChain: 'LTC' }
        };
        await engine._handlePropose(envelope);
        expect(engine.pendingAttestations.has(attestationId)).to.be.true;
        let p = engine.pendingAttestations.get(attestationId);
        if (p.timer) clearTimeout(p.timer);
    });
}

// =================================================================
// CrossChainEngine: Chain validation
// =================================================================
function chainValidationSuite() {
        const CrossChainEngine = require('../../src/cross_chain/engine');

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

        registerAttestationIdTests(() => engine);
    }

function registerAcceptedReorgTests(getHub, getHandler) {
    it('reportReorg allows different chains within rate limit window', async function () {
        let hub = getHub();
        let handler = getHandler();
        handler.reorgRateTracker.set('BTC', Date.now());
        hub.db.doQuery.resolves([]);
        // LTC should succeed since it has no rate limit entry
        await handler.reportReorg('LTC', 100, Date.now(), 'a'.repeat(64), 'b'.repeat(64));
        // Should not throw
    });

    it('reportReorg succeeds with valid parameters', async function () {
        let hub = getHub();
        let handler = getHandler();
        hub.db.doQuery.resolves([]);
        await handler.reportReorg('BTC', 100, Date.now(), 'a'.repeat(64), 'b'.repeat(64));
        // Should not throw
    });

    it('reportReorg refuses a report the own indexer does not confirm', async function () {
        let handler = getHandler();
        handler.verifyReorgAgainstOwnNode.resolves(false);
        try {
            await handler.reportReorg('DOGE', 100, Date.now(), 'a'.repeat(64), 'b'.repeat(64));
            expect.fail('should have thrown');
        } catch (e) {
            expect(e.message).to.include('own indexer does not confirm');
        }
    });

    it('reportReorg requires a distinct 64-hex observed hash pair', async function () {
        let handler = getHandler();
        try {
            await handler.reportReorg('DOGE', 100, Date.now());
            expect.fail('should have thrown');
        } catch (e) {
            expect(e.message).to.include('distinct 64-hex');
        }
    });
}

// =================================================================
// ReorgHandler: Parameter validation and rate limiting
// =================================================================
function reorgValidationSuite() {
        const ReorgHandler = require('../../src/anchor/reorg_handler');

        let hub, handler;

        beforeEach(function () {
            hub = createMockHub();
            handler = new ReorgHandler(hub);
            handler.setValidatorSet([]);
            hub._peerManager.getPeerStatus.returns([]);
            sinon.stub(handler, 'verifyReorgAgainstOwnNode').resolves(true);
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
                await handler.reportReorg('BTC', 100, Date.now(), 'a'.repeat(64), 'b'.repeat(64));
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.include('Rate limit');
            }
        });

        registerAcceptedReorgTests(() => hub, () => handler);
    }

function registerCrossChainMembershipTests(CrossChainEngine, Consensus, hubWithRegistry, unknown) {
    it('CrossChainEngine.handlePrepare does not count votes from unregistered senders', function () {
        let hub = hubWithRegistry();
        let engine = new CrossChainEngine(hub);
        engine.setValidatorSet(VALIDATORS_4);
        let attestationId = 'BTC:1:LTC';
        let digest = engine._digest(attestationId, 6);
        engine.pendingAttestations.set(attestationId, {
            attestationId, digest, prepares: new Set(), commits: new Set(),
            quorum: 3, finalized: false, timer: null
        });
        engine.handlePrepare({ sender: unknown, data: { attestationId, digest } });
        expect(engine.pendingAttestations.get(attestationId).prepares.size).to.equal(0);
    });

    it('Consensus.handlePrepare still counts votes from registered senders', function () {
        let hub = hubWithRegistry();
        let consensus = new Consensus(hub);
        consensus.setValidatorSet(VALIDATORS_4);
        let config = { a: 1 };
        let digest = consensus._digest(config);
        consensus.pendingProposals.set(1, {
            config, digest, prepares: new Set(), commits: new Set(),
            quorum: 3, resolved: false, applied: false, timer: null
        });
        consensus.handlePrepare({ sender: VALIDATORS_4[1].addr, sig_pubkey: VALIDATORS_4[1].pubkey, data: { seq: 1, configDigest: digest } });
        expect(consensus.pendingProposals.get(1).prepares.has(VALIDATORS_4[1].addr)).to.be.true;
    });
}

// =================================================================
// Consensus engines: sender-membership guard (anti quorum-inflation)
// =================================================================
function senderMembershipSuite() {
        const Consensus       = require('../../src/consensus/pbft');
        const OracleConsensus = require('../../src/oracle/consensus');
        const CrossChainEngine = require('../../src/cross_chain/engine');

        // Populate the peer registry so the guard is active, then inject a
        // PREPARE from a sender that is NOT a registered validator and assert the
        // quorum counter never moves. This is the fake-sender quorum-inflation
        // path: counting raw envelope.sender values would otherwise let one
        // connection drive quorum with fabricated identities.
        function hubWithRegistry() {
            let hub = createMockHub();
            hub._peerManager.validatorPubkeys = new Map(VALIDATORS_4.map(v => [v.addr, v.pubkey]));
            return hub;
        }

        const UNKNOWN = 'ws://attacker:9';

        it('Consensus.handlePrepare does not count votes from unregistered senders', function () {
            let hub = hubWithRegistry();
            let consensus = new Consensus(hub);
            consensus.setValidatorSet(VALIDATORS_4);
            let config = { a: 1 };
            let digest = consensus._digest(config);
            consensus.pendingProposals.set(1, {
                config, digest, prepares: new Set(), commits: new Set(),
                quorum: 3, resolved: false, applied: false, timer: null
            });
            consensus.handlePrepare({ sender: UNKNOWN, data: { seq: 1, configDigest: digest } });
            expect(consensus.pendingProposals.get(1).prepares.size).to.equal(0);
        });

        it('OracleConsensus.handlePrepare does not count votes from unregistered senders', function () {
            let hub = hubWithRegistry();
            let oc = new OracleConsensus(hub, { getSubmissions: sinon.stub() });
            oc.setValidatorSet(VALIDATORS_4);
            let digest = 'd1';
            oc.pendingRounds.set(1, {
                round: 1, digest, prices: [], btcBlockTime: 0,
                prepares: new Set(), commits: new Set(), signatures: new Map(),
                quorum: 3, finalized: false, timer: null
            });
            oc.handlePrepare({ sender: UNKNOWN, data: { round: 1, digest } });
            expect(oc.pendingRounds.get(1).prepares.size).to.equal(0);
        });

        registerCrossChainMembershipTests(CrossChainEngine, Consensus, hubWithRegistry, UNKNOWN);
    }

function securityHardeningSuite() {
    afterEach(function () {
        sinon.restore();
    });
    describe('CrossChainEngine: Chain validation', chainValidationSuite);
    describe('Consensus engines: sender-membership guard', senderMembershipSuite);
    describe('ReorgHandler: Parameter validation', reorgValidationSuite);
}

describe('Security Hardening', securityHardeningSuite);
