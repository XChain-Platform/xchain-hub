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
        // Followers verify the proposed source action against their own indexer
        // before co-signing (fail-closed). The PBFT-flow tests exercise the
        // consensus machinery, not that guard, so verification passes by
        // default; the dedicated 'source-action verification' suite restores
        // the real method.
        sinon.stub(engine, '_verifySourceAction').resolves(true);
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
            // Per-pair: N=3 → 2f+1=1, floored at majority ceil((3+1)/2)=2
            expect(engine._getQuorum('BTC', 'LTC')).to.equal(2);
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
    // requestAttestation() - single-node fallback
    // -----------------------------------------------------------------

    describe('requestAttestation()', function () {

        it('single-node stores attestation directly', async function () {
            engine.setValidatorSet([]);
            pm.getPeerStatus.returns([]);

            let result = await engine.requestAttestation('BTC', 42, 'LTC');
            expect(result.attestationId).to.equal('BTC:42:LTC');
            expect(result.confirmations).to.equal(6); // BTC Tier-B default (2026-06-02)
            expect(result.status).to.equal('attested');
            expect(hub.db.doQuery.called).to.be.true;
        });

        it('REFUSES to finalize unilaterally over an EMPTY cross_chain snapshot (federation bootstrap guard)', async function () {
            // quorum resolves to 0 from an EMPTY capability snapshot (not a genuine
            // single node): unilaterally minting an unverified 'attested' row here is
            // the same hazard fixed for the DEX. Must throw, not store.
            engine.setValidatorSet(VALIDATORS_3);
            hub._resolveBtcLatestBlock = async () => 800000;
            hub.capabilitySnapshot = {
                getSnapshot: async () => ({ validators: [], count: 0 }),
                getQuorum:   () => 0
            };
            let threw = false;
            try { await engine.requestAttestation('BTC', 7, 'LTC'); }
            catch (e) { threw = true; expect(e.message).to.match(/EMPTY cross_chain snapshot/); }
            expect(threw, 'should refuse over an empty snapshot').to.be.true;
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
            expect(btc.confirmations).to.equal(6);

            let doge = await engine.requestAttestation('DOGE', 1, 'BTC');
            expect(doge.confirmations).to.equal(60);
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

        it('PROPOSE from peer creates pending and broadcasts PREPARE', async function () {
            let attestationId = 'BTC:1:LTC';
            let digest = engine._digest(attestationId, 3);

            await engine._handlePropose({
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

    // -----------------------------------------------------------------
    // Quorum locking - consensus-divergence regression
    //
    // The quorum threshold for a PBFT round must be captured when the
    // pending attestation is created, NOT re-derived live on every
    // prepare/commit check. If the validator set changes mid-round, two
    // hubs holding different in-memory sets would otherwise compute
    // different thresholds for the same round - one commits, the other
    // stalls forever, and the federation diverges.
    // -----------------------------------------------------------------

    // -----------------------------------------------------------------
    // XCE-EMPTYSNAP-1: a follower must never finalize an attestation over a
    // 0 quorum (an EMPTY cross_chain snapshot). Only the leader's fast path
    // may self-sign, and only when NO federation snapshot resolved.
    // -----------------------------------------------------------------
    describe('empty-snapshot guard (XCE-EMPTYSNAP-1)', function () {

        it('refuses to PREPARE when the cross_chain snapshot resolves a 0 quorum', async function () {
            engine.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
            // A snapshot resolves at the round's block but carries NO qualifying validators,
            // so getQuorum → 0 (bootstrap / misconfigured indexer). The follower must refuse.
            hub.capabilitySnapshot = {
                getSnapshot: sinon.stub().resolves({ validators: [], count: 0 }),
                getQuorum:   sinon.stub().returns(0)
            };
            let attestationId = 'BTC:1:LTC';
            let digest = engine._digest(attestationId, 3);

            await engine._handlePropose({
                sender: VALIDATORS_4[1].addr,
                data: { attestationId, sourceChain: 'BTC', sourceActionIndex: 1,
                        destChain: 'LTC', confirmations: 3, digest, btcBlockHeight: 500 }
            });

            // No pending, no PREPARE/COMMIT: the un-quorum'd round is dropped up front.
            expect(engine.pendingAttestations.has(attestationId)).to.be.false;
            expect(pm.broadcast.called).to.be.false;
        });

        it('still opens the round when the snapshot resolves a real quorum', async function () {
            engine.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
            hub.capabilitySnapshot = {
                getSnapshot: sinon.stub().resolves({ validators: [{}], count: 4 }),
                getQuorum:   sinon.stub().returns(3)
            };
            let attestationId = 'BTC:2:LTC';
            let digest = engine._digest(attestationId, 3);

            await engine._handlePropose({
                sender: VALIDATORS_4[1].addr,
                data: { attestationId, sourceChain: 'BTC', sourceActionIndex: 2,
                        destChain: 'LTC', confirmations: 3, digest, btcBlockHeight: 500 }
            });

            expect(engine.pendingAttestations.has(attestationId)).to.be.true;
            let pending = engine.pendingAttestations.get(attestationId);
            expect(pending.quorum).to.equal(3);
            if (pending.timer) clearTimeout(pending.timer);
        });
    });

    describe('quorum locking', function () {

        it('locks quorum into the pending object on the leader (PROPOSE) path', async function () {
            engine.setValidatorSet(VALIDATORS_4); // N=4 → quorum=3
            // seq increments to 1 → leader = VALIDATORS_4[1 % 4]
            pm.validatorAddr = VALIDATORS_4[1].addr;

            engine.requestAttestation('BTC', 1, 'LTC'); // fire-and-forget; resolves on quorum
            await new Promise(r => setImmediate(r)); // let the async block-boundary snapshot/quorum resolve
            let pending = engine.pendingAttestations.get('BTC:1:LTC');
            expect(pending).to.exist;
            expect(pending.quorum).to.equal(3);
        });

        it('locks quorum into the pending object on the follower (handlePropose) path', async function () {
            engine.setValidatorSet(VALIDATORS_4); // N=4 → quorum=3
            pm.validatorAddr = VALIDATORS_4[0].addr;
            let attestationId = 'BTC:1:LTC';
            let digest = engine._digest(attestationId, 3);

            await engine._handlePropose({
                sender: VALIDATORS_4[1].addr,
                data: { attestationId, sourceChain: 'BTC', sourceActionIndex: 1,
                        destChain: 'LTC', confirmations: 3, digest }
            });

            expect(engine.pendingAttestations.get(attestationId).quorum).to.equal(3);
        });

        it('commits at the round-start quorum even after validatorSet GROWS mid-round', async function () {
            // Round starts with N=4 (quorum=3). A larger set synced mid-round
            // would yield quorum=5 live - which would wrongly stall this node.
            engine.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
            let attestationId = 'BTC:1:LTC';
            let digest = engine._digest(attestationId, 3);

            await engine._handlePropose({
                sender: VALIDATORS_4[1].addr,
                data: { attestationId, sourceChain: 'BTC', sourceActionIndex: 1,
                        destChain: 'LTC', confirmations: 3, digest }
            });
            // After PROPOSE: prepares = {self, sender} = 2; one PREPARE broadcast.
            pm.broadcast.resetHistory();

            // Validator set GROWS mid-round - live quorum would now be 5.
            engine.setValidatorSet(VALIDATORS_7);

            // Third prepare arrives → 3 prepares. Locked quorum=3 → COMMIT must fire.
            engine._handlePrepare({
                sender: VALIDATORS_4[2].addr,
                data: { attestationId, digest }
            });

            expect(pm.broadcast.called).to.be.true;
            expect(pm.broadcast.getCall(0).args[0]).to.equal('XCHAIN_ATTEST_COMMIT');
        });

        it('does NOT commit early if validatorSet SHRINKS mid-round', async function () {
            // Round starts with N=7 (quorum=5). A shrunk set synced mid-round
            // would yield quorum=1 live - which would wrongly commit too early.
            engine.setValidatorSet(VALIDATORS_7);
            pm.validatorAddr = VALIDATORS_7[0].addr;
            let attestationId = 'BTC:1:LTC';
            let digest = engine._digest(attestationId, 3);

            await engine._handlePropose({
                sender: VALIDATORS_7[1].addr,
                data: { attestationId, sourceChain: 'BTC', sourceActionIndex: 1,
                        destChain: 'LTC', confirmations: 3, digest }
            });
            pm.broadcast.resetHistory();

            // Validator set SHRINKS mid-round - live quorum would now be 1.
            engine.setValidatorSet([makeValidator(0)]);

            // Third prepare → 3 prepares. Locked quorum=5 → still NOT met, no COMMIT.
            engine._handlePrepare({
                sender: VALIDATORS_7[2].addr,
                data: { attestationId, digest }
            });

            let commitBroadcast = pm.broadcast.getCalls()
                .some(c => c.args[0] === 'XCHAIN_ATTEST_COMMIT');
            expect(commitBroadcast).to.be.false;
        });
    });

    // -----------------------------------------------------------------
    // Source-action verification - the fail-closed follower guard that
    // replaced the Phase-4C "trust the proposer's claim" TODO. A follower
    // confirms the proposed source action against its OWN indexer (via
    // getactionconfirmations) and refuses to co-sign when the action is
    // missing, under-confirmed, unverifiable, or when the discrete fields
    // don't match the attestationId the digest covers.
    // -----------------------------------------------------------------

    describe('source-action verification', function () {

        beforeEach(function () {
            engine._verifySourceAction.restore(); // exercise the real guard
            engine.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
        });

        function propose(overrides = {}) {
            let attestationId = overrides.attestationId || 'BTC:1:LTC';
            let confirmations = overrides.confirmations || 3;
            let digest = engine._digest(attestationId, confirmations);
            return engine._handlePropose({
                sender: VALIDATORS_4[1].addr,
                data: Object.assign({ attestationId, sourceChain: 'BTC', sourceActionIndex: 1,
                                      destChain: 'LTC', confirmations, digest }, overrides.data)
            });
        }

        it('refuses to PREPARE when no indexer endpoint is configured (fail closed)', async function () {
            await propose();
            expect(engine.pendingAttestations.size).to.equal(0);
            expect(pm.broadcast.called).to.be.false;
        });

        it('refuses when the discrete fields do not match the attestationId', async function () {
            // Digest matches the id, but the proposer claims a different source
            // action than the one the id (and digest) commit to.
            sinon.stub(engine, '_indexerCall').resolves({ exists: true, confirmations: 100 });
            engine.indexers.BTC.url = 'http://stub:3004/';
            await propose({ data: { sourceActionIndex: 2 } });
            expect(engine.pendingAttestations.size).to.equal(0);
        });

        it('refuses when the action does not exist on the source chain', async function () {
            engine.indexers.BTC.url = 'http://stub:3004/';
            sinon.stub(engine, '_indexerCall').resolves({ exists: false, confirmations: 0 });
            await propose();
            expect(engine.pendingAttestations.size).to.equal(0);
        });

        it('refuses when the action is below the per-chain confirmation threshold', async function () {
            engine.indexers.BTC.url = 'http://stub:3004/';
            sinon.stub(engine, '_indexerCall').resolves({ exists: true, confirmations: 5 }); // BTC needs 6
            await propose();
            expect(engine.pendingAttestations.size).to.equal(0);
        });

        it('refuses when the indexer lookup fails (fail closed, not fail open)', async function () {
            engine.indexers.BTC.url = 'http://stub:3004/';
            sinon.stub(engine, '_indexerCall').rejects(new Error('ECONNREFUSED'));
            await propose();
            expect(engine.pendingAttestations.size).to.equal(0);
        });

        it('co-signs when the action exists at sufficient depth', async function () {
            engine.indexers.BTC.url = 'http://stub:3004/';
            let call = sinon.stub(engine, '_indexerCall').resolves({ exists: true, confirmations: 6 });
            await propose();
            expect(engine.pendingAttestations.has('BTC:1:LTC')).to.be.true;
            expect(call.calledOnceWith('BTC', 'getactionconfirmations', { action_index: 1 })).to.be.true;
            let pending = engine.pendingAttestations.get('BTC:1:LTC');
            if (pending.timer) clearTimeout(pending.timer);
        });
    });

    // -----------------------------------------------------------------
    // _markFinalized() bounded FIFO (R2-CCF4)
    // -----------------------------------------------------------------
    describe('_markFinalized (bounded finalized set)', function () {

        it('caps the finalized set at finalizedMax, evicting oldest first', function () {
            engine.finalizedMax = 5;
            for (let i = 0; i < 20; i++) engine._markFinalized('att:' + i);
            expect(engine.finalized.size).to.equal(5);
            expect(engine._finalizedOrder.length).to.equal(5);
            // Oldest evicted, newest 5 (att:15..att:19) retained.
            expect(engine.finalized.has('att:0')).to.be.false;
            expect(engine.finalized.has('att:14')).to.be.false;
            expect(engine.finalized.has('att:15')).to.be.true;
            expect(engine.finalized.has('att:19')).to.be.true;
        });

        it('is idempotent for a repeated id (no double-count, no double-evict)', function () {
            engine.finalizedMax = 3;
            engine._markFinalized('a');
            engine._markFinalized('a');
            engine._markFinalized('a');
            expect(engine.finalized.size).to.equal(1);
            expect(engine._finalizedOrder).to.deep.equal(['a']);
        });
    });
});
