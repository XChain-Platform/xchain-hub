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

// The two cadence knobs are fleet-uniform: an override is honoured on regtest only,
// where a hub resolving non-canonical values must say so unless the skip variable is
// set, and is set-but-IGNORED with a warning on every other network.

const { expect } = require('chai');
const sinon = require('sinon');
const logger = require('../../../src/observability').getLogger();
const { assertCanonicalCadence, resolveAnchorCheckpointEveryN, resolveCheckpointIntervalBlocks } =
    require('../../../src/anchor/checkpoint_cadence.js');
const StateAnchorPublisher = require('../../../src/anchor/publisher.js');

const StateCheckpointEngine = require('../../../src/anchor/checkpoint_engine.js');

const ENV = ['CHECKPOINT_INTERVAL_BLOCKS', 'ANCHOR_CHECKPOINT_EVERY_N', 'XCHAIN_HUB_SKIP_ANCHOR_CADENCE_ASSERT', 'HUB_NETWORK'];

// A hub on the given network with nothing else configured.
function makeHub(network) {
    return { network, db: { doQuery: async () => [] }, p2pConfig: {} };
}

describe('checkpoint cadence canonical assertion', function () {
    let saved = {};
    let warn;
    beforeEach(function () {
        for (let k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
        warn = sinon.stub(logger, 'warn');
    });
    afterEach(function () {
        sinon.restore();
        for (let k of ENV) { if (saved[k] !== undefined) process.env[k] = saved[k]; else delete process.env[k]; }
    });

    it('reports nothing for the canonical 6 / 1', function () {
        expect(assertCanonicalCadence(6, 1)).to.deep.equal([]);
        expect(warn.callCount).to.equal(0);
    });

    it('warns and names each drifting knob', function () {
        expect(assertCanonicalCadence(13, 1)).to.deep.equal(['CHECKPOINT_INTERVAL_BLOCKS']);
        expect(assertCanonicalCadence(6, 3)).to.deep.equal(['ANCHOR_CHECKPOINT_EVERY_N']);
        expect(assertCanonicalCadence(7, 2)).to.deep.equal(['CHECKPOINT_INTERVAL_BLOCKS', 'ANCHOR_CHECKPOINT_EVERY_N']);

        expect(warn.callCount).to.equal(3);
        expect(String(warn.getCall(0).args[0])).to.include('CHECKPOINT_INTERVAL_BLOCKS');
        expect(String(warn.getCall(0).args[0])).to.include('resolved 13 / 1');
        expect(String(warn.getCall(1).args[0])).to.include('ANCHOR_CHECKPOINT_EVERY_N');
        expect(String(warn.getCall(1).args[0])).to.include('resolved 6 / 3');
        expect(String(warn.getCall(2).args[0])).to.include('CHECKPOINT_INTERVAL_BLOCKS and ANCHOR_CHECKPOINT_EVERY_N');
        expect(String(warn.getCall(2).args[0])).to.include('resolved 7 / 2');
    });

    it('is silenced by XCHAIN_HUB_SKIP_ANCHOR_CADENCE_ASSERT=1', function () {
        process.env.XCHAIN_HUB_SKIP_ANCHOR_CADENCE_ASSERT = '1';
        expect(assertCanonicalCadence(12, 4)).to.deep.equal([]);
        expect(warn.callCount).to.equal(0);
    });

    it('the shared resolver still returns the operator value on regtest and never throws on drift', function () {
        process.env.HUB_NETWORK = 'regtest';
        process.env.CHECKPOINT_INTERVAL_BLOCKS = '12';
        process.env.ANCHOR_CHECKPOINT_EVERY_N = '2';
        expect(resolveCheckpointIntervalBlocks({})).to.equal(12);
        expect(resolveAnchorCheckpointEveryN({})).to.equal(2);
        expect(warn.callCount).to.equal(1);
        expect(String(warn.firstCall.args[0])).to.include('resolved 12 / 2');
    });

    it('checks the same sanitized values that the publisher uses', function () {
        process.env.CHECKPOINT_INTERVAL_BLOCKS = 'invalid';
        process.env.ANCHOR_CHECKPOINT_EVERY_N = '-4';
        const publisher = new StateAnchorPublisher({
            db: { doQuery: async () => [] },
            p2pConfig: {}
        });

        expect(publisher.checkpointIntervalBlocks).to.equal(6);
        expect(publisher.anchorEveryNCheckpoints).to.equal(1);
        expect(warn.args.map(args => String(args[0])).join('\n')).to.not.include('fleet-canonical cadence');
    });
});

// Save, clear and restore the cadence variables around each case, with the logger stubbed.
function cadenceSandbox() {
    let state = { warn: null, saved: {} };
    beforeEach(function () {
        for (let k of ENV) { state.saved[k] = process.env[k]; delete process.env[k]; }
        state.warn = sinon.stub(logger, 'warn');
    });
    afterEach(function () {
        sinon.restore();
        for (let k of ENV) { if (state.saved[k] !== undefined) process.env[k] = state.saved[k]; else delete process.env[k]; }
    });
    return state;
}

// Every network except regtest uses 6 / 1 whatever was set, from env or p2pConfig.
function registerPinCases(state) {
    for (let network of ['mainnet', 'testnet', '']) {
        it('pins both knobs to 6 / 1 and warns IGNORED on ' + (network || 'a standalone hub'), function () {
            process.env.HUB_NETWORK = network;
            process.env.CHECKPOINT_INTERVAL_BLOCKS = '12';
            process.env.ANCHOR_CHECKPOINT_EVERY_N = '4';
            expect(resolveCheckpointIntervalBlocks({})).to.equal(6);
            expect(resolveAnchorCheckpointEveryN({})).to.equal(1);
            let lines = state.warn.args.map(args => String(args[0])).join('\n');
            expect(lines).to.include('CHECKPOINT_INTERVAL_BLOCKS=12 is set but IGNORED');
            expect(lines).to.include('ANCHOR_CHECKPOINT_EVERY_N=4 is set but IGNORED');
            expect(lines).to.not.include('fleet-canonical cadence');
        });
    }

    it('pins a p2pConfig override off regtest the same way as an env one', function () {
        expect(resolveCheckpointIntervalBlocks({ CHECKPOINT_INTERVAL_BLOCKS: '12' }, 'mainnet')).to.equal(6);
        expect(resolveAnchorCheckpointEveryN({ ANCHOR_CHECKPOINT_EVERY_N: '4' }, 'testnet')).to.equal(1);
        expect(resolveCheckpointIntervalBlocks({ CHECKPOINT_INTERVAL_BLOCKS: '12' }, 'regtest')).to.equal(12);
    });

    it('stays silent off regtest when the set value is the canonical one', function () {
        process.env.HUB_NETWORK = 'mainnet';
        process.env.CHECKPOINT_INTERVAL_BLOCKS = '6';
        process.env.ANCHOR_CHECKPOINT_EVERY_N = '1';
        expect(resolveCheckpointIntervalBlocks({})).to.equal(6);
        expect(state.warn.callCount).to.equal(0);
    });

    it('does not let the skip variable lift the pin off regtest', function () {
        process.env.XCHAIN_HUB_SKIP_ANCHOR_CADENCE_ASSERT = '1';
        process.env.CHECKPOINT_INTERVAL_BLOCKS = '12';
        expect(resolveCheckpointIntervalBlocks({}, 'testnet')).to.equal(6);
    });
}

// Both readers pass their own network, so they resolve the same step on every network.
function registerReaderCases() {
    it('lets the caller network win over HUB_NETWORK, for the engine and the publisher alike', function () {
        process.env.HUB_NETWORK = 'regtest';
        process.env.CHECKPOINT_INTERVAL_BLOCKS = '12';
        process.env.ANCHOR_CHECKPOINT_EVERY_N = '4';
        let engine = new StateCheckpointEngine(makeHub('mainnet'));
        let publisher = new StateAnchorPublisher(makeHub('mainnet'));
        expect(engine.intervalBlocks).to.equal(6);
        expect(publisher.checkpointIntervalBlocks).to.equal(6);
        expect(publisher.anchorEveryNCheckpoints).to.equal(1);
        engine = new StateCheckpointEngine(makeHub('regtest'));
        publisher = new StateAnchorPublisher(makeHub('regtest'));
        expect(engine.intervalBlocks).to.equal(12);
        expect(publisher.checkpointIntervalBlocks).to.equal(12);
        expect(publisher.anchorEveryNCheckpoints).to.equal(4);
    });
}

describe('checkpoint cadence knobs off regtest', function () {
    let state = cadenceSandbox();
    registerPinCases(state);
    registerReaderCases();
});
