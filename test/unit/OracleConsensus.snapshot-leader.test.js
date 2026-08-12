'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// CONSENSUS GUARD: the round leader must be derived from the
// block-locked capability snapshot, not the live registered validatorSet. The
// live set drifts with registration churn mid-round, so live-set indexing lets
// two hubs elect different leaders for the same round and reject each other's
// legitimate PROPOSE (liveness stall). With a snapshot, every hub elects
// sorted-member-pubkeys[round % N]; without one, legacy live-set rotation.

const sinon           = require('sinon');
const { expect }      = require('chai');
const OracleConsensus = require('../../src/OracleConsensus');
const { createMockHub } = require('../helpers/mockHub');
const { VALIDATORS_3, makeValidator, buildSubmissions } = require('../helpers/fixtures');

function registryFor(validators) {
    let m = new Map();
    for (let v of validators) m.set(v.addr, v.pubkey);
    return m;
}

function snapshotOf(validators, blockIndex) {
    return {
        capability: 'price',
        blockIndex: blockIndex,
        count:      validators.length,
        validators: validators.map(v => ({ pubkey: v.pubkey, amount: '100' }))
    };
}

function memberSetOf(validators) {
    return new Set(validators.map(v => v.pubkey.toLowerCase()));
}

describe('OracleConsensus: block-locked snapshot leader', function () {
    let hub, pm, oc, oracleRound;
    // Round 3 over a 3-member snapshot: sorted pubkeys [v1,v2,v3], 3 % 3 = 0 = v1.
    const ROUND = 3;

    beforeEach(function () {
        hub = createMockHub();
        pm  = hub._peerManager;
        pm.validatorAddr    = VALIDATORS_3[0].addr;
        pm.validatorPubkeys = registryFor(VALIDATORS_3);
        hub._identity.getPubkeyHex.returns(VALIDATORS_3[0].pubkey);
        hub.capabilitySnapshot = {
            getSnapshot:       sinon.stub().resolves(snapshotOf(VALIDATORS_3, 100)),
            getWeightSnapshot: sinon.stub().resolves(null),
            getQuorum:         sinon.stub().returns(2)
        };
        oracleRound = { getSubmissions: sinon.stub().returns(new Map()), priceFetcher: null };
        oc = new OracleConsensus(hub, oracleRound);
        oc.setValidatorSet(VALIDATORS_3);
    });

    afterEach(function () { sinon.restore(); });

    describe('_getLeader()', function () {
        it('derives the leader from sorted snapshot pubkeys, round % N', function () {
            let members = memberSetOf(VALIDATORS_3);
            expect(oc._getLeader(0, members).pubkey).to.equal(VALIDATORS_3[0].pubkey);
            expect(oc._getLeader(1, members).pubkey).to.equal(VALIDATORS_3[1].pubkey);
            expect(oc._getLeader(2, members).pubkey).to.equal(VALIDATORS_3[2].pubkey);
            expect(oc._getLeader(3, members).pubkey).to.equal(VALIDATORS_3[0].pubkey); // wraps
        });

        it('is unaffected by live validatorSet drift when a snapshot exists', function () {
            let members = memberSetOf(VALIDATORS_3);
            // Registration churn reorders/extends the live set mid-round.
            oc.setValidatorSet([VALIDATORS_3[1], VALIDATORS_3[2], VALIDATORS_3[0], makeValidator(9)]);
            let leader = oc._getLeader(ROUND, members);
            expect(leader.pubkey).to.equal(VALIDATORS_3[0].pubkey);
            expect(leader.addr).to.equal(VALIDATORS_3[0].addr);
        });

        it('falls back to live-set rotation without a snapshot (legacy)', function () {
            expect(oc._getLeader(ROUND, null)).to.equal(VALIDATORS_3[0]);
            expect(oc._getLeader(4, null)).to.equal(VALIDATORS_3[1]);
        });
    });

    describe('_addrForPubkey()', function () {
        it('resolves via the loaded validator set first', function () {
            expect(oc._addrForPubkey(VALIDATORS_3[1].pubkey.toLowerCase()))
                .to.equal(VALIDATORS_3[1].addr);
        });

        it('resolves via the peer registry (lowest addr) when absent from the validator set', function () {
            let stranger = makeValidator(7);
            pm.validatorPubkeys.set('ws://z-later:10001', stranger.pubkey);
            pm.validatorPubkeys.set(stranger.addr, stranger.pubkey);
            expect(oc._addrForPubkey(stranger.pubkey.toLowerCase())).to.equal(stranger.addr);
        });

        it('resolves own identity pubkey to own addr as a last resort', function () {
            oc.setValidatorSet([]);
            pm.validatorPubkeys = new Map();
            hub._identity.getPubkeyHex.returns(VALIDATORS_3[0].pubkey);
            expect(oc._addrForPubkey(VALIDATORS_3[0].pubkey.toLowerCase()))
                .to.equal(pm.validatorAddr);
        });

        it('returns null for an unknown pubkey', function () {
            expect(oc._addrForPubkey('ff'.repeat(32))).to.be.null;
        });
    });

    it('finalizeRound: snapshot leader proposes even when live-set rotation disagrees', async function () {
        // Live set drifted so live _getLeader(3) over [v2,v3,v1] would pick v2,
        // but the snapshot says round 3's leader is v1 (this hub).
        oc.setValidatorSet([VALIDATORS_3[1], VALIDATORS_3[2], VALIDATORS_3[0]]);
        oracleRound.getSubmissions.returns(buildSubmissions([
            { sender: VALIDATORS_3[0].addr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] },
            { sender: VALIDATORS_3[1].addr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] }
        ]));
        await oc.finalizeRound(ROUND, 100, 1700000000);
        expect(pm.broadcast.calledOnce).to.be.true;
        expect(pm.broadcast.firstCall.args[0]).to.equal('ORACLE_PROPOSE');
    });

    it('finalizeRound: a hub the snapshot does NOT elect stays a follower despite live-set rotation electing it', async function () {
        // Snapshot leader for round 4 is v2; this hub (v1) is index 0 of a
        // drifted live set where 4 % 2 = 0 would have elected it.
        oc.setValidatorSet([VALIDATORS_3[0], VALIDATORS_3[2]]);
        oracleRound.getSubmissions.returns(buildSubmissions([
            { sender: VALIDATORS_3[0].addr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] },
            { sender: VALIDATORS_3[1].addr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] }
        ]));
        await oc.finalizeRound(4, 100, 1700000000);
        expect(pm.broadcast.called).to.be.false;
    });

    it('_handlePropose: accepts a PROPOSE from the snapshot leader that live-set rotation would reject', async function () {
        // Follower view: this hub is v2; live set drifted to [v2,v3] so legacy
        // _getLeader(3) = v2 (itself) and v1's PROPOSE would be dropped as
        // non-leader. The snapshot elects v1 for round 3.
        pm.validatorAddr = VALIDATORS_3[1].addr;
        hub._identity.getPubkeyHex.returns(VALIDATORS_3[1].pubkey);
        oc.setValidatorSet([VALIDATORS_3[1], VALIDATORS_3[2]]);
        let prices = [{ coinPair: 'BTC/USD', price: '100000' }];
        oracleRound.getSubmissions.returns(buildSubmissions([
            { sender: VALIDATORS_3[1].addr, prices: prices }
        ]));
        await oc._handlePropose({ sender: VALIDATORS_3[0].addr, data: {
            round: ROUND, prices, digest: oc._digest(ROUND, prices),
            btcBlockHeight: 100, btcBlockTime: 1700000000
        } });
        expect(oc.pendingRounds.has(ROUND)).to.be.true;
    });

    it('_handlePropose: rejects a PROPOSE from a non-leader the drifted live set would have elected', async function () {
        // Follower view: this hub is v3. Live set drifted to [v2,v1,v3]; legacy
        // _getLeader(3) over it = v2. The snapshot elects v1 for round 3, so a
        // PROPOSE from v2 (no fallback grounds: leader v1 HAS a submission and
        // no leader-timeout has elapsed) must be dropped.
        pm.validatorAddr = VALIDATORS_3[2].addr;
        hub._identity.getPubkeyHex.returns(VALIDATORS_3[2].pubkey);
        oc.setValidatorSet([VALIDATORS_3[1], VALIDATORS_3[0], VALIDATORS_3[2]]);
        let prices = [{ coinPair: 'BTC/USD', price: '100000' }];
        oracleRound.getSubmissions.returns(buildSubmissions([
            { sender: VALIDATORS_3[0].addr, prices: prices },
            { sender: VALIDATORS_3[1].addr, prices: prices }
        ]));
        await oc._handlePropose({ sender: VALIDATORS_3[1].addr, data: {
            round: ROUND, prices, digest: oc._digest(ROUND, prices),
            btcBlockHeight: 100, btcBlockTime: 1700000000
        } });
        expect(oc.pendingRounds.has(ROUND)).to.be.false;
    });

    it('_handlePropose: still accepts the lowest-addr fallback when the snapshot leader has no submission', async function () {
        // Follower view: this hub is v3; snapshot leader v1 never submitted.
        // v2 is the lowest-addr submitter and proposes as fallback.
        pm.validatorAddr = VALIDATORS_3[2].addr;
        hub._identity.getPubkeyHex.returns(VALIDATORS_3[2].pubkey);
        let prices = [{ coinPair: 'BTC/USD', price: '100000' }];
        oracleRound.getSubmissions.returns(buildSubmissions([
            { sender: VALIDATORS_3[1].addr, prices: prices },
            { sender: VALIDATORS_3[2].addr, prices: prices }
        ]));
        await oc._handlePropose({ sender: VALIDATORS_3[1].addr, data: {
            round: ROUND, prices, digest: oc._digest(ROUND, prices),
            btcBlockHeight: 100, btcBlockTime: 1700000000
        } });
        expect(oc.pendingRounds.has(ROUND)).to.be.true;
    });

    it('_leaderSubmissionAddr matches the leader submission by verified pubkey under a different addr binding', function () {
        let twinAddr = 'ws://validator-1-twin:10001';
        let subs = new Map([[twinAddr, { prices: [], pubkey: VALIDATORS_3[0].pubkey.toLowerCase() }]]);
        let leader = { addr: VALIDATORS_3[0].addr, pubkey: VALIDATORS_3[0].pubkey.toLowerCase() };
        expect(oc._leaderSubmissionAddr(subs, leader)).to.equal(twinAddr);
    });
});
