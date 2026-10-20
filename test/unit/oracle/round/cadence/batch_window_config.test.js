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

// The batch signer refuses proposals by its window plan and the publisher proposes
// by its own, so both must come from the one resolver or they can drift apart.

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noPreserveCache();
const { resetRoundCadence } = require('../../../../../src/oracle/round_cadence.js');
const OracleBatchSigner = require('../../../../../src/oracle/batch_signer.js');
const batchOptions = require('../../../../../src/oracle/publisher/batch_options.js');
const { resolveBatchWindow } = require('../../../../../src/oracle/batch_window_config.js');

const SENTINEL_PLAN = { sentinel: true };
const SENTINEL_STUB = {
    resolveBatchWindow: () => ({
        roundIntervalMs: 1000, graceMs: 1, landingReserveMs: 0, maxPriceAgeMs: 1,
        ceiling: null, satisfiable: true, requestedRounds: 1, smallRounds: 1,
        hourly: { plan: SENTINEL_PLAN, firstRound: undefined, largeRounds: 6 }
    })
};

// A bare publisher half: the batch-options mixin on a target holding a hub.
function publisherWindow(options, network, cfg) {
    const target = Object.assign({ network, hub: { oracleConsensus: {} } }, options);
    target.initBatchWindow(cfg);
    return target;
}

describe('oracle batch window config', function () {
    this.timeout(20000);
    beforeEach(function () {
        resetRoundCadence();
        sinon.stub(console, 'warn');
    });
    afterEach(function () {
        sinon.restore();
        resetRoundCadence();
    });

    it('builds the signer and the publisher window plan from the one resolver', function () {
        const Signer = proxyquire('../../../../../src/oracle/batch_signer.js',
            { './batch_window_config.js': SENTINEL_STUB });
        const options = proxyquire('../../../../../src/oracle/publisher/batch_options.js',
            { '../batch_window_config.js': SENTINEL_STUB });
        const signer = new Signer({ network: 'regtest', p2pConfig: {} });
        expect(signer.windowPlan).to.equal(SENTINEL_PLAN);
        expect(publisherWindow(options, 'regtest', {}).windowPlan).to.equal(SENTINEL_PLAN);
    });

    it('gives the signer and the publisher the same boundaries across the testnet hourly switch', function () {
        const cfg = { ORACLE_BATCH_WINDOW_ROUNDS: '99', ORACLE_BATCH_LANDING_RESERVE_MS: 'bad' };
        const signer = new OracleBatchSigner({ network: 'testnet', p2pConfig: cfg, oracleConsensus: {} });
        const publisher = publisherWindow(batchOptions, 'testnet', cfg);
        const switchRound = publisher.hourlyWindowFirstRound;
        expect(switchRound).to.be.a('number');
        const switchWindow = publisher.windowPlan.windowOf(switchRound);
        for (let w = switchWindow - 3; w <= switchWindow + 3; w++) {
            expect(signer.windowPlan.rangeOf(w), 'window ' + w).to.deep.equal(publisher.windowPlan.rangeOf(w));
        }
        expect(signer.windowPlan.straddles(switchRound - 1, switchRound)).to.equal(true);
        expect(publisher.windowPlan.straddles(switchRound - 1, switchRound)).to.equal(true);
    });

    it('clamps an over-ceiling window and falls back on a bad landing reserve', function () {
        const w = resolveBatchWindow({
            network: 'testnet',
            cfg: { ORACLE_BATCH_WINDOW_ROUNDS: '99', ORACLE_BATCH_LANDING_RESERVE_MS: '-5' },
            enabled: true,
            roundIntervalMs: 600000
        });
        expect(w.ceiling).to.be.a('number');
        expect(w.requestedRounds).to.equal(99);
        expect(w.smallRounds).to.equal(w.ceiling);
        expect(console.warn.args.join('\n')).to.match(/ORACLE_BATCH_LANDING_RESERVE_MS="-5" is not a non-negative integer/);
    });
});
