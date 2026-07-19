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
//  wiring proof: the shared SpendGuard's per-capability runtime pause
// reaches an effector's PRIMARY (broadcast) path, not only its queue sweep, and
// each effector registers a $2000-clamped spend ceiling. Uses OraclePublisher as
// the representative effector (its _processQueue is the sole broadcast choke
// point, so a gated primary path is directly observable).

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');
const SpendGuard = require('../../src/lib/spend_guard.js');

function loadOraclePublisher(fsMock) {
    return proxyquire('../../src/OraclePublisher', {
        fs: fsMock,
        './EncoderClient': function () { return null; }
    });
}

function makeFsMock(queueLine) {
    return {
        mkdirSync:     sinon.stub(),
        existsSync:    sinon.stub().returns(true),
        writeFileSync: sinon.stub(),
        openSync:      sinon.stub().returns(99),
        writeSync:     sinon.stub(),
        fsyncSync:     sinon.stub(),
        closeSync:     sinon.stub(),
        readFileSync:  sinon.stub().returns(queueLine || '')
    };
}

function makeHub() {
    return {
        p2pConfig:          {},
        getIdentity:        sinon.stub().returns({ getPubkeyHex: sinon.stub().returns('aa'.repeat(32)), sign: sinon.stub().returns('bb'.repeat(64)) }),
        capabilityRegistry: null,
        capabilitySnapshot: null,
        oracleConsensus:    null
    };
}

describe(' SpendGuard wiring into hub effectors', function () {

    afterEach(function () { sinon.restore(); });

    it('registers a $2000-clamped SpendGuard under the effector label', function () {
        const OraclePublisher = loadOraclePublisher(makeFsMock());
        const pub = new OraclePublisher(makeHub());
        expect(pub.spendGuard).to.be.an.instanceof(SpendGuard);
        expect(pub.spendGuard.maxSpendUsdCents).to.equal(200000);
        expect(SpendGuard.get('OraclePublisher')).to.equal(pub.spendGuard);
    });

    it('a runtime pause halts the PRIMARY broadcast path (no on-chain spend while paused)', async function () {
        const entry = { round: 7, btcBlockTime: 1700000000, prices: [], sigs: [], attempts: 0 };
        const fsMock = makeFsMock(JSON.stringify(entry) + '\n');
        const OraclePublisher = loadOraclePublisher(fsMock);
        const pub = new OraclePublisher(makeHub());
        const broadcastStub = sinon.stub().resolves({ txid: 'tx-7' });
        pub.broadcastFn  = broadcastStub;
        pub.getBalanceFn = sinon.stub().resolves(50);   // well above the floor

        // Paused: the broadcast choke point must skip, spending nothing.
        pub.spendGuard.pause('incident');
        await pub._processQueue();
        expect(broadcastStub.called, 'paused effector must not broadcast').to.be.false;

        // Resumed: the same queued round now publishes exactly once.
        pub.spendGuard.resume();
        await pub._processQueue();
        expect(broadcastStub.calledOnce, 'resumed effector broadcasts the queued round').to.be.true;
    });

    it('pausing by capability label via the registry gates the same instance', async function () {
        const entry = { round: 8, btcBlockTime: 0, prices: [], sigs: [], attempts: 0 };
        const fsMock = makeFsMock(JSON.stringify(entry) + '\n');
        const OraclePublisher = loadOraclePublisher(fsMock);
        const pub = new OraclePublisher(makeHub());
        const broadcastStub = sinon.stub().resolves({ txid: 'tx-8' });
        pub.broadcastFn  = broadcastStub;
        pub.getBalanceFn = sinon.stub().resolves(50);

        expect(SpendGuard.pauseCapability('OraclePublisher', 'ops')).to.equal(true);
        await pub._processQueue();
        expect(broadcastStub.called).to.be.false;
        SpendGuard.resumeCapability('OraclePublisher');
    });
});
