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

// A checkpoint signed fewer than 6 blocks below the tip can still be reorged away,
// so mainnet and testnet refuse a lower CHECKPOINT_CONFIRMATIONS at construction.
// Regtest keeps the shallow settings its venues rely on.

const { expect } = require('chai');
const StateCheckpointEngine = require('../../../../src/anchor/checkpoint_engine.js');

function makeHub(network, confirmations) {
    let p2pConfig = {};
    if (confirmations !== undefined) p2pConfig.CHECKPOINT_CONFIRMATIONS = confirmations;
    return { network, db: { doQuery: async () => [] }, p2pConfig };
}

describe('CHECKPOINT_CONFIRMATIONS live-network floor', function () {
    let saved;
    beforeEach(function () {
        saved = process.env.CHECKPOINT_CONFIRMATIONS;
        delete process.env.CHECKPOINT_CONFIRMATIONS;
    });
    afterEach(function () {
        if (saved !== undefined) process.env.CHECKPOINT_CONFIRMATIONS = saved;
        else delete process.env.CHECKPOINT_CONFIRMATIONS;
    });

    for (let network of ['mainnet', 'testnet']) {
        it('refuses 0 to 5 on ' + network, function () {
            for (let v of ['0', '1', '3', '5']) {
                expect(() => new StateCheckpointEngine(makeHub(network, v)), v)
                    .to.throw(/CHECKPOINT_CONFIRMATIONS=\d+ is below the minimum of 6/);
            }
        });

        it('refuses a shallow value supplied through the environment on ' + network, function () {
            process.env.CHECKPOINT_CONFIRMATIONS = '2';
            expect(() => new StateCheckpointEngine(makeHub(network))).to.throw(/below the minimum of 6/);
        });

        it('accepts 6 and deeper on ' + network, function () {
            expect(new StateCheckpointEngine(makeHub(network, '6')).confirmations).to.equal(6);
            expect(new StateCheckpointEngine(makeHub(network, '12')).confirmations).to.equal(12);
        });

        it('defaults to 6 on ' + network + ' and falls back to 6 on a malformed value', function () {
            expect(new StateCheckpointEngine(makeHub(network)).confirmations).to.equal(6);
            expect(new StateCheckpointEngine(makeHub(network, 'abc')).confirmations).to.equal(6);
            expect(new StateCheckpointEngine(makeHub(network, '-2')).confirmations).to.equal(6);
        });
    }

    it('lets regtest checkpoint the tip', function () {
        expect(new StateCheckpointEngine(makeHub('regtest', '0')).confirmations).to.equal(0);
        expect(new StateCheckpointEngine(makeHub('regtest', '3')).confirmations).to.equal(3);
    });
});
