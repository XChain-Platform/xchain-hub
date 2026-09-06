'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// Below the STAKE_WEIGHTED_QUORUM activation height the fail-closed federation guards
// were conditional on weighted mode, so a NULL price snapshot (indexer down / timeout /
// 401-403 / malformed) fell through to _getQuorum(), which reads this hub's own
// validatorSet or open-peer count. The finalization THRESHOLD then depended on local
// reachability: at one height a hub holding a three-member snapshot needs two votes
// while a hub whose fetch failed needs whatever its live set implies. The same null also
// unfiltered the member tally and reverted leader election to live-set rotation. Both
// round paths now refuse instead, matching Consensus.js and CrossChainEngine.

const sinon            = require('sinon');
const { expect }       = require('chai');
const OracleConsensus  = require('../../src/OracleConsensus');
const swq              = require('../../src/stake_weighted_quorum.js');
const { createMockHub } = require('../helpers/mockHub');
const { VALIDATORS_3, buildSubmissions, makeCapabilitySnapshotStub } = require('../helpers/fixtures');

const HEIGHT = 900000;
const PRICES = [{ coinPair: 'BTC/USD', price: '100000' }];

describe('OracleConsensus: a federated round needs a deterministic capability snapshot', function () {

    let hub, pm, oc, oracleRound;

    beforeEach(function () {
        hub = createMockHub();
        hub._resolveBtcLatestBlock = sinon.stub().resolves(HEIGHT);
        pm  = hub._peerManager;
        pm.validatorPubkeys = new Set();          // size 0: _isKnownSender accepts any sender
        oracleRound = { getSubmissions: sinon.stub().returns(new Map()) };
        oc = new OracleConsensus(hub, oracleRound);
        oc.minSubmissions = 1;
        // Count mode: this gate is exactly the case the weighted-mode guards never covered.
        sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
    });

    afterEach(function () {
        for (let [, pending] of oc.pendingRounds) if (pending.timer) clearTimeout(pending.timer);
        sinon.restore();
    });

    function nullSnapshotSource() {
        return {
            getSnapshot:       sinon.stub().resolves(null),
            getWeightSnapshot: sinon.stub().resolves(null),
            getQuorum:         sinon.stub().returns(0)
        };
    }

    // The leader's own submissions, from snapshot members, priced identically.
    function memberSubmissions() {
        return buildSubmissions(VALIDATORS_3.map(v => ({ sender: v.addr, prices: PRICES })));
    }

    function proposeEnvelope(round) {
        let leader = VALIDATORS_3[round % 3];
        return { type: 'ORACLE_PROPOSE', sender: leader.addr, sig_pubkey: leader.pubkey, data: {
            round, prices: PRICES, digest: oc._digest(round, PRICES), btcBlockHeight: HEIGHT
        } };
    }

    describe('leader path (finalizeRound)', function () {

        it('SECURITY: skips the round rather than sizing quorum from the live validator set', async function () {
            hub.capabilitySnapshot = nullSnapshotSource();
            oc.setValidatorSet(VALIDATORS_3);
            pm.validatorAddr = VALIDATORS_3[0].addr;                 // leader for round 0
            oracleRound.getSubmissions.returns(memberSubmissions());
            let quorumSpy = sinon.spy(oc, '_getQuorum');

            await oc.finalizeRound(0, HEIGHT, 1700000000);

            expect(pm.broadcast.called).to.equal(false);
            expect(oc.pendingRounds.has(0)).to.equal(false);
            // A skipped-round row was written, so the stall is durable rather than silent.
            let insert = hub.db.doQuery.getCalls().find(c => /price_snapshots/.test(String(c.args[0])));
            expect(insert, 'a skipped-round row must be written').to.not.equal(undefined);
            expect(String(insert.args[0])).to.include('skipped');
            // The federation test may consult _getQuorum, but nothing downstream may SIZE
            // the round from it: no round was opened at all.
            expect(quorumSpy.called).to.equal(true);
        });

        // Control: the same round with a resolvable snapshot proposes normally, so the
        // refusal above is the snapshot gate and not some other guard in the path.
        it('proposes normally once the snapshot resolves (control)', async function () {
            hub.capabilitySnapshot = makeCapabilitySnapshotStub(VALIDATORS_3);
            oc.setValidatorSet(VALIDATORS_3);
            pm.validatorAddr = VALIDATORS_3[0].addr;
            oracleRound.getSubmissions.returns(memberSubmissions());

            await oc.finalizeRound(0, HEIGHT, 1700000000);

            expect(pm.broadcast.called).to.equal(true);
            expect(pm.broadcast.getCall(0).args[0]).to.equal('ORACLE_PROPOSE');
        });

        // A genuine single-node / regtest hub has no peer to diverge from, so it keeps the
        // bootstrap self-finalize path. Same federation test as the empty-snapshot guard.
        it('leaves a single-node hub (_getQuorum() === 0) on its bootstrap path', async function () {
            hub.capabilitySnapshot = nullSnapshotSource();
            oc.setValidatorSet([]);
            pm.getPeerStatus.returns([]);
            expect(oc._getQuorum()).to.equal(0);
            pm.validatorAddr = 'ws://solo:10001';
            oracleRound.getSubmissions.returns(buildSubmissions([{ sender: 'ws://solo:10001', prices: PRICES }]));
            let storeSpy = sinon.spy(oc, '_storeSnapshot');

            await oc.finalizeRound(1, HEIGHT, 1700000000);

            expect(storeSpy.callCount).to.equal(1);
        });
    });

    describe('follower path (_handlePropose)', function () {

        it('SECURITY: drops the PROPOSE rather than opening a locally-sized pending round', async function () {
            hub.capabilitySnapshot = nullSnapshotSource();
            oc.setValidatorSet(VALIDATORS_3);
            pm.validatorAddr = VALIDATORS_3[1].addr;                 // a follower for round 0
            oracleRound.getSubmissions.returns(memberSubmissions());

            await oc._handlePropose(proposeEnvelope(0));

            expect(oc.pendingRounds.has(0)).to.equal(false);
            expect(pm.broadcast.called).to.equal(false);
        });

        it('opens the pending round once the snapshot resolves (control)', async function () {
            hub.capabilitySnapshot = makeCapabilitySnapshotStub(VALIDATORS_3);
            oc.setValidatorSet(VALIDATORS_3);
            pm.validatorAddr = VALIDATORS_3[1].addr;
            oracleRound.getSubmissions.returns(memberSubmissions());

            await oc._handlePropose(proposeEnvelope(0));

            expect(oc.pendingRounds.has(0)).to.equal(true);
        });

        it('leaves a single-node hub (_getQuorum() === 0) on its bootstrap path', async function () {
            hub.capabilitySnapshot = nullSnapshotSource();
            oc.setValidatorSet(VALIDATORS_3);
            sinon.stub(oc, '_getQuorum').returns(0);
            pm.validatorAddr = VALIDATORS_3[1].addr;
            oracleRound.getSubmissions.returns(memberSubmissions());

            await oc._handlePropose(proposeEnvelope(0));

            expect(oc.pendingRounds.has(0)).to.equal(true);
        });
    });

    it('_hasDeterministicSnapshot separates a NULL snapshot from a present-but-empty one', function () {
        expect(oc._hasDeterministicSnapshot(null)).to.equal(false);
        expect(oc._hasDeterministicSnapshot({})).to.equal(false);
        expect(oc._hasDeterministicSnapshot({ validators: [] })).to.equal(true);
        expect(oc._hasDeterministicSnapshot({ validators: [{ pubkey: 'aa' }] })).to.equal(true);
    });
});
