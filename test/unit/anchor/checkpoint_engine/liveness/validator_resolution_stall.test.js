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
});
