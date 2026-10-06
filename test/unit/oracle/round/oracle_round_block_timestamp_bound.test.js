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

const sinon = require('sinon');
const { expect } = require('chai');
const gateRegistry = require('../../../../src/consensus/gate_registry');
const { nominalRoundSeconds } = require('../../../../src/oracle/consensus/round_time');
const { ROUND_TIME_GATE } = require('../../../../src/oracle/consensus/round_time_gate');
const { makeRoundTimeCapture } = require('./helpers/round_time_capture');

const ROUND = 81;
const HEIGHT = 900000;
const EPOCH_START_MS = 1700000000000;
const ROUND_INTERVAL_MS = 60000;
const NOMINAL = nominalRoundSeconds(ROUND, EPOCH_START_MS, ROUND_INTERVAL_MS);
const SKEW = 2 * 60 * 60;

describe('OracleRound wire block time bound', function () {
    let capture;
    let gateOn;
    const registryActiveAt = gateRegistry.activeAt;

    beforeEach(function () {
        gateOn = false;
        sinon.stub(gateRegistry, 'activeAt').callsFake((key, ...args) =>
            key === ROUND_TIME_GATE ? gateOn : registryActiveAt.call(gateRegistry, key, ...args));
    });

    afterEach(function () {
        if (capture) capture.restore();
        capture = null;
        sinon.restore();
    });

    async function wireTime(blockTime) {
        capture = makeRoundTimeCapture({
            network: 'mainnet', quorum: 0, height: HEIGHT, blockTime, fallbackActive: false
        });
        capture.round.epochStart = EPOCH_START_MS;
        capture.round.roundInterval = ROUND_INTERVAL_MS;
        const out = await capture.finalize(ROUND);
        return out.args[2];
    }

    it('passes a positive integer header time through unchanged below the gate', async function () {
        expect(await wireTime(NOMINAL - 600)).to.equal(NOMINAL - 600);
        expect(await wireTime(NOMINAL + SKEW)).to.equal(NOMINAL + SKEW);
    });

    it('replaces a non-integer, zero or missing time with the nominal round time', async function () {
        for (const bad of [0, -5, 1.5, NaN, null, undefined, '1700000000']) {
            expect(await wireTime(bad), String(bad)).to.equal(NOMINAL);
        }
    });

    it('uses the nominal time whatever the captured value once the gate is active', async function () {
        gateOn = true;
        expect(await wireTime(NOMINAL - 600)).to.equal(NOMINAL);
    });

    describe('pushed tip anchor', function () {
        it('falls back to the wall clock for a pushed tip with no usable block time', async function () {
            capture = makeRoundTimeCapture({
                network: 'mainnet', quorum: 0, height: HEIGHT, blockTime: NOMINAL, fallbackActive: false
            });
            const round = capture.round;
            round.epochStart = Date.now() - 5 * ROUND_INTERVAL_MS;
            round.roundInterval = ROUND_INTERVAL_MS;
            round.hub.resolveBtcNetwork = async () => 'mainnet';
            round.db = { getChainTip: async () => ({ blockHeight: HEIGHT, blockTime: 'junk' }) };
            round.submitRoundPrices = undefined;
            await round.executeRoundInner().catch(() => {});
            const now = Math.floor(Date.now() / 1000);
            expect(round.currentBtcBlockHeight).to.equal(HEIGHT);
            expect(round.currentBtcBlockTime).to.be.within(now - 5, now + 1);
            expect(round.anchorTipBlockTime).to.equal(null);
        });
    });
});
