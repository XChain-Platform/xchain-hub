/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 **********************************************************************/

'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const cadence = require('../../../../../src/anchor/checkpoint_engine/cadence.js');
const sources = require('../../../../../src/anchor/checkpoint_engine/sources.js');

describe('checkpoint cadence validator resolution failure', function () {
    it('records the due block as a cadence stall and leaves the tick retryable', async function () {
        const ctx = {
            _ticking: false,
            _attemptedCheckpointBtcBlock: null,
            observerHold: () => false,
            retryFailedSelfAccepts: sinon.stub().resolves(),
            leaderReplayHeld: sinon.stub().resolves(false),
            resolveSnapshotBlock: sinon.stub().resolves(912),
            finalizedLatchHolds: () => false,
            retryTimedOutRounds: sinon.stub().resolves(),
            supersedeOwnAttempt: sinon.spy(),
            signedRoundConflict: () => null,
            resolveCapabilityValidators: sinon.stub().rejects(new Error('snapshot database unavailable')),
            noteCadenceStall: sinon.spy(),
            leadsCadenceSlot: sinon.spy(),
            leadCadenceRound: sinon.stub().resolves()
        };

        await cadence.tick.call(ctx);

        expect(ctx.noteCadenceStall.calledOnceWithExactly(
            912,
            'capability validator resolve failed: snapshot database unavailable'
        )).to.equal(true);
        expect(ctx.leadsCadenceSlot.called).to.equal(false);
        expect(ctx.leadCadenceRound.called).to.equal(false);
    });

    it('distinguishes an unavailable snapshot from an empty snapshot', async function () {
        const unavailable = await sources.resolveCapabilityValidators.call({
            network: 'regtest', capSnapshot: { getWeightSnapshot: sinon.stub().resolves(null) }
        }, 'oracle_publish', 100);
        const empty = await sources.resolveCapabilityValidators.call({
            network: 'regtest', capSnapshot: { getWeightSnapshot: sinon.stub().resolves({ validators: [] }) }
        }, 'oracle_publish', 100);
        expect(unavailable).to.have.length(0);
        expect(unavailable.snapshotUnavailable).to.equal(true);
        expect(empty).to.have.length(0);
        expect(empty.snapshotUnavailable).to.equal(undefined);
    });

    it('names unavailable and empty snapshot stalls without participation advice', function () {
        for (const [validators, expected] of [
            [Object.assign([], { snapshotUnavailable: true }), /snapshot unavailable/],
            [[], /qualifies no validator/]
        ]) {
            const ctx = { noteCadenceStall: sinon.spy() };
            expect(cadence.leadsCadenceSlot.call(ctx, 100, validators)).to.equal(false);
            const reason = ctx.noteCadenceStall.firstCall.args[1];
            expect(reason).to.match(expected);
            expect(reason).to.not.match(/self-test|not enabled/);
        }
    });
});
