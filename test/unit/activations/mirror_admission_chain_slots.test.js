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

const { expect } = require('chai');
const gate = require('../../../src/consensus/gates/mirror_admission_gate');

const MATRICES = [
    [gate.MIRROR_ADMISSION_ACTIVATION, gate.isMirrorAdmissionProducerActive],
    [gate.MIRROR_ADMISSION_CONSUMER_ACTIVATION, gate.isMirrorAdmissionConsumerActive],
];

describe('mirror_admission_activation: chain-scoped slots', function () {
    it('keeps null and far-future LTC and DOGE slots inactive while BTC is armed', function () {
        for (const [activation, active] of MATRICES) {
            const btcArmedHeight = activation['BTC:testnet'];
            expect(active('BTC', 'testnet', btcArmedHeight)).to.equal(true);

            for (const coin of ['LTC', 'DOGE']) {
                expect(activation[coin + ':mainnet']).to.equal(null);
                expect(active(coin, 'mainnet', Number.MAX_SAFE_INTEGER)).to.equal(false);
                expect(activation[coin + ':testnet']).to.be.above(btcArmedHeight);
                expect(active(coin, 'testnet', btcArmedHeight)).to.equal(false);
            }
        }
    });
});
