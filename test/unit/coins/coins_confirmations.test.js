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
const coins      = require('../../../src/coins');

const saved = {};

function registerConfirmationBaselineTests() {
    // / CF-1: on mainnet AND testnet an XCHAIN_CONFIRMATIONS_<COIN> override
    // may only raise the depth above the per-coin default, never lower it. A validator
    // running a lowered depth would co-sign source actions the rest of the
    // federation still considers reorg-able. testnet is inside the floor because it is
    // a multi-operator federation with an armed consensus pin, not a drill network;
    // regtest, the single-operator drill network, keeps the full override.
        it('defaults everywhere when no override is set', () => {
            for(const net of ['mainnet', 'testnet', 'regtest'])
                expect(coins.resolveConfirmations({}, net)).to.deep.equal(coins.DEFAULT_CONFIRMATIONS);
        });

        it('clamps an env override below the default up to the floor on mainnet', () => {
            process.env.XCHAIN_CONFIRMATIONS_BTC = '1';
            const out = coins.resolveConfirmations({}, 'mainnet');
            expect(out.BTC).to.equal(coins.DEFAULT_CONFIRMATIONS.BTC);
        });

        it('clamps a p2pConfig override below the default on mainnet', () => {
            const out = coins.resolveConfirmations({ XCHAIN_CONFIRMATIONS_DOGE: '2' }, 'mainnet');
            expect(out.DOGE).to.equal(coins.DEFAULT_CONFIRMATIONS.DOGE);
        });

        it('allows raising the depth above the default on mainnet', () => {
            process.env.XCHAIN_CONFIRMATIONS_BTC = String(coins.DEFAULT_CONFIRMATIONS.BTC + 4);
            const out = coins.resolveConfirmations({}, 'mainnet');
            expect(out.BTC).to.equal(coins.DEFAULT_CONFIRMATIONS.BTC + 4);
        });
}

function registerConfirmationFederationTests() {
        // Flipped from 'allows lowering the depth on testnet and regtest (drill seam)'.
        // The old case encoded the invariant this change removes: testnet is an
        // externally-operated federation with an armed pin, so a lowered depth diverges
        // co-signing there exactly as it would on mainnet. regtest stays the drill seam.
        it('clamps a lowered depth on testnet, honors it on regtest (drill seam)', () => {
            process.env.XCHAIN_CONFIRMATIONS_LTC = '1';
            expect(coins.resolveConfirmations({}, 'testnet').LTC).to.equal(coins.DEFAULT_CONFIRMATIONS.LTC);
            expect(coins.resolveConfirmations({}, 'regtest').LTC).to.equal(1);
        });

        it('clamps a p2pConfig override below the default on testnet', () => {
            const out = coins.resolveConfirmations({ XCHAIN_CONFIRMATIONS_DOGE: '2' }, 'testnet');
            expect(out.DOGE).to.equal(coins.DEFAULT_CONFIRMATIONS.DOGE);
        });

        // Raising is unilaterally conservative (the validator just waits longer), so the
        // floor must not take the safe direction away on a floored network.
        it('allows raising the depth above the default on testnet', () => {
            process.env.XCHAIN_CONFIRMATIONS_BTC = String(coins.DEFAULT_CONFIRMATIONS.BTC + 4);
            const out = coins.resolveConfirmations({}, 'testnet');
            expect(out.BTC).to.equal(coins.DEFAULT_CONFIRMATIONS.BTC + 4);
        });

        // The cross-service half of the same invariant: the hub's attest gate resolves
        // through this function while the BTC indexer's anchor-reward MINT gate is frozen
        // at the per-coin default (ANCHOR_REWARD_DOGE_MIN_CONFIRMATIONS). On the two
        // consensus-real networks the floor is what guarantees the hub can never attest an
        // anchor shallower than the fleet will ever mint.
        it('never resolves below the frozen anchor-reward mint depth on a floored network', () => {
            process.env.XCHAIN_CONFIRMATIONS_DOGE = '2';
            const mintDepth = require('../../../src/consensus/gates/anchor_reward_gate.js').ANCHOR_REWARD_DOGE_MIN_CONFIRMATIONS;
            expect(mintDepth).to.equal(coins.DEFAULT_CONFIRMATIONS.DOGE);
            for(const net of ['mainnet', 'testnet'])
                expect(coins.resolveConfirmations({}, net).DOGE, net).to.be.at.least(mintDepth);
        });

        it('env override takes precedence over p2pConfig', () => {
            process.env.XCHAIN_CONFIRMATIONS_BTC = '20';
            const out = coins.resolveConfirmations({ XCHAIN_CONFIRMATIONS_BTC: '30' }, 'regtest');
            expect(out.BTC).to.equal(20);
        });

        it('falls back to the default on a garbage or non-positive override', () => {
            process.env.XCHAIN_CONFIRMATIONS_BTC = 'banana';
            process.env.XCHAIN_CONFIRMATIONS_LTC = '-3';
            const out = coins.resolveConfirmations({}, 'regtest');
            expect(out.BTC).to.equal(coins.DEFAULT_CONFIRMATIONS.BTC);
            expect(out.LTC).to.equal(coins.DEFAULT_CONFIRMATIONS.LTC);
        });
}

function registerConfirmationTests() {
    describe('resolveConfirmations mainnet + testnet floor', () => {
        beforeEach(() => {
            for(const tick of coins.ALLOWED_COINS){
                const key = 'XCHAIN_CONFIRMATIONS_' + tick;
                saved[key] = process.env[key];
                delete process.env[key];
            }
        });
        afterEach(() => {
            for(const key of Object.keys(saved)){
                if(saved[key] === undefined) delete process.env[key];
                else process.env[key] = saved[key];
            }
        });
        registerConfirmationBaselineTests();
        registerConfirmationFederationTests();
    });
}

describe('coins registry', () => {
    registerConfirmationTests();
});
