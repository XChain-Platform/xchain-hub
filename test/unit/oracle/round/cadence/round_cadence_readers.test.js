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

// Every round interval reader resolves through the shared cadence resolver. The
// resolver is stubbed with a sentinel no config or default could produce, so a
// reader that still reads its own config or constant cannot pass.

const { expect } = require('chai');
const proxyquire = require('proxyquire').noPreserveCache();
const { resolveRoundCadence, resetRoundCadence } = require('../../../../../src/oracle/round_cadence.js');

const SENTINEL = 7777777;
const RC_STUB = { resolveRoundCadence: () => ({ roundInterval: SENTINEL, submissionWindow: 1 }) };

describe('oracle round cadence readers', function () {
    this.timeout(20000);
    beforeEach(resetRoundCadence);
    afterEach(resetRoundCadence);

    it('admission watermark price window comes from the resolver', function () {
        const { AdmissionHeightWatermark } = proxyquire('../../../../../src/peers/hub_db/admission_height_watermark.js',
            { '../../oracle/round_cadence.js': RC_STUB });
        const w = new AdmissionHeightWatermark({ ORACLE_ROUND_INTERVAL: 5 });
        expect(w.roundTerminalMs('price_snapshots')).to.equal(SENTINEL);
    });

    it('batch signer consults the resolver with its own config', function () {
        const seen = [];
        const Signer = proxyquire('../../../../../src/oracle/batch_signer.js', {
            './round_cadence.js': { resolveRoundCadence: (cfg) => { seen.push(cfg); return RC_STUB.resolveRoundCadence(cfg); } }
        });
        const cfg = { ORACLE_ROUND_INTERVAL: 5 };
        new Signer({ network: 'regtest', p2pConfig: cfg });
        expect(seen).to.have.length.greaterThan(0);
        expect(seen[0]).to.equal(cfg);
    });

    it('publisher batch options take the interval from the resolver', function () {
        const opts = proxyquire('../../../../../src/oracle/publisher/batch_options.js',
            { '../round_cadence.js': RC_STUB });
        const target = Object.assign({ network: 'regtest' }, opts);
        target.initBatchWindow({ ORACLE_ROUND_INTERVAL: 5 });
        expect(target.roundIntervalMs).to.equal(SENTINEL);
    });

    it('chain tip freshness bound reads the resolver, not p2pConfig', function () {
        const ChainTips = proxyquire('../../../../../src/hub/chain_tips.js',
            { '../oracle/round_cadence.js': RC_STUB });
        const prev = process.env.MAX_TIP_AGE_S;
        delete process.env.MAX_TIP_AGE_S;
        try {
            // 10000s old: inside 2x the sentinel interval, far outside 2x the 600s default.
            const tip = { blockHeight: 1, blockTime: Math.floor(Date.now() / 1000) - 10000 };
            const hub = Object.assign(Object.create(ChainTips.prototype), { p2pConfig: { ORACLE_ROUND_INTERVAL: 5 } });
            expect(ChainTips.prototype.btcPushedTipFresh.call(hub, tip)).to.equal(true);
        } finally { if (prev !== undefined) process.env.MAX_TIP_AGE_S = prev; }
    });

    it('is uniform: a later reader with a different config gets the first resolution', function () {
        const first = resolveRoundCadence({ ORACLE_ROUND_INTERVAL: 1000 });
        const later = resolveRoundCadence({ ORACLE_ROUND_INTERVAL: 2000 });
        expect(first.roundInterval).to.equal(1000);
        expect(later).to.equal(first);
    });
});
