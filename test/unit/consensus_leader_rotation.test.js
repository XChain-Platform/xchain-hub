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
//
// ROTATION LIVENESS GUARD: a refused propose() attempt must consume its
// sequence slot. The not-leader refusal used to fire before the sequence
// advanced, so a federated hub that was not the rotation leader for the one
// slot it kept resolving re-elected the SAME leader on every retry and could
// never propose again. The refusal must move the rotation one step forward,
// so within |members| attempts the rotation reaches the proposing hub, and a
// hub that has advanced only lastAppliedSeq (rounds applied as a follower)
// must propose past the applied history rather than from its frozen counter.

const sinon      = require('sinon');
const { expect } = require('chai');
const Consensus  = require('../../src/Consensus');
const { createMockHub } = require('../helpers/mockHub');
const { VALIDATORS_3, makeFederationSnapshot } = require('../helpers/fixtures');

// Sorted member pubkeys are v1 < v2 < v3, so the rotation leader for
// (seq, view 0) is VALIDATORS_3[seq % 3].
const SNAPSHOT_BLOCK = 800000;

function settle(rounds) {
    let p = Promise.resolve();
    for (let i = 0; i < (rounds || 12); i++) p = p.then(() => new Promise(r => setImmediate(r)));
    return p;
}

// One simulated hub: a Consensus engine owned by validator `v`, with the
// federation snapshot wired and the peer registry holding all three members.
function makeEngine(v) {
    let identity = {
        getPubkeyHex:  sinon.stub().returns(v.pubkey),
        sign:          sinon.stub().returns('bb'.repeat(64)),
        signEnvelope:  sinon.stub().returns('cc'.repeat(64))
    };
    let hub = createMockHub({
        validatorAddr: v.addr,
        identity: identity,
        validatorPubkeys: new Map(VALIDATORS_3.map(m => [m.addr, m.pubkey]))
    });
    hub.capabilitySnapshot = {
        getActiveValidatorSnapshot: sinon.stub().resolves(makeFederationSnapshot(VALIDATORS_3, SNAPSHOT_BLOCK)),
        getActiveWeightSnapshot:    sinon.stub().resolves(makeFederationSnapshot(VALIDATORS_3, SNAPSHOT_BLOCK)),
        getQuorum:                  sinon.stub().returns(2)
    };
    hub._resolveBtcLatestBlock = sinon.stub().resolves(SNAPSHOT_BLOCK);
    let consensus = new Consensus(hub);
    consensus.setValidatorSet(VALIDATORS_3);
    return { v: v, hub: hub, pm: hub._peerManager, consensus: consensus };
}

// Deliver every broadcast to every OTHER engine, as the P2P layer would.
function wireBus(engines) {
    for (let e of engines) {
        e.pm.broadcast = sinon.spy((type, data) => {
            for (let other of engines) {
                if (other === e) continue;
                other.consensus._handleMessage({
                    sender: e.pm.validatorAddr, sig_pubkey: e.v.pubkey,
                    type: type, data: data
                });
            }
            return { id: 'msg' };
        });
    }
}

describe('Consensus: a refused propose() advances the rotation (livelock regression)', function () {

    let engines, A, B, C, logStubs;

    beforeEach(function () {
        engines = VALIDATORS_3.map(makeEngine);
        [A, B, C] = engines;
        wireBus(engines);
        // The round chatter is noisy; keep assertions on state, not output.
        logStubs = [sinon.stub(console, 'log'), sinon.stub(console, 'warn')];
    });

    afterEach(async function () {
        for (let e of engines) await e.consensus.stop();
        sinon.restore();
    });

    it('successive refused attempts consume slots until the rotation reaches the hub, and the federation then commits its round', async function () {
        // Hub A (member index 0) leads slots where seq % 3 === 0. From seq 0
        // its first two attempts hit slots led by v2 then v3.
        let err1 = await A.consensus.propose({ cfg: 1 }).then(() => null, e => e);
        expect(err1, 'attempt 1: slot 1 is led by v2').to.be.an('error');
        expect(err1.message).to.include('Not the leader for seq 1');

        // The regression: with the sequence frozen, this attempt would resolve
        // seq 1 and the SAME leader again, forever. The refusal above must have
        // consumed slot 1, so the next attempt contests slot 2.
        let err2 = await A.consensus.propose({ cfg: 1 }).then(() => null, e => e);
        expect(err2, 'attempt 2: slot 2 is led by v3').to.be.an('error');
        expect(err2.message, 'the rotation must ADVANCE between attempts').to.include('Not the leader for seq 2');

        // Third attempt: slot 3 (3 % 3 === 0) elects hub A itself. The whole
        // simulated federation then drives the round to commit quorum.
        let applied = await A.consensus.propose({ cfg: 1 });
        expect(applied).to.equal(true);
        await settle();

        expect(A.pm.broadcast.calledWith('PBFT_PRE_PREPARE', sinon.match({ seq: 3 })),
            'converged within |members| attempts').to.be.true;
        for (let e of engines) {
            expect(e.hub.applyConfig.calledOnceWith({ cfg: 1 }),
                e.v.addr + ' must apply the committed config exactly once').to.be.true;
            expect(e.consensus.lastAppliedSeq, e.v.addr + ' lastAppliedSeq').to.equal(3);
        }
    });

    it('followers of the committed round can propose next without a wedge (their applied history advances the slot)', async function () {
        // B led seq 1 legitimately; drive that round to commit on all hubs.
        let applied = await B.consensus.propose({ cfg: 1 });
        expect(applied).to.equal(true);
        await settle();
        expect(C.consensus.lastAppliedSeq).to.equal(1);

        // C followed that round (its own seq counter never moved). Its next
        // attempts must contest slots ABOVE the applied history: slot 2 is
        // C's own (2 % 3 === 2), so it proposes immediately, at a seq no peer
        // rejects as stale.
        let applied2 = await C.consensus.propose({ cfg: 2 });
        expect(applied2).to.equal(true);
        await settle();
        expect(C.pm.broadcast.calledWith('PBFT_PRE_PREPARE', sinon.match({ seq: 2 })),
            'proposed past the applied history, not from the frozen counter').to.be.true;
        for (let e of engines) expect(e.consensus.lastAppliedSeq).to.equal(2);
    });

    it('a hub whose lastAppliedSeq is far ahead of its counter still proposes above it', async function () {
        // Simulate a long follower history: five rounds applied, counter frozen.
        A.consensus.lastAppliedSeq = 5;
        A.consensus.seq = 0;

        // Slot 6 (6 % 3 === 0) is A's; the proposal must claim seq 6, because
        // any seq <= 5 is rejected by every peer's stale-seq gate.
        let promise = A.consensus.propose({ cfg: 3 });
        await settle();
        expect(A.pm.broadcast.calledWith('PBFT_PRE_PREPARE', sinon.match({ seq: 6 }))).to.be.true;
        await promise;
        for (let e of engines) expect(e.consensus.lastAppliedSeq).to.equal(6);
    });
});
