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
const OracleConsensus = require('../../../../src/oracle/consensus');
const { nominalRoundSeconds } = require('../../../../src/oracle/consensus/round_time');
const { ROUND_TIME_GATE } = require('../../../../src/oracle/consensus/round_time_gate');
const { createMockHub } = require('../../../helpers/mockHub');
const { waitUntil } = require('../../../helpers/waitUntil');
const { VALIDATORS_3, buildSubmissions, makeCapabilitySnapshotStub } = require('../../../helpers/fixtures');
const { makeRoundTimeCapture } = require('./helpers/round_time_capture');

const ROUND = 81;
const HEIGHT = 900000;
const EPOCH_START_MS = 1700000000000;
const ROUND_INTERVAL_MS = 60000;
const NOMINAL_TIME = nominalRoundSeconds(ROUND, EPOCH_START_MS, ROUND_INTERVAL_MS);
const registryActiveAt = gateRegistry.activeAt;

let roundTimeGateEnabled = false;
let capture;
let consensus;
let sandbox;

function setupRoundTimeGate() {
    sandbox = sinon.createSandbox();
    sandbox.stub(gateRegistry, 'activeAt').callsFake((key, ...args) =>
        key === ROUND_TIME_GATE
            ? roundTimeGateEnabled
            : registryActiveAt.call(gateRegistry, key, ...args));
}

function stubRoundTimeGate(active) {
    roundTimeGateEnabled = active;
    return gateRegistry.activeAt;
}

function setCadence(capture) {
    capture.round.epochStart = EPOCH_START_MS;
    capture.round.roundInterval = ROUND_INTERVAL_MS;
}

function teardownRoundTimeGate() {
    if (capture) capture.restore();
    if (consensus) {
        for (const pending of consensus.pendingRounds.values()) {
            if (pending.timer) clearTimeout(pending.timer);
        }
        for (const timer of consensus.leaderTimers.values()) clearTimeout(timer);
        for (const entry of consensus.roundWatchdogs.values()) {
            if (entry.timer) clearTimeout(entry.timer);
        }
    }
    capture = null;
    consensus = null;
    roundTimeGateEnabled = false;
    sandbox.restore();
    sandbox = null;
}

describe('OracleRound nominal time finalization', function () {
    beforeEach(setupRoundTimeGate);
    afterEach(teardownRoundTimeGate);

    it('passes the nominal time to consensus when the pushed tip is 1h43m ahead', async function () {
        const activeAt = stubRoundTimeGate(true);
        capture = makeRoundTimeCapture({
            network: 'testnet',
            quorum: 2,
            height: HEIGHT,
            blockTime: NOMINAL_TIME + 60 * 103,
            fallbackActive: false
        });
        setCadence(capture);

        expect(await capture.finalize(ROUND)).to.deep.equal({
            kind: 'finalized',
            args: [ROUND, HEIGHT, NOMINAL_TIME]
        });
        expect(activeAt.calledWithExactly(ROUND_TIME_GATE, 'testnet', 'BTC', HEIGHT, null)).to.equal(true);
    });

    it('uses the nominal time for a federated wall-clock anchor skip', async function () {
        const wallClockTime = Math.floor(Date.now() / 1000);
        stubRoundTimeGate(true);
        capture = makeRoundTimeCapture({
            network: 'testnet',
            quorum: 2,
            height: ROUND,
            blockTime: wallClockTime,
            fallbackActive: true
        });
        setCadence(capture);

        expect(await capture.finalize(ROUND)).to.deep.equal({
            kind: 'skipped',
            args: [ROUND, ROUND, NOMINAL_TIME, 'round-number anchor on a federated hub']
        });
    });
});

describe('OracleRound nominal time lifecycle', function () {
    beforeEach(setupRoundTimeGate);
    afterEach(teardownRoundTimeGate);

    it('uses each in-flight round nominal time for shutdown skips', async function () {
        stubRoundTimeGate(true);
        capture = makeRoundTimeCapture({
            network: 'testnet',
            quorum: 2,
            height: HEIGHT,
            blockTime: Math.floor(Date.now() / 1000),
            fallbackActive: false
        });
        setCadence(capture);

        expect(await capture.stopInFlight([ROUND, ROUND + 1])).to.deep.equal([
            [ROUND, HEIGHT, NOMINAL_TIME, 'hub stopped before finalization'],
            [ROUND + 1, HEIGHT, NOMINAL_TIME + 60, 'hub stopped before finalization']
        ]);
    });

    it('preserves captured tip and wall-clock times below the gate', async function () {
        const pushedTipTime = NOMINAL_TIME + 60 * 103;
        const wallClockTime = Math.floor(Date.now() / 1000);
        stubRoundTimeGate(false);
        capture = makeRoundTimeCapture({
            network: 'mainnet',
            quorum: 2,
            height: HEIGHT,
            blockTime: pushedTipTime,
            fallbackActive: false
        });
        setCadence(capture);

        expect(await capture.finalize(ROUND)).to.deep.equal({
            kind: 'finalized', args: [ROUND, HEIGHT, pushedTipTime]
        });

        capture.round.currentBtcBlockHeight = ROUND + 1;
        capture.round.currentBtcBlockTime = wallClockTime;
        capture.round.chainTipFallbackActive = true;
        expect(await capture.finalize(ROUND + 1)).to.deep.equal({
            kind: 'skipped',
            args: [ROUND + 1, ROUND + 1, wallClockTime, 'round-number anchor on a federated hub']
        });
    });
});

describe('OracleConsensus nominal time default', function () {
    beforeEach(setupRoundTimeGate);
    afterEach(teardownRoundTimeGate);

    it('puts the nominal time in a PROPOSE when consensus receives no time', async function () {
        stubRoundTimeGate(true);
        const hub = createMockHub({ network: 'testnet' });
        hub.capabilitySnapshot = makeCapabilitySnapshotStub(VALIDATORS_3);
        hub._peerManager.validatorAddr = VALIDATORS_3[ROUND % VALIDATORS_3.length].addr;
        const submissions = buildSubmissions(VALIDATORS_3.slice(0, 2).map(validator => ({
            sender: validator.addr,
            prices: [{ coinPair: 'BTC/USD', price: '100000', sources: 2 }]
        })));
        const oracleRound = {
            epochStart: EPOCH_START_MS,
            roundInterval: ROUND_INTERVAL_MS,
            getSubmissions: sinon.stub().returns(submissions),
            priceFetcher: { multiSourceCapablePairs: () => new Set(['BTC/USD']) }
        };
        consensus = new OracleConsensus(hub, oracleRound);
        consensus.minSubmissions = 1;
        consensus.setValidatorSet(VALIDATORS_3);

        await consensus.finalizeRound(ROUND, 100);
        await waitUntil(() => hub._peerManager.broadcast.called,
            { label: 'the nominal-time proposal' });

        const proposal = hub._peerManager.broadcast.getCalls()
            .find(call => call.args[0] === 'ORACLE_PROPOSE');
        expect(proposal).to.not.equal(undefined);
        expect(proposal.args[1].btcBlockTime).to.equal(NOMINAL_TIME);
    });
});
