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
// The hub network follows admission stamp requests without changing the stamp.

const { expect } = require('chai');
const proxyquire = require('proxyquire');
const sinon = require('sinon');

const ADMISSION_PATH = '../../../../src/lib/admission_height.js';
const CHAIN_TIPS_PATH = '../../../../src/hub/chain_tips.js';
const PRICE_AGGREGATOR_PATH = '../../../../src/oracle/price_aggregator.js';
const WATERMARK_PATH = '../../../../src/peers/hub_db/admission_height_watermark.js';
const MIRROR_GATE_PATH = '../../../../src/consensus/gates/mirror_admission_gate.js';

const admissionHeight = require(ADMISSION_PATH);
const ChainTips = require(CHAIN_TIPS_PATH);
const mirrorAdmissionGate = require(MIRROR_GATE_PATH);
const { AdmissionHeightWatermark } = require(WATERMARK_PATH);
const PriceAggregator = proxyquire(PRICE_AGGREGATOR_PATH, {
    '../consensus/gates/mirror_admission_gate.js': {
        ...mirrorAdmissionGate,
        isMirrorAdmissionProducerActive: () => true,
    },
});

const ENV_KEYS = ['HUB_NETWORK'];

// Build with the network absent from the environment, so config alone decides.
function withCleanEnv(fn) {
    const saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    try { return fn(); }
    finally { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

describe('admission height network threading', function () {

    afterEach(function () {
        sinon.restore();
    });

    it('keeps a normalized configured network on the watermark', function () {
        const watermark = withCleanEnv(() => new AdmissionHeightWatermark({ HUB_NETWORK: 'REGTEST' }));
        expect(watermark.network).to.equal('regtest');
    });

    it('keeps an empty network on an unconfigured watermark', function () {
        const watermark = withCleanEnv(() => new AdmissionHeightWatermark({}));
        expect(watermark.network).to.equal('');
    });

    it('passes the hub network through the chain tips admission seam', async function () {
        const admitBlocks = sinon.stub(admissionHeight, 'admitBlocks').returns({ DOGE: 110 });

        await ChainTips.prototype.resolveAdmitBlocks.call({
            network: 'regtest',
            resolveAdmissionTips: async () => ({ DOGE: 100 }),
        }, 'bridge_transfers', ['DOGE']);

        sinon.assert.calledOnceWithExactly(
            admitBlocks, ['DOGE'], { DOGE: 100 }, 'bridge_transfers', 'regtest');
    });

    it('passes the hub network through the oracle price admission seam', async function () {
        const admitBlocks = sinon.stub(admissionHeight, 'admitBlocks').returns({ DOGE: 110 });
        const aggregator = Object.create(PriceAggregator.prototype);
        aggregator.hub = { network: 'regtest', resolveAdmissionTip: async () => 100 };

        await aggregator.resolveOracleAdmitBlock('DOGE');

        sinon.assert.calledOnceWithExactly(
            admitBlocks, ['DOGE'], { DOGE: 100 }, 'oracle_prices', 'regtest');
    });
});
