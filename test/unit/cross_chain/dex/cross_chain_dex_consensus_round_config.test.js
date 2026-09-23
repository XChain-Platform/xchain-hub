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

// The XDEX round timeout and max lifetime, resolved by the engine and by the mirror
// admission watermark. The watermark's xdex trail is the engine's terminal bound, so
// both must resolve the same value from the same sources in the same order.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');

const CrossChainDexConsensus = require('../../../../src/cross_chain/dex_consensus.js');
const { AdmissionHeightWatermark } = require('../../../../src/peers/hub_db/admission_height_watermark.js');
const { DEFAULT_XDEX_ROUND_TIMEOUT_MS } = require('../../../../src/constants.js');

const ENV_KEYS = ['XDEX_ROUND_TIMEOUT_MS', 'XDEX_ROUND_MAX_LIFETIME_MS'];

// Run fn with exactly `env` set for the two round knobs, restoring the caller's values.
function withEnv(env, fn) {
    const saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    Object.assign(process.env, env || {});
    try { return fn(); }
    finally { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

function makeConsensus(p2pConfig) {
    return new CrossChainDexConsensus({ hub: { p2pConfig: p2pConfig || {} }, peerManager: null, identity: null });
}

function registerSourceOrderTests() {
    it('lands on the shared default with nothing configured', function () {
        let c = withEnv({}, () => makeConsensus());
        expect(c.roundTimeoutMs).to.equal(DEFAULT_XDEX_ROUND_TIMEOUT_MS);
        expect(c.roundMaxLifetimeMs).to.equal(DEFAULT_XDEX_ROUND_TIMEOUT_MS * 4);
    });

    it('honours the environment, which p2pConfig never carries on a real hub', function () {
        let c = withEnv({ XDEX_ROUND_TIMEOUT_MS: '30000' }, () => makeConsensus());
        expect(c.roundTimeoutMs).to.equal(30000);
        expect(c.roundMaxLifetimeMs).to.equal(120000);
    });

    it('lets the environment win over a different p2pConfig value for both knobs', function () {
        let c = withEnv({ XDEX_ROUND_TIMEOUT_MS: '5000', XDEX_ROUND_MAX_LIFETIME_MS: '20000' },
            () => makeConsensus({ XDEX_ROUND_TIMEOUT_MS: 90000, XDEX_ROUND_MAX_LIFETIME_MS: 900000 }));
        expect(c.roundTimeoutMs).to.equal(5000);
        expect(c.roundMaxLifetimeMs).to.equal(20000);
    });

    it('still honours p2pConfig when the environment is unset', function () {
        let c = withEnv({}, () => makeConsensus({ XDEX_ROUND_TIMEOUT_MS: 90000, XDEX_ROUND_MAX_LIFETIME_MS: 900000 }));
        expect(c.roundTimeoutMs).to.equal(90000);
        expect(c.roundMaxLifetimeMs).to.equal(900000);
    });
}

function registerRejectionTests() {
    it('falls back to the default on a negative timeout instead of accepting it', function () {
        let fromP2p = withEnv({}, () => makeConsensus({ XDEX_ROUND_TIMEOUT_MS: '-1' }));
        expect(fromP2p.roundTimeoutMs).to.equal(DEFAULT_XDEX_ROUND_TIMEOUT_MS);
        expect(fromP2p.roundMaxLifetimeMs).to.equal(DEFAULT_XDEX_ROUND_TIMEOUT_MS * 4);
        let fromEnv = withEnv({ XDEX_ROUND_TIMEOUT_MS: '-1' }, () => makeConsensus());
        expect(fromEnv.roundTimeoutMs).to.equal(DEFAULT_XDEX_ROUND_TIMEOUT_MS);
    });

    it('falls back to the derived lifetime on a negative p2pConfig lifetime', function () {
        let c = withEnv({}, () => makeConsensus({ XDEX_ROUND_TIMEOUT_MS: 10000, XDEX_ROUND_MAX_LIFETIME_MS: -5 }));
        expect(c.roundMaxLifetimeMs).to.equal(40000);
    });

    it('follows a retuned shared default rather than a local copy of it', function () {
        const Stubbed = proxyquire('../../../../src/cross_chain/dex_consensus.js', {
            '../constants.js': { DEFAULT_XDEX_ROUND_TIMEOUT_MS: 77777 },
        });
        let c = withEnv({}, () => new Stubbed({ hub: { p2pConfig: {} }, peerManager: null, identity: null }));
        expect(c.roundTimeoutMs).to.equal(77777);
    });
}

function registerWatermarkAgreementTests() {
    it('sizes the watermark xdex trail to the engine lifetime for an env-only timeout', function () {
        let both = withEnv({ XDEX_ROUND_TIMEOUT_MS: '30000' },
            () => ({ engine: makeConsensus(), watermark: new AdmissionHeightWatermark({}) }));
        expect(both.watermark.roundWindows.xdex).to.equal(both.engine.roundMaxLifetimeMs);
        expect(both.engine.roundMaxLifetimeMs).to.equal(120000);
    });

    it('agrees with the watermark when env and p2pConfig disagree', function () {
        const p2p = { XDEX_ROUND_TIMEOUT_MS: 90000, XDEX_ROUND_MAX_LIFETIME_MS: 900000 };
        let both = withEnv({ XDEX_ROUND_TIMEOUT_MS: '5000', XDEX_ROUND_MAX_LIFETIME_MS: '20000' },
            () => ({ engine: makeConsensus(p2p), watermark: new AdmissionHeightWatermark(p2p) }));
        expect(both.watermark.roundWindows.xdex).to.equal(both.engine.roundMaxLifetimeMs);
    });
}

describe('CrossChainDexConsensus round timeout and lifetime config', function () {
    beforeEach(function () { sinon.stub(console, 'warn'); });
    afterEach(function () { sinon.restore(); });

    registerSourceOrderTests();
    registerRejectionTests();
    registerWatermarkAgreementTests();
});
