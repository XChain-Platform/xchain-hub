'use strict';


// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
//
// ReorgHandler: the process-lifetime counts the scrape reads (leader and follower
// round timeouts, rollbacks run and failed, self-verification abstains).

const sinon        = require('sinon');
const { expect }   = require('chai');
const ReorgHandler = require('../../../../src/anchor/reorg_handler');
const { createMockHub }  = require('../../../helpers/mockHub');
const { VALIDATORS_4 }   = require('../../../helpers/fixtures');

const OLD_HASH = 'a'.repeat(64);
const NEW_HASH = 'b'.repeat(64);
const T0 = 1700000000000;

// The handler under test and its mock hub, rebuilt before every case.
let hub, pm, rh, clock;

function openLedRound() {
    sinon.stub(rh, 'verifyReorgAgainstOwnNode').resolves(true);
    return rh.reportReorg('BTC', 500000, T0, OLD_HASH, NEW_HASH);
}

function followerPrepare(reorgId) {
    return rh.handlePrepare({
        sender: VALIDATORS_4[1].addr,
        data: { reorgId, chain: 'LTC', reorgHeight: 300, timestamp: T0,
                affectedChains: ['BTC', 'DOGE'],
                digest: rh.digest(reorgId, 'LTC', 300, T0, OLD_HASH, NEW_HASH),
                oldHash: OLD_HASH, newHash: NEW_HASH }
    });
}

function registerTimeoutCases() {
    it('counts a led round that times out below quorum', async function () {
        clock = sinon.useFakeTimers({ now: T0 });
        await openLedRound();
        clock.tick(rh.timeout + 1);
        expect(rh._roundTimeouts).to.equal(1);
        expect(rh._followerRoundTimeouts).to.equal(0);
    });

    it('does not count the leader timer of a round that already finalized', async function () {
        clock = sinon.useFakeTimers({ now: T0 });
        await openLedRound();
        rh.pendingReorgs.get('BTC:500000:' + T0).finalized = true;
        clock.tick(rh.timeout + 1);
        expect(rh._roundTimeouts).to.equal(0);
    });

    it('counts a follower round that times out below quorum', async function () {
        clock = sinon.useFakeTimers({ now: T0 });
        sinon.stub(rh, 'verifyReorgAgainstOwnNode').resolves(true);
        await followerPrepare('LTC:300:' + T0);
        clock.tick(rh.timeout * 2 + 1);
        expect(rh._followerRoundTimeouts).to.equal(1);
        expect(rh._roundTimeouts).to.equal(0);
    });
}

function registerAbstainCase() {
    it('counts a claim its own node does not confirm on the ALERT and PREPARE paths', async function () {
        clock = sinon.useFakeTimers({ now: T0 });
        sinon.stub(rh, 'verifyReorgAgainstOwnNode').resolves(false);
        let reorgId = 'LTC:300:' + T0;
        await rh.handleAlert({
            sender: VALIDATORS_4[1].addr,
            data: { chain: 'LTC', reorgHeight: 300, timestamp: T0, reorgId,
                    oldHash: OLD_HASH, newHash: NEW_HASH }
        });
        expect(rh._selfVerifyAbstains).to.equal(1);
        await followerPrepare(reorgId);
        expect(rh._selfVerifyAbstains).to.equal(2);
        expect(rh.pendingReorgs.size).to.equal(0);
    });
}

function registerRollbackCase() {
    it('counts a completed rollback and a rollback that throws at commit quorum', async function () {
        for (let name of ['deleteAttestation', 'updatePriceSnapshotByBlockTimestamp', 'setReorgAttestation',
            'findDisputedPriceSnapshotsAfterBlockTimestamp']) {
            rh.db[name] = sinon.stub().resolves([]);
        }
        await rh.executeRollback('BTC', 500, Date.now(), 'BTC:500:1', 3, '[]', null);
        expect(rh._rollbacksExecuted).to.equal(1);
        expect(rh._rollbackFailures).to.equal(0);

        sinon.stub(rh, 'executeRollback').rejects(new Error('db down'));
        rh.pendingReorgs.set('BTC:500:2', {
            reorgId: 'BTC:500:2', chain: 'BTC', reorgHeight: 500, timestamp: Date.now(),
            selfVerified: true, quorum: 1, snapshotActive: false,
            prepares: new Set(['p']), commits: new Set(['c']), finalized: false, timer: null
        });
        rh.checkCommitQuorum('BTC:500:2');
        await new Promise((resolve) => setImmediate(resolve));
        expect(rh._rollbackFailures).to.equal(1);
        expect(rh._rollbacksExecuted).to.equal(1);
    });
}

describe('ReorgHandler round counters', function () {

    beforeEach(function () {
        hub = createMockHub();
        pm  = hub._peerManager;
        rh  = new ReorgHandler(hub);
        rh.setValidatorSet(VALIDATORS_4);
        pm.validatorAddr = VALIDATORS_4[0].addr;
    });

    afterEach(function () {
        for (let [, pending] of rh.pendingReorgs) {
            if (pending.timer) clearTimeout(pending.timer);
        }
        if (clock) { clock.restore(); clock = null; }
        sinon.restore();
    });

    it('starts every count at zero', function () {
        for (let field of ['_roundTimeouts', '_followerRoundTimeouts', '_rollbacksExecuted',
            '_rollbackFailures', '_selfVerifyAbstains']) {
            expect(rh[field], field).to.equal(0);
        }
    });

    registerTimeoutCases();
    registerAbstainCase();
    registerRollbackCase();
});
