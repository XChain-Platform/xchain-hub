'use strict';

const sinon              = require('sinon');
const { expect }         = require('chai');
const CrossChainEngine   = require('../../src/CrossChainEngine');
const { createMockHub }  = require('../helpers/mockHub');
const { VALIDATORS_3, VALIDATORS_4, VALIDATORS_7, makeValidator } = require('../helpers/fixtures');

describe('CrossChainEngine', function () {

    let hub, pm, engine;

    beforeEach(function () {
        hub    = createMockHub();
        pm     = hub._peerManager;
        engine = new CrossChainEngine(hub);
    });

    afterEach(function () {
        for (let [, pending] of engine.pendingAttestations) {
            if (pending.timer) clearTimeout(pending.timer);
        }
        sinon.restore();
    });

    // -----------------------------------------------------------------
    // _getChainPairSet()
    // -----------------------------------------------------------------

    describe('_getChainPairSet()', function () {
        it('returns chain-pair-specific validators when available', function () {
            let pairValidators = [makeValidator(1), makeValidator(2)];
            engine.chainPairValidators = new Map([['BTC-LTC', pairValidators]]);
            engine.setValidatorSet(VALIDATORS_7);

            let set = engine._getChainPairSet('BTC', 'LTC');
            expect(set).to.equal(pairValidators);
        });

        it('checks reverse key ordering', function () {
            let pairValidators = [makeValidator(1)];
            engine.chainPairValidators = new Map([['LTC-BTC', pairValidators]]);

            let set = engine._getChainPairSet('BTC', 'LTC');
            expect(set).to.equal(pairValidators);
        });

        it('falls back to full validator set when no chain-pair set', function () {
            engine.setValidatorSet(VALIDATORS_3);
            engine.chainPairValidators = new Map();

            let set = engine._getChainPairSet('BTC', 'DOGE');
            expect(set).to.equal(VALIDATORS_3);
        });

        it('falls back when chain-pair set is empty', function () {
            engine.chainPairValidators = new Map([['BTC-DOGE', []]]);
            engine.setValidatorSet(VALIDATORS_3);

            let set = engine._getChainPairSet('BTC', 'DOGE');
            expect(set).to.equal(VALIDATORS_3);
        });
    });

    // -----------------------------------------------------------------
    // _getQuorum()
    // -----------------------------------------------------------------

    describe('_getQuorum()', function () {
        it('uses chain-pair validator count for per-pair quorum', function () {
            engine.chainPairValidators = new Map([
                ['BTC-LTC', [makeValidator(1), makeValidator(2), makeValidator(3)]]
            ]);
            engine.setValidatorSet(VALIDATORS_7);
            // Per-pair: N=3 → f=floor(2/3)=0, quorum=1
            expect(engine._getQuorum('BTC', 'LTC')).to.equal(1);
        });

        it('falls back to full set quorum without chain params', function () {
            engine.setValidatorSet(VALIDATORS_4);
            // N=4 → quorum=3
            expect(engine._getQuorum()).to.equal(3);
        });

        it('single validator → quorum 0', function () {
            engine.setValidatorSet([makeValidator(1)]);
            expect(engine._getQuorum()).to.equal(0);
        });
    });

    // -----------------------------------------------------------------
    // _getLeader()
    // -----------------------------------------------------------------

    describe('_getLeader()', function () {
        it('rotates through validators by seq % N', function () {
            engine.setValidatorSet(VALIDATORS_3);
            expect(engine._getLeader(0, null, null)).to.equal(VALIDATORS_3[0]);
            expect(engine._getLeader(1, null, null)).to.equal(VALIDATORS_3[1]);
            expect(engine._getLeader(3, null, null)).to.equal(VALIDATORS_3[0]);
        });

        it('uses chain-pair set for leader selection', function () {
            let pairSet = [makeValidator(5), makeValidator(6)];
            engine.chainPairValidators = new Map([['BTC-LTC', pairSet]]);
            engine.setValidatorSet(VALIDATORS_7);

            expect(engine._getLeader(0, 'BTC', 'LTC')).to.equal(pairSet[0]);
            expect(engine._getLeader(1, 'BTC', 'LTC')).to.equal(pairSet[1]);
        });

        it('returns null for empty set', function () {
            engine.setValidatorSet([]);
            expect(engine._getLeader(0, null, null)).to.be.null;
        });
    });

    // -----------------------------------------------------------------
    // _digest()
    // -----------------------------------------------------------------

    describe('_digest()', function () {
        it('returns 64-char hex hash', function () {
            let d = engine._digest('BTC:1:LTC', 3);
            expect(d).to.match(/^[0-9a-f]{64}$/);
        });

        it('is deterministic', function () {
            expect(engine._digest('X', 3)).to.equal(engine._digest('X', 3));
        });

        it('different inputs produce different digests', function () {
            expect(engine._digest('X', 3)).to.not.equal(engine._digest('Y', 3));
        });
    });

    // -----------------------------------------------------------------
    // requestAttestation() — single-node fallback
    // -----------------------------------------------------------------

    describe('requestAttestation()', function () {

        it('single-node stores attestation directly', async function () {
            engine.setValidatorSet([]);
            pm.getPeerStatus.returns([]);

            let result = await engine.requestAttestation('BTC', 42, 'LTC');
            expect(result.attestationId).to.equal('BTC:42:LTC');
            expect(result.confirmations).to.equal(3); // BTC default
            expect(result.status).to.equal('attested');
            expect(hub.db.doQuery.called).to.be.true;
        });

        it('returns stored attestation if already finalized', async function () {
            engine.finalized.add('BTC:42:LTC');
            hub.db.doQuery.resolves([{ attestation_id: 'BTC:42:LTC', status: 'attested' }]);

            let result = await engine.requestAttestation('BTC', 42, 'LTC');
            expect(result.attestation_id).to.equal('BTC:42:LTC');
        });

        it('uses correct confirmation counts per chain', async function () {
            engine.setValidatorSet([]);
            pm.getPeerStatus.returns([]);

            let btc = await engine.requestAttestation('BTC', 1, 'LTC');
            expect(btc.confirmations).to.equal(3);

            let doge = await engine.requestAttestation('DOGE', 1, 'BTC');
            expect(doge.confirmations).to.equal(6);
        });

        it('throws when not the leader in multi-node mode', async function () {
            engine.setValidatorSet(VALIDATORS_3);
            pm.validatorAddr = 'ws://not-in-set:10001';

            try {
                await engine.requestAttestation('BTC', 1, 'LTC');
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.include('Not the leader');
            }
        });
    });

    // -----------------------------------------------------------------
    // PBFT attestation flow
    // -----------------------------------------------------------------

    describe('PBFT attestation flow', function () {

        beforeEach(function () {
            // Use VALIDATORS_4 (quorum=3) to prevent auto-completion
            engine.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
        });

        it('PROPOSE from peer creates pending and broadcasts PREPARE', function () {
            let attestationId = 'BTC:1:LTC';
            let digest = engine._digest(attestationId, 3);

            engine._handlePropose({
                sender: VALIDATORS_4[1].addr,
                data: { attestationId, sourceChain: 'BTC', sourceActionIndex: 1,
                        destChain: 'LTC', confirmations: 3, digest }
            });

            expect(engine.pendingAttestations.has(attestationId)).to.be.true;
            let pending = engine.pendingAttestations.get(attestationId);
            expect(pending.prepares.has(VALIDATORS_4[1].addr)).to.be.true;
            expect(pending.prepares.has(pm.validatorAddr)).to.be.true;
            // N=4, quorum=3, have 2 prepares → PREPARE broadcast but no COMMIT yet
            expect(pm.broadcast.calledOnce).to.be.true;
            expect(pm.broadcast.getCall(0).args[0]).to.equal('XCHAIN_ATTEST_PREPARE');

            if (pending.timer) clearTimeout(pending.timer);
        });

        it('PROPOSE with wrong digest is rejected', function () {
            engine._handlePropose({
                sender: VALIDATORS_4[1].addr,
                data: { attestationId: 'BTC:1:LTC', digest: 'wrong', confirmations: 3 }
            });
            expect(engine.pendingAttestations.size).to.equal(0);
        });

        it('PREPARE quorum triggers COMMIT', function () {
            let attestationId = 'BTC:1:LTC';
            let digest = engine._digest(attestationId, 3);

            // N=4, quorum=3. Start with 2 prepares
            engine.pendingAttestations.set(attestationId, {
                attestationId, sourceChain: 'BTC', sourceActionIndex: 1,
                destChain: 'LTC', confirmations: 3, digest,
                prepares: new Set([VALIDATORS_4[0].addr, VALIDATORS_4[1].addr]),
                commits: new Set(), finalized: false, timer: null,
                resolve: null, reject: null
            });

            // Third prepare → quorum met
            engine._handlePrepare({
                sender: VALIDATORS_4[2].addr,
                data: { attestationId, digest }
            });

            expect(pm.broadcast.called).to.be.true;
            expect(pm.broadcast.getCall(0).args[0]).to.equal('XCHAIN_ATTEST_COMMIT');
        });

        it('COMMIT quorum stores attestation and emits event', async function () {
            let attestationId = 'BTC:1:LTC';
            let digest = engine._digest(attestationId, 3);

            let emitted = null;
            engine.on('attestation:finalized', (a) => { emitted = a; });

            let resolvedValue = null;
            // N=4, quorum=3. Start with 2 commits
            engine.pendingAttestations.set(attestationId, {
                attestationId, sourceChain: 'BTC', sourceActionIndex: 1,
                destChain: 'LTC', confirmations: 3, digest,
                prepares: new Set([VALIDATORS_4[0].addr, VALIDATORS_4[1].addr, VALIDATORS_4[2].addr]),
                commits: new Set([VALIDATORS_4[0].addr, VALIDATORS_4[1].addr]),
                finalized: false, timer: null, _commitSent: true,
                resolve: (v) => { resolvedValue = v; },
                reject: () => {}
            });

            // Third commit → quorum met
            engine._handleCommit({
                sender: VALIDATORS_4[2].addr,
                data: { attestationId, digest }
            });

            await new Promise(r => setTimeout(r, 20));

            expect(hub.db.doQuery.called).to.be.true;
            expect(emitted).to.not.be.null;
            expect(emitted.attestationId).to.equal(attestationId);
            expect(emitted.status).to.equal('attested');
            expect(resolvedValue).to.not.be.null;
            expect(engine.finalized.has(attestationId)).to.be.true;
        });

        it('already-finalized attestation is ignored', function () {
            engine.finalized.add('BTC:1:LTC');
            engine._handlePropose({
                sender: VALIDATORS_4[1].addr,
                data: { attestationId: 'BTC:1:LTC', digest: 'x', confirmations: 3 }
            });
            expect(engine.pendingAttestations.size).to.equal(0);
        });
    });

    // -----------------------------------------------------------------
    // Query methods
    // -----------------------------------------------------------------

    describe('getAttestations()', function () {
        it('queries with status filter', async function () {
            hub.db.doQuery.resolves([]);
            await engine.getAttestations('attested', 10);
            let args = hub.db.doQuery.getCall(0).args;
            expect(args[0]).to.include("status = ?");
            expect(args[1]).to.include('attested');
        });

        it('queries without status filter', async function () {
            await engine.getAttestations(null, 25);
            let args = hub.db.doQuery.getCall(0).args;
            expect(args[0]).to.not.include("status = ?");
        });
    });

    describe('getAttestation()', function () {
        it('returns first matching row', async function () {
            hub.db.doQuery.resolves([{ id: 1 }]);
            let result = await engine.getAttestation('BTC', 42);
            expect(result).to.deep.equal({ id: 1 });
        });

        it('returns null when not found', async function () {
            hub.db.doQuery.resolves([]);
            let result = await engine.getAttestation('BTC', 999);
            expect(result).to.be.null;
        });
    });
});
